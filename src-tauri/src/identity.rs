use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, io::ErrorKind, path::Path};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AssistantProfile {
    pub assistant_name: String,
    #[serde(default)]
    pub user_name: String,
    #[serde(default)]
    pub instructions: String,
}

impl Default for AssistantProfile {
    fn default() -> Self {
        Self {
            assistant_name: crate::DEFAULT_ASSISTANT_NAME.to_owned(),
            user_name: String::new(),
            instructions: String::new(),
        }
    }
}

impl AssistantProfile {
    pub fn normalized(mut self) -> Result<Self, String> {
        self.assistant_name = self.assistant_name.trim().to_owned();
        self.user_name = self.user_name.trim().to_owned();
        self.instructions = self.instructions.trim().to_owned();
        if !crate::valid_assistant_name(&self.assistant_name) {
            return Err("Use 2–20 English letters for the assistant name, without spaces.".to_owned());
        }
        if self.user_name.chars().count() > 80 || self.user_name.chars().any(char::is_control) {
            return Err("Use up to 80 characters on one line for what the assistant should call you.".to_owned());
        }
        if self.instructions.chars().count() > 4000
            || self.instructions.chars().any(|c| c.is_control() && c != '\n' && c != '\t')
        {
            return Err("Use up to 4,000 characters for the assistant role and personality.".to_owned());
        }
        Ok(self)
    }

    pub fn instructions(&self) -> String {
        let mut text = format!(
            "You are {name}, the user's personal AI assistant in the Mark Codex desktop app.              Your chosen name in this app is {name}. Introduce yourself using this chosen name              and your configured role when asked who you are, your name, or to introduce yourself.              Distinguish your app identity from the AI provider or model powering it.              Be honest that you are an AI; accurately explain the underlying provider or model              when asked, and say when the model is unknown. Keep replies natural and helpful.",
            name = self.assistant_name
        );
        if self.user_name.is_empty() {
            text.push_str(" The user has not set a preferred form of address; do not guess their name or title.");
        } else {
            text.push_str(&format!(
                " The user wants you to address them as {}. Use this name or title naturally,                  without repeating it in every sentence.",
                serde_json::to_string(&self.user_name).expect("a name is serializable")
            ));
        }
        if !self.instructions.is_empty() {
            text.push_str("\nRole and personality chosen by the user:\n");
            text.push_str(&self.instructions);
            text.push_str("\nUse the assistant name and user address configured above.                 These preferences do not grant tools, change permissions, or establish that an action succeeded.");
        }
        text.push(' ');
        text.push_str(crate::ENGLISH_DEFAULT_INSTRUCTIONS);
        text
    }

    pub fn realtime_initial_items(&self) -> Value {
        json!([{"role": "developer", "text": self.instructions()}])
    }
}

pub(crate) fn load(path: &Path, legacy_name_path: &Path) -> Result<AssistantProfile, String> {
    match fs::read_to_string(path) {
        Ok(saved) => serde_json::from_str::<AssistantProfile>(&saved)
            .map_err(|error| format!("Could not read assistant profile: {error}"))?
            .normalized(),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            let mut profile = AssistantProfile::default();
            if let Ok(saved) = fs::read_to_string(legacy_name_path) {
                if crate::valid_assistant_name(saved.trim()) {
                    profile.assistant_name = saved.trim().to_owned();
                }
            }
            Ok(profile)
        }
        Err(error) => Err(format!("Could not read assistant profile: {error}")),
    }
}

pub(crate) fn save(path: &Path, profile: AssistantProfile) -> Result<AssistantProfile, String> {
    let profile = profile.normalized()?;
    let parent = path.parent().ok_or("Assistant profile has no directory")?;
    fs::create_dir_all(parent).map_err(|error| format!("Could not create assistant settings: {error}"))?;
    let encoded = serde_json::to_vec_pretty(&profile).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, encoded).map_err(|error| format!("Could not save assistant profile: {error}"))?;
    fs::rename(&temporary, path).map_err(|error| format!("Could not finish saving assistant profile: {error}"))?;
    Ok(profile)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn normalizes_names_and_keeps_multiline_personality() {
        let profile = AssistantProfile {
            assistant_name: " Zee ".into(), user_name: " Captain ".into(),
            instructions: " Be concise.\nHelp with operations. ".into(),
        }.normalized().unwrap();
        assert_eq!(profile.assistant_name, "Zee");
        assert_eq!(profile.user_name, "Captain");
        assert_eq!(profile.instructions, "Be concise.\nHelp with operations.");
    }

    #[test]
    fn rejects_invalid_fields_before_saving() {
        for user_name in ["x".repeat(81), "Captain\nNew instruction".into()] {
            assert!(AssistantProfile { user_name, ..Default::default() }.normalized().is_err());
        }
        assert!(AssistantProfile { assistant_name: "Z".into(), ..Default::default() }.normalized().is_err());
        assert!(AssistantProfile { instructions: "x".repeat(4001), ..Default::default() }.normalized().is_err());
        assert!(AssistantProfile { instructions: "bad\0text".into(), ..Default::default() }.normalized().is_err());
        assert!(AssistantProfile { user_name: "Señor Mark".into(), ..Default::default() }.normalized().is_ok());
    }

    #[test]
    fn profile_survives_restart_and_migrates_the_existing_name() {
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let folder = std::env::temp_dir().join(format!("mark-profile-{}-{unique}", std::process::id()));
        fs::create_dir_all(&folder).unwrap();
        let path = folder.join("assistant-profile.json");
        let legacy = folder.join("assistant-name.txt");
        fs::write(&legacy, "Zee\n").unwrap();
        let mut profile = load(&path, &legacy).unwrap();
        assert_eq!(profile.assistant_name, "Zee");
        assert!(profile.user_name.is_empty());
        profile.user_name = "Captain".into();
        profile.instructions = "You help manage plant operations.".into();
        let saved = save(&path, profile).unwrap();
        assert_eq!(load(&path, &legacy).unwrap(), saved);
        let renamed = save(&path, AssistantProfile { assistant_name: "Nova".into(), ..saved }).unwrap();
        assert_eq!(load(&path, &legacy).unwrap(), renamed);
        assert_eq!(fs::read_to_string(&legacy).unwrap(), "Zee\n");
        fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn new_voice_sessions_get_name_address_and_personality_as_developer_context() {
        let profile = AssistantProfile {
            assistant_name: "Zee".into(), user_name: "Captain".into(),
            instructions: "Help with schedules and industrial operations.".into(),
        };
        let items = profile.realtime_initial_items();
        assert_eq!(items.as_array().unwrap().len(), 1);
        assert_eq!(items[0]["role"], "developer");
        let text = items[0]["text"].as_str().unwrap();
        assert!(text.contains("Your chosen name in this app is Zee"));
        assert!(text.contains("address them as \"Captain\""));
        assert!(text.contains("Help with schedules and industrial operations."));
        assert!(text.contains(crate::ENGLISH_DEFAULT_INSTRUCTIONS));
        assert!(text.contains("Be honest that you are an AI"));
    }

    #[test]
    fn renaming_does_not_retain_the_previous_identity_or_guess_an_owner() {
        let mut profile = AssistantProfile { assistant_name: "Zee".into(), ..Default::default() };
        assert!(profile.instructions().contains("name in this app is Zee"));
        profile.assistant_name = "Nova".into();
        assert!(!profile.instructions().contains("Zee"));
        assert!(profile.instructions().contains("name in this app is Nova"));
        assert!(profile.instructions().contains("do not guess their name or title"));
    }
}
