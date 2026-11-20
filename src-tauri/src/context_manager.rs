use super::CodexRuntime;
use crate::{
    memory_store::{MemoryStore, Usage},
    summary_rpc,
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::{
    sync::{oneshot, watch, Mutex, MutexGuard, RwLock},
    time::{timeout, Duration, Instant},
};

pub struct ContextManager {
    directory: PathBuf,
    binary: PathBuf,
    store: RwLock<Option<Arc<MemoryStore>>>,
    gate: Mutex<()>,
    cancel: watch::Sender<u64>,
    pub stopping: AtomicBool,
    compacting: AtomicBool,
    completion: Mutex<Option<oneshot::Sender<Result<(), String>>>>,
    hidden_turns: Mutex<HashSet<String>>,
}
impl ContextManager {
    pub fn new(directory: PathBuf, binary: PathBuf) -> Self {
        let (cancel, _) = watch::channel(0);
        Self {
            directory,
            binary,
            store: RwLock::new(None),
            gate: Mutex::new(()),
            cancel,
            stopping: AtomicBool::new(false),
            compacting: AtomicBool::new(false),
            completion: Mutex::new(None),
            hidden_turns: Mutex::new(HashSet::new()),
        }
    }
    pub async fn configure(
        &self,
        thread: &str,
        workspace: &str,
        journal: &Path,
    ) -> Result<(), String> {
        let (directory, thread, workspace, journal) = (
            self.directory.clone(),
            thread.to_owned(),
            workspace.to_owned(),
            journal.to_owned(),
        );
        let store = tokio::task::spawn_blocking(move || {
            MemoryStore::open(&directory, &thread, &workspace, &journal)
        })
        .await
        .map_err(|e| e.to_string())??;
        *self.store.write().await = Some(Arc::new(store));
        Ok(())
    }
    pub fn cancel(&self) {
        self.cancel
            .send_modify(|epoch| *epoch = epoch.wrapping_add(1));
    }
    pub async fn user_gate(&self) -> MutexGuard<'_, ()> {
        self.cancel();
        self.gate.lock().await
    }
    pub async fn initial_items(
        &self,
        profile: crate::identity::AssistantProfile,
    ) -> Result<Value, String> {
        let store = self
            .store
            .read()
            .await
            .clone()
            .ok_or("Conversation memory is not ready")?;
        tokio::task::spawn_blocking(move || store.initial_items(&profile))
            .await
            .map_err(|e| e.to_string())?
    }
    /// Observe only this runtime's thread. Maintenance events stay out of the
    /// foreground conversation and cannot animate or speak as ordinary work.
    pub async fn observe(&self, event: &Value) -> bool {
        let method = event.get("method").and_then(Value::as_str).unwrap_or("");
        let params = event.get("params").unwrap_or(&Value::Null);
        let turn = params
            .get("turnId")
            .and_then(Value::as_str)
            .or_else(|| params.pointer("/turn/id").and_then(Value::as_str));
        let compacting = self.compacting.load(Ordering::SeqCst);
        if compacting && method == "turn/started" {
            if let Some(turn) = turn {
                let mut turns = self.hidden_turns.lock().await;
                if turns.len() > 32 {
                    turns.clear();
                }
                turns.insert(turn.into());
            }
        }
        let hidden = compacting
            || if let Some(turn) = turn {
                self.hidden_turns.lock().await.contains(turn)
            } else {
                false
            };
        if method == "thread/tokenUsage/updated" && !hidden {
            if let (Some(store), Some(usage)) = (
                self.store.read().await.clone(),
                Usage::from_notification(params),
            ) {
                store.observe_usage(usage);
            }
        }
        // The compaction item can finish before its enclosing turn. Keep the
        // gate until turn/completed so new input cannot join the old turn.
        if compacting && method == "turn/completed" {
            let result = if method == "turn/completed"
                && params.pointer("/turn/status").and_then(Value::as_str) != Some("completed")
            {
                Err("Automatic compaction was interrupted or failed".into())
            } else {
                Ok(())
            };
            if let Some(sender) = self.completion.lock().await.take() {
                let _ = sender.send(result);
            }
        }
        hidden && (method.starts_with("turn/") || method.starts_with("item/") || method == "error")
    }
}

pub fn idle_for_maintenance(voice: bool, active_turn: bool, phase: &str, stopping: bool) -> bool {
    !voice && !active_turn && !stopping && matches!(phase, "standby" | "closed")
}

