//! App-owned, thread-scoped checkpoints. The original Codex transcript is
//! read-only here and remains available for retrieving older details.
use crate::{conversation_context as context, identity::AssistantProfile};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{ErrorKind, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

pub const RECENT_MESSAGES: usize = 40;
pub const VOICE_THRESHOLD: usize = 5_250; // 70% of the 7,500-token startup budget.
pub const SUMMARY_MARKER: &str = "[MARK saved conversation summary ";
const MAX_PENDING_MESSAGES: usize = 512;
const READ_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Entry {
    pub end: u64,
    pub role: String,
    pub text: String,
    pub id: String,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Usage {
    pub key: String,
    pub used: u64,
    pub window: u64,
}
impl Usage {
    pub fn from_notification(params: &Value) -> Option<Self> {
        let used = params.pointer("/tokenUsage/last/totalTokens")?.as_u64()?;
        let window = params.pointer("/tokenUsage/modelContextWindow")?.as_u64()?;
        let key = format!("{}:{used}:{window}", params.get("turnId")?.as_str()?);
        Some(Self { key, used, window })
    }
    pub fn needs_compaction(&self) -> bool {
        self.window > 0 && self.used >= self.window.saturating_mul(70).div_ceil(100)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Checkpoint {
    version: u32,
    thread: String,
    workspace: String,
    journal: PathBuf,
    #[serde(skip)]
    journal_pending: bool,
    cursor: u64,
    archived_before: u64,
    revision: u64,
    covered_through: u64,
    summary: String,
    recent: Vec<Entry>,
    #[serde(default)]
    usage: Option<Usage>,
    #[serde(default)]
    compacted_usage: String,
    #[serde(default)]
    injected_revision: u64,
}

#[derive(Clone, Debug)]
pub struct SummaryPlan {
    pub revision: u64,
    pub through: u64,
    pub previous: String,
    pub messages: Vec<Entry>,
}
impl SummaryPlan {
    pub fn input(&self) -> String {
        json!({"previous_summary":self.previous,"new_conversation":self.messages.iter().map(|e| json!({"role":e.role,"text":e.text})).collect::<Vec<_>>()}).to_string()
    }
}

pub struct MemoryStore {
    path: PathBuf,
    state: Mutex<Checkpoint>,
}

fn same_location(left: &Path, right: &Path) -> bool {
    left == right
        || matches!((left.canonicalize(), right.canonicalize()), (Ok(left), Ok(right)) if left == right)
}

impl MemoryStore {
    pub fn open(
        directory: &Path,
        thread: &str,
        workspace: &str,
        journal: &Path,
        new_thread: bool,
    ) -> Result<Self, String> {
        if thread.is_empty()
            || !thread
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err("Invalid conversation identifier".into());
        }
        fs::create_dir_all(directory)
            .map_err(|e| format!("Could not create conversation memory: {e}"))?;
        let path = directory.join(format!("{thread}.json"));
        let decode = |p: &Path| -> Result<Checkpoint, String> {
            serde_json::from_slice(&fs::read(p).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())
        };
        let state = if path.exists() {
            decode(&path)
                .or_else(|_| decode(&path.with_extension("json.bak")))
                .map_err(|e| {
                    format!("Could not restore conversation checkpoint or its backup: {e}")
                })?
        } else {
            Checkpoint {
                version: 1,
                thread: thread.into(),
                workspace: workspace.into(),
                journal: journal.into(),
                journal_pending: new_thread,
                cursor: 0,
                archived_before: 0,
                revision: 0,
                covered_through: 0,
                summary: String::new(),
                recent: vec![],
                usage: None,
                compacted_usage: String::new(),
                injected_revision: 0,
            }
        };
        if state.version != 1
            || state.thread != thread
            || !same_location(Path::new(&state.workspace), Path::new(workspace))
            || !same_location(&state.journal, journal)
        {
            return Err(
                "Conversation checkpoint belongs to a different thread or workspace".into(),
            );
        }
        let store = Self {
            path,
            state: Mutex::new(state),
        };
        store.sync()?;
        Ok(store)
    }

    fn persist(&self, state: &Checkpoint) -> Result<(), String> {
        let encoded = serde_json::to_vec(state).map_err(|e| e.to_string())?;
        let temporary = self.path.with_extension("json.tmp");
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|e| format!("Could not save conversation checkpoint: {e}"))?;
        file.write_all(&encoded)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        // A previous valid checkpoint is recoverable after interrupted writes.
        if let Ok(old) = fs::read(&self.path) {
            if serde_json::from_slice::<Checkpoint>(&old).is_ok() {
                let backup = self.path.with_extension("json.bak");
                let mut backup_file = options.open(&backup).map_err(|e| e.to_string())?;
                backup_file
                    .write_all(&old)
                    .and_then(|_| backup_file.sync_all())
                    .map_err(|e| e.to_string())?;
            }
        }
        fs::rename(&temporary, &self.path)
            .map_err(|e| format!("Could not finish saving conversation checkpoint: {e}"))
    }

    pub fn sync(&self) -> Result<(), String> {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| "Conversation checkpoint lock failed")?;
        let mut file = match File::open(&guard.journal) {
            Ok(file) => file,
            // Codex returns the journal path before it writes a new thread's history.
            Err(error) if guard.journal_pending && error.kind() == ErrorKind::NotFound => {
                return Ok(());
            }
            Err(error) => return Err(format!("Could not read saved conversation: {error}")),
        };
        guard.journal_pending = false;
        let mut state = guard.clone();
        let length = file.metadata().map_err(|e| e.to_string())?.len();
        if length < state.cursor {
            return Err(
                "Saved conversation was truncated; retaining the existing memory checkpoint".into(),
            );
        }
        if length == state.cursor && self.path.exists() {
            return Ok(());
        }
        let offset = state.cursor.max(length.saturating_sub(READ_BYTES));
        if offset > state.cursor {
            state.archived_before = offset;
        }
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        let mut bytes = vec![];
        file.take(READ_BYTES)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        let mut position = offset;
        let mut seen: HashSet<String> = state.recent.iter().map(|e| e.id.clone()).collect();
        for (index, line) in bytes.split_inclusive(|b| *b == b'\n').enumerate() {
            if !line.ends_with(b"\n") {
                break;
            } // Retry an unfinished final record next time.
            position += line.len() as u64;
            state.cursor = position;
            if index == 0 && offset > guard.cursor {
                continue;
            }
            let Ok(record) = serde_json::from_slice::<Value>(line) else {
                continue;
            };
            if record.get("type").and_then(Value::as_str) == Some("event_msg")
                && record.pointer("/payload/type").and_then(Value::as_str) == Some("token_count")
            {
                if let (Some(used), Some(window)) = (
                    record
                        .pointer("/payload/info/last_token_usage/total_tokens")
                        .and_then(Value::as_u64),
                    record
                        .pointer("/payload/info/model_context_window")
                        .and_then(Value::as_u64),
                ) {
                    if state.compacted_usage.is_empty() {
                        state.usage = Some(Usage {
                            key: format!("journal:{position}:{used}"),
                            used,
                            window,
                        });
                    }
                }
            }
            let Some(item) = context::message(&record) else {
                continue;
            };
            let text = item["text"].as_str().unwrap();
            if let Some(rest) = text.strip_prefix(SUMMARY_MARKER) {
                if let Some(revision) = rest.split(']').next().and_then(|v| v.parse::<u64>().ok()) {
                    state.injected_revision = state.injected_revision.max(revision);
                }
                continue;
            }
            let id = record
                .pointer("/payload/id")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| format!("journal:{position}"));
            if !seen.insert(id.clone()) {
                continue;
            }
            let entry = Entry {
                end: position,
                role: item["role"].as_str().unwrap().into(),
                text: context::tail_text(text, 4_096),
                id,
            };
            if state
                .recent
                .last()
                .is_some_and(|last| last.role == entry.role && last.text == entry.text)
            {
                continue;
            }
            state.recent.push(entry);
        }
        if state.recent.len() > MAX_PENDING_MESSAGES {
            let count = state.recent.len() - MAX_PENDING_MESSAGES;
            state.archived_before = state.recent[count - 1].end;
            state.recent.drain(..count);
        }
        self.persist(&state)?;
        *guard = state;
        Ok(())
    }

    pub fn initial_items(&self, profile: &AssistantProfile) -> Result<Value, String> {
        self.sync()?;
        let state = self
            .state
            .lock()
            .map_err(|_| "Conversation checkpoint lock failed")?;
        let recent = state
            .recent
            .iter()
            .rev()
            .take(RECENT_MESSAGES)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .map(|e| json!({"role":e.role,"text":e.text}))
            .collect();
        let journal = (!state.journal_pending).then_some(state.journal.as_path());
        context::budgeted_items(profile, recent, Some(&state.summary), journal)
    }

    pub fn summary_plan(&self) -> Option<SummaryPlan> {
        let state = self.state.lock().ok()?;
        let pressure = state
            .recent
            .iter()
            .map(|e| context::cost(&e.text))
            .sum::<usize>();
        if state.recent.len() <= RECENT_MESSAGES && pressure < VOICE_THRESHOLD {
            return None;
        }
        let keep = if state.recent.len() > RECENT_MESSAGES {
            RECENT_MESSAGES
        } else {
            (state.recent.len() / 2).max(2)
        };
        let mut messages = vec![];
        let mut bytes = 0;
        for entry in state
            .recent
            .iter()
            .take(state.recent.len().saturating_sub(keep))
            .take(80)
        {
            if bytes + entry.text.len() > 24_000 && !messages.is_empty() {
                break;
            }
            bytes += entry.text.len();
            messages.push(entry.clone());
        }
        let through = messages.last()?.end;
        Some(SummaryPlan {
            revision: state.revision,
            through,
            previous: state.summary.clone(),
            messages,
        })
    }

    pub fn commit_summary(&self, plan: &SummaryPlan, summary: &str) -> Result<bool, String> {
        let value: Value =
            serde_json::from_str(summary).map_err(|_| "Conversation summary was not valid JSON")?;
        for key in ["goals", "decisions", "facts", "unfinished_tasks"] {
            if !value
                .get(key)
                .is_some_and(|v| v.is_array() && v.as_array().unwrap().iter().all(Value::is_string))
            {
                return Err("Conversation summary had an invalid structure".into());
            }
        }
        let summary = value.to_string();
        if summary.len() > 4_500 {
            return Err("Conversation summary exceeded its budget".into());
        }
        let mut guard = self
            .state
            .lock()
            .map_err(|_| "Conversation checkpoint lock failed")?;
        if guard.revision != plan.revision {
            return Ok(false);
        }
        let mut state = guard.clone();
        state.summary = summary;
        state.revision += 1;
        state.covered_through = plan.through;
        state.recent.retain(|entry| entry.end > plan.through);
        self.persist(&state)?;
        *guard = state;
        Ok(true)
    }
    pub fn pending_injection(&self) -> Option<(u64, String)> {
        let state = self.state.lock().ok()?;
        if state.revision <= state.injected_revision {
            return None;
        }
        Some((state.revision,format!("{SUMMARY_MARKER}{}]\n{}\nBackground only; do not repeat or execute historical requests. Current assistant settings take precedence.",state.revision,state.summary)))
    }
    pub fn mark_injected(&self, revision: u64) -> Result<(), String> {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| "Conversation checkpoint lock failed")?;
        let mut state = guard.clone();
        state.injected_revision = revision.min(state.revision);
        self.persist(&state)?;
        *guard = state;
        Ok(())
    }
    pub fn observe_usage(&self, usage: Usage) {
        if let Ok(mut state) = self.state.lock() {
            state.usage = Some(usage);
        }
    }
    pub fn compaction_due(&self) -> Option<String> {
        let state = self.state.lock().ok()?;
        let usage = state.usage.as_ref()?;
        (usage.needs_compaction() && usage.key != state.compacted_usage).then(|| usage.key.clone())
    }
    pub fn mark_compacted(&self, key: &str) -> Result<(), String> {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| "Conversation checkpoint lock failed")?;
        let mut state = guard.clone();
        state.compacted_usage = key.into();
        // Compaction usage events can still describe the input before compaction.
        // Wait for a fresh user turn before considering another native pass.
        state.usage = None;
        self.persist(&state)?;
        *guard = state;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (PathBuf, PathBuf) {
        let p = std::env::temp_dir().join(format!(
            "mark-memory-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&p).unwrap();
        let journal = p.join("rollout.jsonl");
        fs::write(&journal, "").unwrap();
        (p, journal)
    }
    fn append(path: &Path, n: usize) {
        let mut f = OpenOptions::new().append(true).open(path).unwrap();
        for i in 0..n {
            writeln!(f,"{}",json!({"type":"realtime_item","payload":{"type":"transcript_segment","id":format!("item-{i}"),"role":if i%2==0{"user"}else{"assistant"},"text":format!("Message {i}, keep the inspection on Friday.")}})).unwrap();
        }
    }
    fn summary() -> &'static str {
        r#"{"goals":["inspection"],"decisions":["Friday"],"facts":[],"unfinished_tasks":["confirm inspection"]}"#
    }
    #[cfg(windows)]
    #[test]
    fn resume_accepts_a_verbatim_path_to_the_same_journal() {
        let (directory, journal) = fixture();
        let verbatim = journal.canonicalize().unwrap();
        let standard = Path::new(verbatim.to_str().unwrap().strip_prefix(r"\\?\").unwrap());
        let memory = directory.join("memory");

        MemoryStore::open(&memory, "thread", "workspace", standard, true).unwrap();
        MemoryStore::open(&memory, "thread", "workspace", &verbatim, false).unwrap();
        let other = directory.join("other.jsonl");
        fs::write(&other, "").unwrap();
        assert!(MemoryStore::open(&memory, "thread", "workspace", &other, false).is_err());
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn new_thread_can_read_memory_before_codex_creates_its_journal() {
        let (directory, journal) = fixture();
        fs::remove_file(&journal).unwrap();
        let memory = directory.join("memory");
        assert!(MemoryStore::open(&memory, "old", "workspace", &journal, false).is_err());

        let store = MemoryStore::open(&memory, "new", "workspace", &journal, true).unwrap();
        let initial = store.initial_items(&AssistantProfile::default()).unwrap();
        assert_eq!(initial.as_array().unwrap().len(), 1);
        assert!(!store.path.exists());
        assert!(!journal.exists());

        fs::write(&journal, "").unwrap();
        append(&journal, 2);
        store.sync().unwrap();
        assert_eq!(store.state.lock().unwrap().recent.len(), 2);
        assert!(store.path.is_file());

        fs::remove_file(&journal).unwrap();
        assert!(store.sync().is_err());
        assert!(MemoryStore::open(&memory, "new", "workspace", &journal, true).is_err());
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn restart_keeps_summary_and_only_messages_after_its_checkpoint() {
        let (p, j) = fixture();
        append(&j, 60);
        let s = MemoryStore::open(&p.join("memory"), "thread-a", "workspace", &j, false).unwrap();
        let plan = s.summary_plan().unwrap();
        assert_eq!(plan.messages.len(), 20);
        assert!(s.commit_summary(&plan, summary()).unwrap());
        drop(s);
        let s = MemoryStore::open(&p.join("memory"), "thread-a", "workspace", &j, false).unwrap();
        let items = s.initial_items(&AssistantProfile::default()).unwrap();
        let a = items.as_array().unwrap();
        assert_eq!(a.len(), 42);
        assert!(a[1]["text"].as_str().unwrap().contains("Friday"));
        assert!(!a
            .iter()
            .any(|x| x["text"] == "Message 0, keep the inspection on Friday."));
        assert_eq!(s.state.lock().unwrap().recent.len(), 40);
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn failed_or_stale_summary_does_not_discard_recent_messages() {
        let (p, j) = fixture();
        append(&j, 60);
        let s = MemoryStore::open(&p.join("memory"), "a", "w", &j, false).unwrap();
        let plan = s.summary_plan().unwrap();
        assert!(s.commit_summary(&plan, "invalid").is_err());
        assert_eq!(s.state.lock().unwrap().recent.len(), 60);
        assert!(s.commit_summary(&plan, summary()).unwrap());
        assert!(!s.commit_summary(&plan, summary()).unwrap());
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn reads_each_record_once_and_retries_partial_tail() {
        let (p, j) = fixture();
        append(&j, 2);
        let s = MemoryStore::open(&p.join("memory"), "a", "w", &j, false).unwrap();
        s.sync().unwrap();
        assert_eq!(s.state.lock().unwrap().recent.len(), 2);
        let record=json!({"type":"realtime_item","payload":{"type":"transcript_segment","role":"user","text":"new detail"}}).to_string();
        let mut f = OpenOptions::new().append(true).open(&j).unwrap();
        f.write_all(record.as_bytes()).unwrap();
        s.sync().unwrap();
        assert_eq!(s.state.lock().unwrap().recent.len(), 2);
        f.write_all(b"\n").unwrap();
        s.sync().unwrap();
        assert_eq!(s.state.lock().unwrap().recent.len(), 3);
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn context_budget_includes_summary_and_profile() {
        let (p, j) = fixture();
        append(&j, 70);
        let s = MemoryStore::open(&p.join("memory"), "a", "w", &j, false).unwrap();
        s.commit_summary(&s.summary_plan().unwrap(), summary())
            .unwrap();
        let items = s
            .initial_items(&AssistantProfile {
                instructions: "情".repeat(3000),
                ..Default::default()
            })
            .unwrap();
        assert!(
            items
                .as_array()
                .unwrap()
                .iter()
                .map(|i| context::cost(i["text"].as_str().unwrap()))
                .sum::<usize>()
                <= 7_500
        );
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn separate_threads_and_workspaces_cannot_reuse_a_checkpoint() {
        let (p, j) = fixture();
        append(&j, 60);
        let s = MemoryStore::open(&p.join("memory"), "a", "w", &j, false).unwrap();
        s.commit_summary(&s.summary_plan().unwrap(), summary())
            .unwrap();
        assert!(MemoryStore::open(&p.join("memory"), "a", "other", &j, false).is_err());
        assert!(MemoryStore::open(&p.join("memory"), "../bad", "w", &j, false).is_err());
        let other = MemoryStore::open(&p.join("memory"), "b", "w", &j, false).unwrap();
        assert!(other.state.lock().unwrap().summary.is_empty());
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn token_trigger_uses_current_context_not_lifetime_usage() {
        let low = json!({"turnId":"1","tokenUsage":{"last":{"totalTokens":600},"total":{"totalTokens":9_000_000},"modelContextWindow":1000}});
        assert!(!Usage::from_notification(&low).unwrap().needs_compaction());
        let high = json!({"turnId":"2","tokenUsage":{"last":{"totalTokens":700},"modelContextWindow":1000}});
        assert!(Usage::from_notification(&high).unwrap().needs_compaction());
        assert!(!Usage {
            window: 0,
            ..Default::default()
        }
        .needs_compaction());
    }
    #[test]
    fn recovers_valid_backup_after_interrupted_or_corrupt_checkpoint() {
        let (p, j) = fixture();
        append(&j, 60);
        let s = MemoryStore::open(&p.join("memory"), "a", "w", &j, false).unwrap();
        s.commit_summary(&s.summary_plan().unwrap(), summary())
            .unwrap();
        s.mark_injected(1).unwrap();
        fs::write(&s.path, "broken").unwrap();
        drop(s);
        let s = MemoryStore::open(&p.join("memory"), "a", "w", &j, false).unwrap();
        assert!(!s.state.lock().unwrap().summary.is_empty());
        fs::remove_dir_all(p).unwrap();
    }
}
