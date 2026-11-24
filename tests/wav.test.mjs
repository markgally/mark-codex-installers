import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const frontend = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const appConfig = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const helperInfo = await readFile(new URL("../src-tauri/wake-helper/Info.plist", import.meta.url), "utf8");
const backend = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const claudeCode = await readFile(new URL("../src-tauri/src/claude_code.rs", import.meta.url), "utf8");
const wakeHelper = await readFile(
  new URL("../src-tauri/wake-helper/JarvisWakeListener.swift", import.meta.url),
  "utf8",
);

test("Voice uses Codex app-server V3 WebRTC directly", () => {
  assert.match(backend, /"version":\s*"v3"/);
  assert.match(backend, /"transport":\s*\{"type":\s*"webrtc"/);
  assert.match(backend, /"app-server",\s*"--enable",\s*"realtime_conversation",\s*"--stdio"/);
  const voiceControls = frontend.match(/<footer\b[\s\S]*?<\/footer>/)?.[0];
  assert.ok(voiceControls);
  assert.doesNotMatch(voiceControls, /ChatGPT.*button/i);
  assert.doesNotMatch(frontend, /hotkey/i);
});

test("wake phrase opens the same direct Voice path", () => {
  assert.match(frontend, /listen<WakeEvent>\("jarvis-wake"/);
  assert.match(frontend, /void startDirectVoice\(\{ coldStart: payload\.cold === true \}\)/);
  assert.match(frontend, /const attempts = coldStart \? 6 : 1/);
  assert.match(frontend, /requestAnimationFrame\(\(\) => requestAnimationFrame/);
  assert.match(frontend, /recoverableColdStartError/);
  assert.match(backend, /Command::new\("powershell.exe"\)/);
  assert.match(backend, /stop_wake_process/);
  assert.match(backend, /state.wake_ready.store\(true/);
  assert.match(frontend, /request_microphone_permission/);
  assert.match(backend, /tauri::WindowEvent::CloseRequested/);
  assert.match(backend, /request_application_exit/);
});

test("STOP suppresses transcript-tail handoffs and interrupts late turns", () => {
  assert.match(backend, /"flushTranscriptTailOnSessionEnd":\s*false/);
  assert.match(backend, /for _ in 0\.\.6/);
  assert.match(backend, /"turn\/interrupt"/);
});

test("text input can join the active Voice conversation", () => {
  assert.match(frontend, /append_codex_voice_text/);
  assert.match(backend, /"thread\/realtime\/appendText"/);
});

test("production configuration persists workspace and resumes threads", () => {
  assert.match(frontend, /jarvis\.workspace/);
  assert.match(frontend, /jarvis\.threadId:/);
  assert.match(backend, /"thread\/resume"/);
  assert.match(backend, /validated_workspace/);
  assert.match(wakeHelper, /requiresOnDeviceRecognition = true/);
});

test("user can create a fresh Codex thread without deleting history", () => {
  assert.match(frontend, /id="new-thread"/);
  assert.match(frontend, /threadId:\s*null/);
  assert.match(frontend, /invoke<Session>\("start_jarvis"/);
  assert.match(frontend, /freshSession\.threadId/);
  assert.match(frontend, /The previous thread remains in Codex history/);
});

test("permission profiles are persisted and mapped by the trusted backend", () => {
  assert.match(frontend, /jarvis\.permissionMode/);
  assert.match(frontend, /type PermissionMode = "safe" \| "auto" \| "full"/);
  assert.match(frontend, /permissionMode,/);
  assert.match(backend, /enum PermissionMode/);
  assert.match(backend, /approval_policy: "on-request"/);
  assert.match(backend, /approval_policy: "never"/);
  assert.match(backend, /sandbox: "workspace-write"/);
  assert.match(backend, /sandbox: "danger-full-access"/);
  assert.match(backend, /existing\.permission_mode == permission_mode/);
});

test("settings persist and pass provider-specific models and voices", () => {
  for (const id of ["codex-model", "codex-voice", "api-text-model", "api-voice-model", "api-voice"]) {
    assert.match(frontend, new RegExp(`id="${id}"`));
  }
  for (const key of ["jarvis.codexModel", "jarvis.codexVoice", "jarvis.apiTextModel", "jarvis.apiVoiceModel", "jarvis.apiVoice"]) {
    assert.match(frontend, new RegExp(key.replaceAll(".", "\\.")));
  }
  assert.match(frontend, /start_openai_realtime", \{ sdp, model: apiVoiceModel, voice: apiVoice \}/);
  assert.match(frontend, /send_openai_text", \{ text, model: apiTextModel \}/);
  assert.match(frontend, /voice: codexVoice/);
  assert.match(backend, /thread_options\["model"\]/);
  assert.match(backend, /"model":model,"input":text/);
  assert.match(backend, /"model":model,"instructions":instructions,"audio":\{"output":\{"voice":voice\}\}/);
});

test("Claude shares text and voice conversation while wake and sleep remain local", () => {
  assert.match(frontend, /value="claude"/);
  assert.match(frontend, /id="claude-model"/);
  assert.match(frontend, /id="claude-voice"/);
  assert.match(frontend, /send_claude_text/);
  assert.match(frontend, /transcribe_claude_audio/);
  assert.match(frontend, /speak_claude_text/);
  assert.match(frontend, /claudeVoiceActive\) await sleepVoice/);
  assert.match(frontend, /voiceIdle\.start\(\)/);
  assert.match(backend, /https:\/\/api\.anthropic\.com\/v1\/messages/);
  assert.match(backend, /https:\/\/api\.openai\.com\/v1\/audio\/transcriptions/);
  assert.match(backend, /https:\/\/api\.openai\.com\/v1\/audio\/speech/);
  assert.match(backend, /claude_history: Mutex<Vec<Value>>/);
  assert.match(backend, /reset_claude_conversation/);
  assert.match(backend, /claude_epoch\.fetch_add\(1, Ordering::SeqCst\)/);
  assert.doesNotMatch(frontend, /localStorage\.setItem\([^\n]*ANTHROPIC_API_KEY/);
});

test("Claude Agent uses a signed-in resumable CLI session with bounded permissions", () => {
  assert.match(frontend, /value="claude-code"/);
  assert.match(frontend, /send_claude_code/);
  assert.match(frontend, /jarvis\.claudeCodeSession:/);
  assert.match(frontend, /jarvis\.claudeCodeSessionName:/);
  assert.match(frontend, /sessionAssistantContext = assistantContext\(\)/);
  assert.match(frontend, /CLAUDE_CODE_SESSION_NAME_PREFIX\}\$\{workspace\}`\) === assistantContext\(\)/);
  assert.match(frontend, /provider === "claude-code"\s*\? await sendClaudeCodeTurn\(text\)/);
  assert.match(backend, /async fn send_claude_code/);
  assert.match(backend, /permission,\s*&assistant_name\(&state\),\s*&assistant_instructions\(&state\),\s*session_id\.as_deref\(\)/);
  assert.match(claudeCode, /format!\("You are \{assistant_name\}/);
  assert.doesNotMatch(claudeCode, /"--append-system-prompt", "You are Mark\./);
  assert.match(claudeCode, /"--output-format",\s*"stream-json"/);
  assert.match(claudeCode, /"--resume"/);
  assert.match(claudeCode, /"--restricted",\s*"--permission-mode",\s*"plan"/);
  assert.match(claudeCode, /"--restricted",\s*"--permission-mode",\s*"acceptEdits"/);
  assert.match(claudeCode, /"full" => args\.extend\(\["--permission-mode",\s*"bypassPermissions"\]/);
  assert.match(claudeCode, /"--permission-prompts",\s*"none"/);
  assert.match(claudeCode, /"auth", "status", "--json"/);
  assert.match(claudeCode, /"ANTHROPIC_API_KEY",\s*"ANTHROPIC_AUTH_TOKEN"/);
  assert.doesNotMatch(claudeCode, /command\.env\("ANTHROPIC_API_KEY"/);
  assert.match(backend, /claude_code_authenticated: cli\.authenticated/);
  assert.match(frontend, /keys\.claudeCodeAuthenticated/);
  assert.match(frontend, /PERMISSION_KEY = "jarvis\.permissionMode"/);
  assert.match(frontend, /localStorage\.setItem\(PERMISSION_KEY, permissionMode\)/);
  assert.match(frontend, /permissionMode, requestId/);
  assert.doesNotMatch(frontend, /CLAUDE_AGENT_PERMISSION_KEY|claudeAgentPermissionMode/);
});

test("Codex model choices refresh from the app-server catalog", () => {
  assert.match(frontend, /invoke<string\[\]>\("list_codex_models"\)/);
  assert.match(frontend, /gpt-6-sol/);
  assert.match(frontend, /gpt-5\.5/);
  assert.match(backend, /runtime\.request\("model\/list"/);
  assert.match(backend, /fn codex_model_ids/);
  assert.doesNotMatch(backend, /const CODEX_MODELS:/);
});

test("English is the default throughout the app and wake listener", () => {
  assert.match(html, /<html lang="en">/);
  assert.match(wakeHelper, /Locale\(identifier: "en-US"\)/);
  assert.ok(wakeHelper.includes('"hey\\($0)"'));
  assert.match(backend, /"instructions":instructions/);
  assert.match(backend, /"baseInstructions": format!/);
  for (const source of [html, frontend, backend, wakeHelper]) {
    assert.doesNotMatch(source, /[\u3400-\u9fff]/u);
  }
});

test("Mark Codex branding preserves the existing app identity and settings", () => {
  assert.equal(appConfig.productName, "Mark Codex");
  assert.equal(appConfig.identifier, "com.bigguan.jarvis-codex");
  assert.equal(appConfig.app.windows[0].title, "MARK · CODEX");
  assert.match(html, /<title>MARK · CODEX<\/title>/);
  assert.match(frontend, /Allow Mark Codex to use the microphone/);
  assert.match(backend, /"title": "Mark Codex"/);
  assert.match(helperInfo, /<string>Mark Wake Listener<\/string>/);
  assert.match(frontend, /jarvis\.threadId:/);
});

test("assistant name is saved and used across wake, voice, text, and Codex", () => {
  assert.match(frontend, /id="assistant-name-setting"/);
  assert.match(frontend, /get_assistant_profile/);
  assert.match(frontend, /set_assistant_profile/);
  assert.match(backend, /const DEFAULT_ASSISTANT_NAME: &str = "Mark"/);
  assert.match(backend, /assistant-name\.txt/);
  assert.match(backend, /\.arg\("-AssistantName"\)/);
  assert.match(wakeHelper, /CommandLine\.arguments\.firstIndex\(of: "--assistant-name"\)/);
  assert.match(backend, /name = assistant_name\(state\)/);
  assert.match(backend, /"developerInstructions": runtime\.assistant_profile\.instructions\(\)/);
  assert.match(backend, /runtime\.memory\.initial_items\(runtime\.assistant_profile\.clone\(\)\)/);
  assert.match(backend, /let instructions = assistant_instructions\(&state\)/);
});

test("automatic sleep closes voice and re-arms the local wake listener", () => {
  assert.match(frontend, /const VOICE_IDLE_MS = 60_000/);
  assert.match(frontend, /voiceIdle\.start\(\)/);
  assert.match(frontend, /input_audio_buffer\.speech_started/);
  assert.match(frontend, /response\.done/);
  assert.match(frontend, /state\.agentWorking \|\| apiSpeechActive \|\| apiResponseActive/);
  assert.match(frontend, /async function sleepVoice/);
  assert.match(frontend, /await stopDirectVoice\(\)/);
  assert.match(frontend, /await armWakeListener\(\)/);
  assert.match(frontend, /void sleepVoice\("manual"\)/);
});

test("wake raises and focuses the MARK window", () => {
  assert.match(backend, /fn raise_jarvis_window/);
  assert.match(backend, /set_always_on_top\(true\)/);
  assert.match(backend, /set_always_on_top\(compact\)/);
  assert.match(backend, /WindowState>\(\)\.is_compact\(\)/);
  assert.match(backend, /raise_jarvis_window\(&app\)/);
});