pub fn start(runtime: &Arc<CodexRuntime>) {
    let weak = Arc::downgrade(runtime);
    tauri::async_runtime::spawn(async move {
        let mut retry_after = Instant::now();
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let Some(runtime) = weak.upgrade() else {
                return;
            };
            if runtime.memory.stopping.load(Ordering::SeqCst) {
                return;
            }
            if Instant::now() < retry_after {
                continue;
            }
            let mut cancelled = runtime.memory.cancel.subscribe();
            let Ok(_gate) = runtime.memory.gate.try_lock() else {
                continue;
            };
            if !idle_for_maintenance(
                runtime.voice_active.load(Ordering::SeqCst),
                runtime.active_turn.read().await.is_some(),
                &runtime.voice_phase.read().await,
                runtime.memory.stopping.load(Ordering::SeqCst),
            ) {
                continue;
            }
            let outcome = tokio::select! {
                result=maintain(&runtime)=>Some(result),
                _=cancelled.changed()=>None,
            };
            if !matches!(outcome.as_ref(), Some(Ok(())))
                && runtime.memory.compacting.load(Ordering::SeqCst)
            {
                // New speech/work takes priority. Interrupt only our known
                // maintenance turn, never a user turn.
                let active_turn = { runtime.active_turn.read().await.clone() };
                if let Some(turn) = active_turn {
                    if runtime.memory.hidden_turns.lock().await.contains(&turn) {
                        let _=timeout(Duration::from_secs(3),runtime.request("turn/interrupt",json!({"threadId":runtime.thread().await.unwrap_or_default(),"turnId":turn}))).await;
                        for _ in 0..20 {
                            if runtime.active_turn.read().await.is_none() {
                                break;
                            }
                            tokio::time::sleep(Duration::from_millis(100)).await;
                        }
                    }
                }
            }
            runtime.memory.compacting.store(false, Ordering::SeqCst);
            runtime.memory.completion.lock().await.take();
            match outcome {
                Some(Err(error)) => {
                    eprintln!("Conversation maintenance deferred: {error}");
                    retry_after = Instant::now() + Duration::from_secs(60);
                }
                Some(Ok(())) => {}
                None => {
                    retry_after = Instant::now() + Duration::from_secs(5);
                }
            }
        }
    });
}

async fn maintain(runtime: &Arc<CodexRuntime>) -> Result<(), String> {
    let store = runtime
        .memory
        .store
        .read()
        .await
        .clone()
        .ok_or("Conversation memory is not ready")?;
    let copy = store.clone();
    let plan = tokio::task::spawn_blocking(move || {
        copy.sync()?;
        Ok::<_, String>(copy.summary_plan())
    })
    .await
    .map_err(|e| e.to_string())??;
    if let Some(plan) = plan {
        let workspace = runtime.memory.directory.join("summary-worker");
        std::fs::create_dir_all(&workspace).map_err(|e| e.to_string())?;
        let summary = summary_rpc::summarize(
            &runtime.memory.binary,
            &workspace,
            runtime.model.as_deref(),
            &plan,
        )
        .await?;
        if store.commit_summary(&plan, &summary)? {
            eprintln!(
                "Conversation summary checkpoint saved (revision {}, {} archived messages)",
                plan.revision + 1,
                plan.messages.len()
            );
        }
    }
    let thread = runtime.thread().await?;
    // Publish one background summary to the backing Codex thread as history.
    // It does not begin a turn or replay historical user requests.
    if let Some((revision, text)) = store.pending_injection() {
        runtime.request("thread/inject_items",json!({"threadId":thread,"items":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":text}]}]})).await?;
        store.mark_injected(revision)?;
    }
    if let Some(key) = store.compaction_due() {
        let (sender, receiver) = oneshot::channel();
        *runtime.memory.completion.lock().await = Some(sender);
        runtime.memory.compacting.store(true, Ordering::SeqCst);
        let result = timeout(Duration::from_secs(90), async {
            runtime
                .request("thread/compact/start", json!({"threadId":thread}))
                .await?;
            receiver
                .await
                .map_err(|_| "Automatic compaction completion was lost".to_owned())?
        })
        .await
        .map_err(|_| "Automatic compaction timed out; retaining saved memory".to_owned())?;
        result?;
        store.mark_compacted(&key)?;
        eprintln!("Automatic conversation compaction completed at the 70 percent threshold");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn does_not_release_the_user_gate_until_the_compaction_turn_finishes() {
        let manager = ContextManager::new(PathBuf::new(), PathBuf::new());
        let (sender, mut receiver) = oneshot::channel();
        *manager.completion.lock().await = Some(sender);
        manager.compacting.store(true, Ordering::SeqCst);
        manager.observe(&json!({"method":"item/completed","params":{"turnId":"maintenance","item":{"type":"contextCompaction"}}})).await;
        assert!(matches!(
            receiver.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        manager.observe(&json!({"method":"turn/completed","params":{"turn":{"id":"maintenance","status":"completed"}}})).await;
        assert!(receiver.await.unwrap().is_ok());
    }
    #[test]
    fn never_compacts_while_speaking_working_connecting_or_stopping() {
        for phase in ["standby", "closed"] {
            assert!(idle_for_maintenance(false, false, phase, false));
            assert!(!idle_for_maintenance(true, false, phase, false));
            assert!(!idle_for_maintenance(false, true, phase, false));
            assert!(!idle_for_maintenance(false, false, phase, true));
        }
        for phase in ["starting", "connected", "stopping", "error"] {
            assert!(!idle_for_maintenance(false, false, phase, false));
        }
    }
    #[tokio::test]
    async fn maintenance_events_are_hidden_but_foreground_events_remain_visible() {
        let manager = ContextManager::new(PathBuf::new(), PathBuf::new());
        let start = json!({"method":"turn/started","params":{"turn":{"id":"maintenance"}}});
        assert!(!manager.observe(&start).await);
        manager.compacting.store(true, Ordering::SeqCst);
        assert!(manager.observe(&start).await);
        manager.compacting.store(false, Ordering::SeqCst);
        assert!(manager.observe(&json!({"method":"turn/completed","params":{"turn":{"id":"maintenance","status":"completed"}}})).await);
        assert!(
            !manager
                .observe(&json!({"method":"turn/started","params":{"turn":{"id":"user-turn"}}}))
                .await
        );
    }
}
