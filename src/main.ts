import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { VoiceIdleTimer } from "./voice-idle";
import {
  applyAvatar,
  avatarSettingsFromForm,
  bindEyeTracking,
  cancelAssembly,
  readAvatarSettings,
  replayAssembly,
  syncAvatarForm,
  writeAvatarSettings,
} from "./avatar/appearance";
import { startBlinking } from "./avatar/blink";
import { ASSEMBLY_DURATION_MS } from "./avatar/assembly";
import { startTalkingMask } from "./avatar/mask";
import type { AvatarSettings } from "./avatar/types";
import "./style.css";

type Mode = "booting" | "ready" | "voice-starting" | "listening" | "working" | "speaking" | "degraded" | "stopped";
type Message = { id?: number | string; method?: string; params?: any };
type Session = { threadId: string; cwd: string };
type DirectVoice = {
  codexConnected: boolean;
  voiceActive: boolean;
  phase: string;
  protocol: string;
  threadId?: string;
  realtimeSessionId?: string;
};
type WakeStatus = {
  enabled: boolean;
  ready: boolean;
  authorization: string;
};
type WakeEvent = {
  ok: boolean;
    phrase?: string;
  error?: string;
  cold?: boolean;
};
type ClaudeConfiguration = { anthropicKey: boolean; openaiKey: boolean; claudeCodeInstalled: boolean; claudeCodeAuthenticated: boolean };
type GoogleWorkspaceStatus = { installed: boolean; clientConfigured: boolean; authenticated: boolean };
type ClaudeCodeTurn = { answer: string; sessionId: string };
type ClaudeCodeEvent = { requestId: string; kind: string; data?: { text?: string; name?: string; sessionId?: string } };
type PermissionMode = "safe" | "auto" | "full";

const state = {
  mode: "booting" as Mode,
  session: null as Session | null,
  directVoice: null as DirectVoice | null,
  wake: null as WakeStatus | null,
  level: 0,
  manualStop: false,
  agentWorking: false,
};

const WORKSPACE_KEY = "jarvis.workspace";
const THREAD_KEY_PREFIX = "jarvis.threadId:";
const PERMISSION_KEY = "jarvis.permissionMode";
const PROVIDER_KEY = "jarvis.provider";
const CODEX_MODEL_KEY = "jarvis.codexModel";
const CODEX_VOICE_KEY = "jarvis.codexVoice";
const API_TEXT_MODEL_KEY = "jarvis.apiTextModel";
const API_VOICE_MODEL_KEY = "jarvis.apiVoiceModel";
const API_VOICE_KEY = "jarvis.apiVoice";
const CLAUDE_MODEL_KEY = "jarvis.claudeModel";
const CLAUDE_VOICE_KEY = "jarvis.claudeVoice";
const CLAUDE_CODE_SESSION_PREFIX = "jarvis.claudeCodeSession:";
const CLAUDE_CODE_SESSION_NAME_PREFIX = "jarvis.claudeCodeSessionName:";
const CODEX_MODELS = ["", "gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"] as const;
const validCodexModel = (value: string) => value === "" || /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value);
let codexModels: string[] = [...CODEX_MODELS];
const CODEX_VOICES = ["alloy", "arbor", "ash", "ballad", "breeze", "cedar", "coral", "cove", "echo", "ember", "juniper", "maple", "marin", "sage", "shimmer", "sol", "spruce", "vale", "verse"] as const;
const API_TEXT_MODELS = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"] as const;
const API_VOICE_MODELS = ["gpt-realtime", "gpt-realtime-1.5", "gpt-realtime-2", "gpt-realtime-2.1", "gpt-realtime-2.1-mini"] as const;
const API_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"] as const;
const CLAUDE_MODELS = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5"] as const;
const CLAUDE_VOICES = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"] as const;
function validOption<T extends string>(value: string | null, options: readonly T[], fallback: T): T {
  return options.find((option) => option === value) ?? fallback;
}
function storedOption<T extends string>(key: string, options: readonly T[], fallback: T): T {
  return validOption(localStorage.getItem(key), options, fallback);
}
type Provider = "codex" | "openai-api" | "claude" | "claude-code";
function storedProvider(): Provider {
  const value = localStorage.getItem(PROVIDER_KEY);
  return value === "codex" || value === "claude" || value === "claude-code" ? value : "openai-api";
}
const permissionLabels: Record<PermissionMode, string> = {
  safe: "Safe · ask when needed",
  auto: "Automatic · selected workspace",
  full: "Full access · high risk",
};
function storedPermissionMode(): PermissionMode {
  const value = localStorage.getItem(PERMISSION_KEY);
  return value === "safe" || value === "full" ? value : "auto";
}
let workspace = "";
let provider = storedProvider();
let permissionMode = storedPermissionMode();
let codexModel = localStorage.getItem(CODEX_MODEL_KEY) ?? "";
if (!validCodexModel(codexModel)) codexModel = "";
if (!codexModels.includes(codexModel)) codexModels.push(codexModel);
let codexVoice = storedOption(CODEX_VOICE_KEY, CODEX_VOICES, "cove");
let apiTextModel = storedOption(API_TEXT_MODEL_KEY, API_TEXT_MODELS, "gpt-5.6-luna");
let apiVoiceModel = storedOption(API_VOICE_MODEL_KEY, API_VOICE_MODELS, "gpt-realtime");
let apiVoice = storedOption(API_VOICE_KEY, API_VOICES, "ash");
let claudeModel = storedOption(CLAUDE_MODEL_KEY, CLAUDE_MODELS, "claude-sonnet-5-5");
let claudeVoice = storedOption(CLAUDE_VOICE_KEY, CLAUDE_VOICES, "marin");
type AssistantProfile = { assistantName: string; userName: string; instructions: string };
let assistantProfile: AssistantProfile = { assistantName: "Mark", userName: "", instructions: "" };
let assistantName = "Mark";
const assistantContext = () => JSON.stringify(assistantProfile);
const wakePhrase = () => `Hey ${assistantName}`;
const savedThreadId = () => localStorage.getItem(`${THREAD_KEY_PREFIX}${workspace}`);
const savedClaudeCodeSession = () =>
  localStorage.getItem(`${CLAUDE_CODE_SESSION_NAME_PREFIX}${workspace}`) === assistantContext()
    ? localStorage.getItem(`${CLAUDE_CODE_SESSION_PREFIX}${workspace}`)
    : null;
let activeClaudeCodeRequest: string | null = null;
let claudeCodeStreamBuffer = "";
let peer: RTCPeerConnection | null = null;
let activeVoiceProvider: Provider | null = null;
let microphoneStream: MediaStream | null = null;
let remoteStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let microphoneAnalyser: AnalyserNode | null = null;
let remoteAnalyser: AnalyserNode | null = null;
let userTranscriptBuffer = "";
let assistantTranscriptBuffer = "";
let agentMessageBuffer = "";
let voiceStartInFlight = false;
let recoverableColdStartError = false;
let apiSpeechActive = false;
let apiResponseActive = false;
let voiceSleepInFlight = false;
let claudeVoiceActive = false;
let claudeBusy = false;
let claudeRecorder: MediaRecorder | null = null;
let claudeMeterTimer: number | undefined;
let claudePlaybackResolve: (() => void) | null = null;
let claudeVoiceGeneration = 0;
let disconnectTimer: number | undefined;
const VOICE_IDLE_MS = 60_000;
const voiceIdle = new VoiceIdleTimer(
  VOICE_IDLE_MS,
  () => voiceStartInFlight || state.agentWorking || apiSpeechActive || apiResponseActive || claudeBusy ||
    analyserLevel(remoteAnalyser) > 0.025,
  () => { void sleepVoice("idle"); },
);
const voiceAudio = new Audio();
voiceAudio.autoplay = true;
const previewParams = new URLSearchParams(window.location.search);
const tauriInternals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
const currentWindow = typeof tauriInternals?.invoke === "function" ? getCurrentWindow() : null;
const isWindows = navigator.userAgent.includes("Windows");
const windowDismissAction = isWindows ? "minimize" : "hide";
const windowDismissLabel = isWindows ? "Minimize window" : "Hide window";
const previewModeValue = previewParams.get("preview");
const previewActionValue = previewParams.get("action");
const visualPreviewMode: Mode = ["booting", "ready", "voice-starting", "listening", "working", "speaking", "degraded", "stopped"].includes(previewModeValue ?? "")
  ? previewModeValue as Mode
  : "ready";
if (!currentWindow) {
  document.documentElement.classList.add("visual-preview");
  if (previewParams.get("grid") === "1") document.documentElement.classList.add("transparency-grid");
  if (previewParams.get("opaque") === "1") document.documentElement.dataset.windowBackground = "opaque";
}
if (currentWindow) {
  void invoke<boolean>("opaque_window").then((opaque) => {
    if (opaque) document.documentElement.dataset.windowBackground = "opaque";
  });
}

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
<main class="shell" data-mode="booting" data-appearance="helmet" data-mask="segmented" data-effect-particles="on" data-effect-talking-mask="on" data-effect-eye-track="on" data-effect-scan="on">
  <nav class="window-controls" aria-label="Window controls">
    <button id="window-hide" type="button" aria-label="${windowDismissLabel}" title="${windowDismissLabel}"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 10h10"/></svg></button>
    <button id="window-compact" type="button" aria-label="Compact window" title="Compact floating window" aria-pressed="false"><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4" y="4" width="12" height="12" rx="1.5"/><path class="restore-window-mark" d="M7 4V2h11v11h-2"/></svg></button>
    <button id="window-quit" type="button" aria-label="Quit Mark Codex" title="Close — quit Mark Codex"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg></button>
    <span id="window-control-status" role="alert" aria-live="polite"></span>
  </nav>
  <canvas id="particle-field" width="1440" height="900" aria-hidden="true"></canvas>
  <header class="topbar hud-panel">
    <div class="brand"><i></i><strong id="assistant-brand">MARK</strong><span></span><em>CODEX VOICE SYSTEM</em></div>
    <div class="status"><i></i><b id="mode-label">INITIALIZING</b></div>
    <button id="settings" class="icon-button" aria-label="Settings">⌘</button>
  </header>
  <section class="stage">
    <div class="avatar-window">
      <div class="character-aura"></div>
      <div class="character-rig">
        <div class="assembly-orbits" aria-hidden="true"><i></i><i></i><i></i></div>
        <div class="armor-shards" aria-hidden="true"></div>
        <img id="jarvis-character" class="helmet-character" src="/assets/jarvis-character-v2.png" alt="Assistant holographic helmet">
        <div class="helmet-scan"></div>
        <div class="assembly-flash" aria-hidden="true"></div>
      </div>
      <canvas id="wave" width="900" height="120"></canvas>
    </div>
    <div class="identity"><span id="assistant-core">MARK CORE</span><b id="identity-state">SYSTEM BOOT</b></div>
  </section>
  <aside class="workers">
    <article class="worker active" data-role="orchestrator"><span>›_</span><div><b>Codex</b><small>Connecting</small></div><i></i></article>
    <article class="worker" data-role="developer"><span>⌬</span><div><b>Developer</b><small>Standby</small></div><i></i></article>
    <article class="worker" data-role="researcher"><span>⌕</span><div><b>Researcher</b><small>Standby</small></div><i></i></article>
    <article class="worker" data-role="reviewer"><span>✓</span><div><b>Reviewer</b><small>Standby</small></div><i></i></article>
  </aside>
  <section class="dialogue hud-panel">
    <b>YOU</b><p id="user-transcript">No speech received.</p>
    <b class="jarvis" id="assistant-dialogue-name">MARK</b><p id="assistant-transcript">Connecting to your assistant…</p>
  </section>
  <footer class="controls">
    <button id="mic" class="control mic"><span aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="8.25" y="3" width="7.5" height="11.5" rx="3.75"></rect><path d="M5.5 11.25v.75a6.5 6.5 0 0 0 13 0v-.75M12 18.5V22M8.75 22h6.5"></path></svg></span><b id="voice-provider-label">OPENAI VOICE</b><small id="voice-transport-label">REALTIME WEBRTC · DIRECT</small></button>
    <form id="command-form" class="command"><input id="command-input" aria-label="Text command" placeholder="Type a task if voice is unavailable…" autocomplete="off"><button>EXECUTE</button></form>
    <button id="stop" class="control stop"><span aria-hidden="true"><svg viewBox="0 0 24 24"><rect class="stop-mark" x="6.5" y="6.5" width="11" height="11" rx="1.8"></rect></svg></span><b>STOP</b><small>INTERRUPT ALL</small></button>
  </footer>
  <div id="degraded-banner" class="degraded-banner" hidden><b id="assistant-permission-title">MARK NEEDS PERMISSION</b><span id="degraded-copy">Allow microphone and speech recognition access to get started.</span></div>
  <dialog id="approval"><h2>Confirm high-risk action</h2><p id="approval-copy">Codex is requesting approval for an action.</p><div><button id="deny">Deny</button><button id="approve">Allow once</button></div></dialog>
  <dialog id="chatgpt-sign-in" aria-labelledby="chatgpt-sign-in-title" aria-describedby="chatgpt-sign-in-description">
    <h2 id="chatgpt-sign-in-title">Sign in with ChatGPT</h2>
    <p id="chatgpt-sign-in-description">Connect your ChatGPT account to use Codex in Mark. Sign-in opens in your browser.</p>
    <p id="chatgpt-sign-in-status" role="status"></p>
    <div class="sign-in-actions">
      <button id="chatgpt-sign-in-start" type="button">Sign in with ChatGPT</button>
      <button id="chatgpt-sign-in-dismiss" type="button">Not now</button>
    </div>
  </dialog>
  <dialog id="settings-dialog">
    <h2 id="assistant-system-title">MARK SYSTEM</h2>
    <dl><dt>Wake phrase</dt><dd id="wake-phrase-label">Hey Mark / Hi Mark</dd><dt>Wake listener</dt><dd id="wake-auth">Checking…</dd><dt id="thread-label">Codex thread</dt><dd id="thread-id">—</dd><dt>Workspace</dt><dd id="workspace">—</dd><dt>Permission</dt><dd id="permission-mode-label">—</dd><dt>Provider</dt><dd id="provider-label">—</dd><dt>Voice status</dt><dd id="voice-auth">Checking…</dd><dt>Google Workspace</dt><dd id="google-workspace-status">Checking…</dd></dl>
    <label class="workspace-setting">Assistant name<input id="assistant-name-setting" maxlength="20" autocomplete="off" spellcheck="false" aria-describedby="assistant-name-help"></label>
    <p id="assistant-name-help">Use 2–20 English letters. The wake phrases will be “Hey Mark” and “Hi Mark.”</p>
    <label class="workspace-setting assistant-profile-setting">What should the assistant call you?<input id="user-name-setting" maxlength="80" autocomplete="off" placeholder="e.g., Mark, Sir, or Captain" aria-describedby="assistant-profile-help"></label>
    <label class="workspace-setting assistant-profile-setting">Assistant role and personality<textarea id="assistant-instructions-setting" rows="4" maxlength="4000" placeholder="e.g., Be my personal assistant. Help with schedules, coding, and plant operations. Be warm, clear, and concise." aria-describedby="assistant-profile-help"></textarea></label>
    <p id="assistant-profile-help">Optional. Saved on this computer and used for voice and text with every provider. Saving identity changes restarts active voice or work.</p>
    <p id="assistant-profile-status" role="alert" aria-live="polite"></p>
    <label class="workspace-setting">Workspace folder<input id="workspace-setting" autocomplete="off" spellcheck="false"></label>
    <fieldset class="appearance-setting"><legend>Appearance</legend><label><input type="radio" name="appearance" value="helmet" checked><span><b>Original Holographic Helmet</b><small>The current floating helmet</small></span></label><label><input type="radio" name="appearance" value="cyber_boy"><span><b>Cyber Boy</b><small>Cute holographic boy with a light mask</small></span></label><label><input type="radio" name="appearance" value="cyber_girl"><span><b>Cyber Girl</b><small>Cute holographic girl with a light mask</small></span></label><p>Visual only. Switching avatars does not interrupt voice, models, or permissions.</p></fieldset>
    <fieldset class="mask-setting"><legend>Mask style</legend><label><input type="radio" name="mask-style" value="segmented" checked><span><b>Segmented</b><small>Horizontal light bars</small></span></label><label><input type="radio" name="mask-style" value="equalizer"><span><b>Equalizer</b><small>Vertical bars that follow the voice</small></span></label><label><input type="radio" name="mask-style" value="waveform"><span><b>Waveform</b><small>A single speaking wave</small></span></label><p>Used by Cyber Boy and Cyber Girl. The helmet keeps its own face.</p></fieldset>
    <fieldset class="effect-setting"><legend>Avatar effects</legend><label><input type="checkbox" id="effect-particles" checked>Particle assembly</label><label><input type="checkbox" id="effect-talking-mask" checked>Audio-reactive talking mask</label><label><input type="checkbox" id="effect-eye-track" checked>Hover eye tracking</label><label><input type="checkbox" id="effect-scan" checked>Scan glow</label></fieldset>
    <fieldset class="provider-setting"><legend>AI provider</legend><label><input type="radio" name="provider" value="codex"><span><b>Codex</b><small>Use the local Codex app-server session</small></span></label><label><input type="radio" name="provider" value="openai-api"><span><b>OpenAI API</b><small>Use a server-side OPENAI_API_KEY</small></span></label><label><input type="radio" name="provider" value="claude"><span><b>Claude Chat</b><small>Anthropic API text chat with OpenAI speech</small></span></label><label><input type="radio" name="provider" value="claude-code"><span><b>Claude Agent</b><small>Signed-in local Claude CLI coding agent with voice</small></span></label></fieldset>
    <fieldset class="permission-setting"><legend>Codex permissions</legend><label><input type="radio" name="permission-mode" value="safe"><span><b>Safe</b><small>Ask before elevated or risky actions</small></span></label><label class="recommended"><input type="radio" name="permission-mode" value="auto"><span><b>Automatic</b><small>Work autonomously inside the selected workspace</small></span><em>RECOMMENDED</em></label><label class="danger"><input type="radio" name="permission-mode" value="full"><span><b>Full access</b><small>Unrestricted access; use with care</small></span></label></fieldset>
    <p>Codex and Claude Agent share this access setting. Full access also grants Claude Agent unrestricted local tools. Changing permissions, model, or assistant profile stops active work.</p>
    <p id="sleep-explanation">Voice sleeps after 60 seconds of inactivity and waits locally for “Hey Mark.” Active speech and tasks are not interrupted.</p>
    <p>Workspace changes take effect after restarting Mark Codex. Each workspace keeps its own Codex thread.</p>
    <p>New Thread ends the current task and creates a fresh Codex thread. The previous thread remains in Codex history.</p>
    <p>The wake phrase is recognized locally on this computer. Claude Chat requires ANTHROPIC_API_KEY. Claude Agent uses your signed-in Claude CLI instead. Both voice modes require OPENAI_API_KEY for speech. Claude speech is AI-generated.</p>
    <p>Google Workspace access uses a separate Google sign-in for Gmail, Calendar, and Sheets. It is available to Codex when its sandbox permits the CLI, and to Claude Agent in Full access. Claude Chat and OpenAI API do not currently have Google tools.</p>
    <div class="settings-actions"><button id="new-thread" class="new-thread">＋ New Thread</button><span></span><button id="save-settings">Save</button><button id="close-settings">Close</button></div>
  </dialog>
</main>`;

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const shell = $<HTMLElement>(".shell");
const transcript = $("#user-transcript");
const response = $("#assistant-transcript");
const banner = $("#degraded-banner") as HTMLDivElement;
const mic = $("#mic") as HTMLButtonElement;
const approval = $("#approval") as HTMLDialogElement;
const settings = $("#settings-dialog") as HTMLDialogElement;
const chatgptSignIn = $<HTMLDialogElement>("#chatgpt-sign-in");
const startSignIn = $<HTMLButtonElement>("#chatgpt-sign-in-start");
const dismissSignIn = $<HTMLButtonElement>("#chatgpt-sign-in-dismiss");
const signInStatus = $("#chatgpt-sign-in-status");
let codexSignInRequired = false;
const modelOptions = (values: readonly string[], defaultLabel?: string) => values.map((value) =>
  `<option value="${value}">${value || defaultLabel}</option>`).join("");
settings.querySelector(".provider-setting")!.insertAdjacentHTML("afterend", `
  <div id="codex-model-settings" class="model-settings">
    <button id="open-chatgpt-sign-in" type="button">Sign in with ChatGPT</button>
    <label>Codex model<select id="codex-model">${modelOptions(codexModels, "Codex default")}</select></label>
    <label>Codex voice<select id="codex-voice">${modelOptions(CODEX_VOICES)}</select></label>
    <small>Models refresh from Codex when Settings opens. Availability is confirmed when a request runs. Model choice applies to the next Codex turn; voice choice applies to a new voice session.</small>
  </div>
  <div id="api-model-settings" class="model-settings">
    <label>Text model<select id="api-text-model">${modelOptions(API_TEXT_MODELS)}</select></label>
    <label>Realtime model<select id="api-voice-model">${modelOptions(API_VOICE_MODELS)}</select></label>
    <label>Realtime voice<select id="api-voice">${modelOptions(API_VOICES)}</select></label>
    <small>Voice and Realtime model changes apply when you start a new voice session.</small>
  </div>
  <div id="claude-model-settings" class="model-settings">
    <label>Claude model<select id="claude-model">${modelOptions(CLAUDE_MODELS)}</select></label>
    <label>Speech voice<select id="claude-voice">${modelOptions(CLAUDE_VOICES)}</select></label>
    <small>Claude Agent can work in the selected workspace. Safe is read-only; Automatic allows file edits but not shell commands; Full grants unrestricted local tools. OpenAI transcribes speech and generates the AI voice.</small>
    <small id="claude-key-status">Checking Claude setup…</small>
  </div>`);
const characterRig = $<HTMLElement>(".character-rig");
let committedAvatar: AvatarSettings = readAvatarSettings(previewParams);
let avatarPersist = false;
applyAvatar(shell, characterRig, committedAvatar);
syncAvatarForm(settings, committedAvatar);
bindEyeTracking(characterRig, shell);
startTalkingMask(shell, () => state.level, () => state.mode);
startBlinking(shell, () => state.mode);
let compactWindow = false;
let windowModeChanging = false;
const windowControls = $<HTMLElement>(".window-controls");
const compactButton = $<HTMLButtonElement>("#window-compact");
function applyWindowMode(compact: boolean) {
  compactWindow = compact;
  document.documentElement.dataset.windowMode = compact ? "compact" : "full";
  compactButton.setAttribute("aria-pressed", String(compact));
  compactButton.setAttribute("aria-label", compact ? "Restore full window" : "Compact window");
  compactButton.title = compact ? "Restore original full window" : "Compact floating window";
}
async function toggleWindowMode() {
  if (windowModeChanging || !currentWindow) return;
  windowModeChanging = true;
  compactButton.disabled = true;
  $("#window-control-status").textContent = "";
  try {
    applyWindowMode(await invoke<boolean>("toggle_window_mode"));
  } catch (error) {
    $("#window-control-status").textContent = `Could not resize the window: ${String(error)}`;
  } finally {
    compactButton.disabled = false;
    windowModeChanging = false;
  }
}
$("#window-hide").addEventListener("click", () => {
  if (currentWindow) void invoke("minimize_or_hide_window").catch((error) => {
    $("#window-control-status").textContent = `Could not ${windowDismissAction} the window: ${String(error)}`;
  });
});
compactButton.addEventListener("click", () => void toggleWindowMode());
$("#window-quit").addEventListener("click", () => {
  if (currentWindow) void invoke("quit_application");
});
if (currentWindow) {
  void invoke<boolean>("window_is_compact").then(applyWindowMode);
  void listen<boolean>("window-mode-changed", ({ payload }) => applyWindowMode(payload));
  characterRig.addEventListener("pointerdown", (event) => {
    if (event.button === 0 && (compactWindow || isWindows)) {
      void currentWindow.startDragging();
    }
  });
}
// Keep one toolbar usable in the top layer while a Settings or approval dialog is open.
function placeWindowControls() {
  const dialog = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].at(-1);
  const parent = dialog ?? shell;
  if (windowControls.parentElement !== parent) parent.prepend(windowControls);
}
new MutationObserver(placeWindowControls).observe(shell, {
  subtree: true, attributes: true, attributeFilter: ["open"],
});
const hoverControls = $<HTMLElement>(".controls");
const settingsButton = $<HTMLButtonElement>("#settings");
function applyAssistantName(name: string) {
  assistantName = name;
  void currentWindow?.setTitle(`${name.toUpperCase()} · CODEX`);
  $("#assistant-brand").textContent = name.toUpperCase();
  $("#assistant-core").textContent = `${name.toUpperCase()} CORE`;
  $("#assistant-dialogue-name").textContent = name.toUpperCase();
  $("#assistant-permission-title").textContent = `${name.toUpperCase()} NEEDS PERMISSION`;
  $("#assistant-system-title").textContent = `${name.toUpperCase()} SYSTEM`;
  $("#wake-phrase-label").textContent = `Hey ${name} / Hi ${name}`;
  $("#assistant-name-help").textContent = `Use 2–20 English letters. The wake phrases will be “Hey ${name}” and “Hi ${name}.”`;
  $("#sleep-explanation").textContent = `Voice sleeps after 60 seconds of inactivity and waits locally for “Hey ${name}.” Active speech and tasks are not interrupted.`;
  ($("#assistant-name-setting") as HTMLInputElement).value = name;
}
let controlsHideTimer: number | undefined;
let characterActionTimer: number | undefined;

function revealControls() {
  if (controlsHideTimer !== undefined) window.clearTimeout(controlsHideTimer);
  shell.classList.add("controls-visible");
}

function scheduleControlsHide() {
  if (controlsHideTimer !== undefined) window.clearTimeout(controlsHideTimer);
  controlsHideTimer = window.setTimeout(() => shell.classList.remove("controls-visible"), 1500);
}

type CharacterAction = "acknowledge" | "approval" | "complete" | "error";

function triggerCharacterAction(action: CharacterAction, duration = 1100) {
  if (characterActionTimer !== undefined) window.clearTimeout(characterActionTimer);
  for (const name of ["acknowledge", "approval", "complete", "error"] as const) {
    shell.classList.remove(`action-${name}`);
  }
  void shell.clientWidth;
  shell.classList.add(`action-${action}`);
  characterActionTimer = window.setTimeout(() => shell.classList.remove(`action-${action}`), duration);
}

for (const area of [characterRig, hoverControls, settingsButton]) {
  area.addEventListener("pointerenter", revealControls);
  area.addEventListener("pointerleave", scheduleControlsHide);
}
shell.addEventListener("focusin", (event) => {
  if (event.target instanceof Element && (hoverControls.contains(event.target) || settingsButton.contains(event.target))) revealControls();
});
shell.addEventListener("focusout", scheduleControlsHide);

let approvalId: number | string | undefined;
const copy: Record<Mode, [string, string]> = {
  booting: ["INITIALIZING", "SYSTEM BOOT"], ready: ["READY", "CODEX VOICE STANDBY"],
  "voice-starting": ["VOICE LINKING", "OPENING CODEX VOICE"], listening: ["LISTENING", "OFFICIAL VOICE ONLINE"],
  working: ["CODEX WORKING", "TASK EXECUTION"], speaking: ["SPEAKING", "VOICE OUTPUT"],
  degraded: ["PERMISSION NEEDED", "WAKE SYSTEM OFFLINE"], stopped: ["INTERRUPTED", "ALL SYSTEMS HALTED"],
};

function setMode(mode: Mode) {
  state.mode = mode; shell.setAttribute("data-mode", mode);
  $("#mode-label").textContent = mode === "speaking" ? `${assistantName.toUpperCase()} SPEAKING` : mode === "working" && (provider === "claude" || provider === "claude-code") ? "CLAUDE WORKING" : copy[mode][0];
  $("#identity-state").textContent = (provider === "claude" || provider === "claude-code") && mode === "ready" ? "CLAUDE VOICE STANDBY" : copy[mode][1];
  if (mode === "voice-starting") {
    replayAssembly(shell);
    startParticleFormation();
  }
}
function setWorker(role: string, label: string, active = true) {
  const card = document.querySelector<HTMLElement>(`.worker[data-role="${role}"]`);
  if (!card) return;
  card.classList.toggle("active", active); card.querySelector("small")!.textContent = label;
}
function roleOf(params: any) {
  const text = JSON.stringify(params ?? {}).toLowerCase();
  return text.includes("research") ? "researcher" : text.includes("review") ? "reviewer" :
    text.includes("developer") || text.includes("commandexecution") || text.includes("filechange") ? "developer" : "orchestrator";
}
function drawWave() {
  const canvas = $("#wave") as HTMLCanvasElement, context = canvas.getContext("2d")!;
  context.clearRect(0, 0, canvas.width, canvas.height);
  const time = performance.now() / 370, amplitude = 5 + state.level * 42 + (state.mode === "speaking" ? 22 : 0);
  context.beginPath();
  for (let x = 0; x <= canvas.width; x += 3) {
    const y = canvas.height / 2 + (Math.sin(x * .085 + time * 2.2) + Math.sin(x * .031 - time) * .55) * amplitude * Math.sin(x / canvas.width * Math.PI) * .48;
    x ? context.lineTo(x, y) : context.moveTo(x, y);
  }
  context.strokeStyle = state.mode === "working" ? "#ff9d2e" : state.mode === "stopped" ? "#ff3d33" : "#22c7ff";
  context.shadowColor = context.strokeStyle; context.shadowBlur = 15; context.lineWidth = 2; context.stroke();
  state.level *= .9; requestAnimationFrame(drawWave);
}
drawWave();

type VisualParticle = {
  fromX: number;
  fromY: number;
  targetX: number;
  targetY: number;
  size: number;
  phase: number;
  delay: number;
  curve: number;
  amber: boolean;
};

const particleCanvas = $("#particle-field") as HTMLCanvasElement;
const particleContext = particleCanvas.getContext("2d")!;
const characterImage = $("#jarvis-character") as HTMLImageElement;
const armorShardLayer = $<HTMLElement>(".armor-shards");
const armorShardSpecs = [
  ["polygon(35% 4%,65% 4%,63% 23%,37% 23%)", 0, -390, -8, 80],
  ["polygon(17% 9%,37% 4%,38% 31%,22% 35%)", -430, -280, -24, 0],
  ["polygon(63% 4%,83% 9%,78% 35%,62% 31%)", 430, -280, 24, 20],
  ["polygon(37% 22%,63% 22%,61% 45%,39% 45%)", 30, -320, 10, 170],
  ["polygon(20% 31%,39% 27%,43% 48%,19% 49%)", -470, -120, -32, 100],
  ["polygon(61% 27%,80% 31%,81% 49%,57% 48%)", 470, -120, 32, 120],
  ["polygon(16% 45%,43% 44%,46% 57%,20% 59%)", -520, -20, -18, 220],
  ["polygon(57% 44%,84% 45%,80% 59%,54% 57%)", 520, -20, 18, 240],
  ["polygon(42% 43%,58% 43%,59% 70%,41% 70%)", 0, 390, -10, 300],
  ["polygon(19% 56%,42% 54%,41% 73%,24% 78%)", -480, 180, -28, 280],
  ["polygon(58% 54%,81% 56%,76% 78%,59% 73%)", 480, 180, 28, 300],
  ["polygon(24% 73%,42% 68%,45% 84%,31% 88%)", -340, 330, 22, 390],
  ["polygon(58% 68%,76% 73%,69% 88%,55% 84%)", 340, 330, -22, 410],
  ["polygon(41% 68%,59% 68%,56% 88%,44% 88%)", 40, 430, 14, 470],
  ["polygon(31% 85%,45% 82%,44% 96%,36% 94%)", -250, 460, -30, 500],
  ["polygon(55% 82%,69% 85%,64% 94%,56% 96%)", 250, 460, 30, 520],
  ["polygon(43% 86%,57% 86%,56% 98%,44% 98%)", 0, 520, -12, 560],
  ["polygon(12% 25%,24% 19%,22% 45%,14% 52%)", -560, -210, -38, 180],
  ["polygon(76% 19%,88% 25%,86% 52%,78% 45%)", 560, -210, 38, 200],
] as const;

for (const [clip, translateX, translateY, rotation, delay] of armorShardSpecs) {
  const shard = document.createElement("i");
  shard.className = "armor-shard";
  shard.style.setProperty("--shard-clip", clip);
  shard.style.setProperty("--shard-x", `${translateX}px`);
  shard.style.setProperty("--shard-y", `${translateY}px`);
  shard.style.setProperty("--shard-rotation", `${rotation}deg`);
  shard.style.setProperty("--shard-delay", `${delay}ms`);
  if (Math.abs(rotation) >= 28 || delay % 3 === 0) shard.classList.add("amber-edge");
  armorShardLayer.append(shard);
}

let visualParticles: VisualParticle[] = [];
let formationStartedAt = -10_000;
let particleTargetBounds = { left: 0, top: 0, width: 1, height: 1 };
const FORMATION_DURATION = ASSEMBLY_DURATION_MS;

function scatterParticleFromWindowEdge(particle: VisualParticle) {
  const edge = Math.floor(Math.random() * 4);
  const inset = Math.random() * 24;
  if (edge === 0) {
    particle.fromX = inset;
    particle.fromY = Math.random() * particleCanvas.height;
  } else if (edge === 1) {
    particle.fromX = particleCanvas.width - inset;
    particle.fromY = Math.random() * particleCanvas.height;
  } else {
    particle.fromX = Math.random() * particleCanvas.width;
    particle.fromY = edge === 2 ? inset : particleCanvas.height - inset;
  }
}

function syncParticleCanvasSize() {
  const bounds = shell.getBoundingClientRect();
  const width = Math.max(1, Math.round(bounds.width));
  const height = Math.max(1, Math.round(bounds.height));
  if (particleCanvas.width !== width) particleCanvas.width = width;
  if (particleCanvas.height !== height) particleCanvas.height = height;
}

let silhouetteToken = 0;

function sampleSilhouette(source: CanvasImageSource, boundsElement: Element) {
  syncParticleCanvasSize();
  const sample = document.createElement("canvas");
  sample.width = particleCanvas.width;
  sample.height = particleCanvas.height;
  const context = sample.getContext("2d", { willReadFrequently: true })!;
  const shellBounds = shell.getBoundingClientRect();
  const characterBounds = boundsElement.getBoundingClientRect();
  if (characterBounds.width < 2 || characterBounds.height < 2) return;
  const left = characterBounds.left - shellBounds.left;
  const top = characterBounds.top - shellBounds.top;
  particleTargetBounds = { left, top, width: characterBounds.width, height: characterBounds.height };
  context.drawImage(source, left, top, characterBounds.width, characterBounds.height);
  const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
  visualParticles = [];
  for (let y = 0; y < sample.height; y += 7) {
    for (let x = 0; x < sample.width; x += 7) {
      const alpha = pixels[(y * sample.width + x) * 4 + 3];
      if (alpha < 46 || Math.random() > .82) continue;
      const particle: VisualParticle = {
        fromX: 0,
        fromY: 0,
        targetX: x + (Math.random() - .5) * 5,
        targetY: y + (Math.random() - .5) * 5,
        size: Math.random() > .965 ? 2.6 + Math.random() * 1.8 : .45 + Math.random() * 1.65,
        phase: Math.random() * Math.PI * 2,
        delay: Math.random() * .3,
        curve: (Math.random() - .5) * (90 + Math.random() * 190),
        amber: Math.random() < .16,
      };
      scatterParticleFromWindowEdge(particle);
      visualParticles.push(particle);
    }
  }
}

function prepareVisualParticles(done?: () => void) {
  const token = ++silhouetteToken;
  if (shell.dataset.effectParticles === "off") {
    visualParticles = [];
    return;
  }
  const appearance = shell.dataset.appearance ?? "helmet";
  if (appearance === "helmet") {
    if (!characterImage.naturalWidth) return;
    sampleSilhouette(characterImage, characterImage);
    done?.();
    return;
  }
  const avatar = shell.querySelector<SVGSVGElement>(".holo-avatar");
  const src = avatar?.querySelector(".holo-portrait")?.getAttribute("href");
  if (!avatar || !src) return;
  const image = new Image();
  image.onload = () => {
    if (token !== silhouetteToken) return;
    sampleSilhouette(image, avatar);
    done?.();
  };
  image.src = src;
}

function startParticleFormation() {
  if (shell.dataset.effectParticles === "off") {
    visualParticles = [];
    return;
  }
  if (!visualParticles.length) {
    prepareVisualParticles(() => {
      if (visualParticles.length) startParticleFormation();
    });
    return;
  }
  formationStartedAt = performance.now();
  for (const particle of visualParticles) scatterParticleFromWindowEdge(particle);
}

function easeFormation(value: number) {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped * clamped * (3 - 2 * clamped);
}

function particlePosition(particle: VisualParticle, progress: number) {
  const eased = easeFormation(progress);
  const deltaX = particle.targetX - particle.fromX;
  const deltaY = particle.targetY - particle.fromY;
  const distance = Math.max(1, Math.hypot(deltaX, deltaY));
  const bend = Math.sin(eased * Math.PI) * particle.curve;
  return {
    x: particle.fromX + deltaX * eased - deltaY / distance * bend,
    y: particle.fromY + deltaY * eased + deltaX / distance * bend,
  };
}

function drawFormationEnergy(now: number, rawProgress: number) {
  if (rawProgress < 0 || rawProgress > 1.12) return;
  const progress = Math.max(0, Math.min(1, rawProgress));
  const centerX = particleTargetBounds.left + particleTargetBounds.width / 2;
  const centerY = particleTargetBounds.top + particleTargetBounds.height / 2;
  const intensity = Math.sin(progress * Math.PI);
  const outerRadius = Math.max(particleCanvas.width, particleCanvas.height) * .56;
  const targetRadius = Math.max(particleTargetBounds.width, particleTargetBounds.height) * .48;
  const radius = outerRadius + (targetRadius - outerRadius) * easeFormation(progress);

  particleContext.save();
  particleContext.globalCompositeOperation = "lighter";
  particleContext.translate(centerX, centerY);
  particleContext.scale(1, .72);
  for (let index = 0; index < 4; index += 1) {
    const ringRadius = radius + index * 34;
    particleContext.beginPath();
    particleContext.setLineDash([16 + index * 5, 34 + index * 7]);
    particleContext.lineDashOffset = (index % 2 ? 1 : -1) * now / (12 + index * 3);
    particleContext.arc(0, 0, ringRadius, 0, Math.PI * 2);
    particleContext.lineWidth = index === 0 ? 1.8 : .75;
    particleContext.strokeStyle = index === 2
      ? `rgba(255,155,47,${intensity * .48})`
      : `rgba(34,199,255,${intensity * (.56 - index * .08)})`;
    particleContext.stroke();
  }
  particleContext.restore();

  const shock = Math.max(0, Math.min(1, (progress - .68) / .25));
  if (shock > 0 && shock < 1) {
    particleContext.save();
    particleContext.globalCompositeOperation = "lighter";
    particleContext.beginPath();
    particleContext.ellipse(
      centerX,
      centerY,
      targetRadius * (.65 + shock * 1.35),
      targetRadius * (.48 + shock * .95),
      0,
      0,
      Math.PI * 2,
    );
    particleContext.strokeStyle = `rgba(134,229,255,${(1 - shock) * .85})`;
    particleContext.shadowColor = "#22c7ff";
    particleContext.shadowBlur = 28;
    particleContext.lineWidth = 2.4;
    particleContext.stroke();
    particleContext.restore();
  }
}

function drawParticleField(now: number) {
  particleContext.clearRect(0, 0, particleCanvas.width, particleCanvas.height);
  if (shell.dataset.effectParticles === "off") {
    requestAnimationFrame(drawParticleField);
    return;
  }
  if (visualParticles.length) {
    const rawProgress = (now - formationStartedAt) / FORMATION_DURATION;
    const forming = rawProgress >= 0 && rawProgress < 1.08;
    const idleStrength = state.mode === "speaking" ? .18 + state.level * .48 : state.mode === "working" ? .12 : .045;
    particleContext.globalCompositeOperation = "lighter";
    for (const particle of visualParticles) {
      const localRaw = forming ? (rawProgress - particle.delay) / (1 - particle.delay) : 1;
      const progress = Math.max(0, Math.min(1, localRaw));
      const point = particlePosition(particle, progress);
      const previous = particlePosition(particle, Math.max(0, progress - (.035 + particle.size * .008)));
      const drift = forming ? 0 : Math.sin(now / 760 + particle.phase) * (1.1 + state.level * 3.2);
      const x = point.x + drift;
      const y = point.y + Math.cos(now / 830 + particle.phase) * (forming ? 0 : 1.4);
      const alpha = forming
        ? localRaw < 0
          ? .12 + Math.sin(now / 180 + particle.phase) * .08
          : .34 + Math.sin(progress * Math.PI) * .66
        : idleStrength;
      const color = state.mode === "working"
        ? "255,155,47"
        : state.mode === "stopped"
          ? "255,73,62"
          : particle.amber
            ? "255,155,47"
            : "34,199,255";
      if (forming) {
        particleContext.beginPath();
        particleContext.moveTo(previous.x, previous.y);
        particleContext.lineTo(x, y);
        particleContext.strokeStyle = `rgba(${color},${alpha * (particle.size > 2.5 ? .62 : .28)})`;
        particleContext.lineWidth = particle.size > 2.5 ? 1.5 : .65;
        particleContext.stroke();
      }
      particleContext.beginPath();
      particleContext.arc(x, y, particle.size * (forming ? 1.3 : 1), 0, Math.PI * 2);
      particleContext.fillStyle = `rgba(${color},${alpha})`;
      particleContext.fill();
    }
    if (forming) drawFormationEnergy(now, rawProgress);
    particleContext.globalCompositeOperation = "source-over";
  }
  requestAnimationFrame(drawParticleField);
}

if (characterImage.complete && characterImage.naturalWidth) prepareVisualParticles();
else characterImage.addEventListener("load", () => prepareVisualParticles(), { once: true });
new ResizeObserver(() => prepareVisualParticles()).observe(shell);
requestAnimationFrame(drawParticleField);

function analyserLevel(analyser: AnalyserNode | null) {
  if (!analyser) return 0;
  const samples = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(samples);
  let energy = 0;
  for (const sample of samples) {
    const normalized = (sample - 128) / 128;
    energy += normalized * normalized;
  }
  return Math.min(1, Math.sqrt(energy / samples.length) * 5);
}

function updateAudioMeters() {
  if (!currentWindow) {
    const time = performance.now();
    state.level = state.mode === "speaking"
      ? .52 + Math.sin(time / 125) * .16
      : state.mode === "working"
        ? .2 + Math.sin(time / 310) * .08
        : state.mode === "listening"
          ? .08 + Math.sin(time / 430) * .035
          : 0;
    shell.style.setProperty("--voice-pulse", String(1 + state.level * .026));
    shell.style.setProperty("--voice-glow", String(.45 + state.level * .55));
    requestAnimationFrame(updateAudioMeters);
    return;
  }
  const micLevel = analyserLevel(microphoneAnalyser);
  const speakerLevel = analyserLevel(remoteAnalyser);
  if (peer && speakerLevel > 0.04) voiceIdle.activity();
  state.level = Math.max(state.level, micLevel, speakerLevel);
  shell.style.setProperty("--voice-pulse", String(1 + state.level * .026));
  shell.style.setProperty("--voice-glow", String(.45 + state.level * .55));
  if (state.directVoice?.voiceActive && !state.agentWorking) {
    if (speakerLevel > 0.08 && state.mode !== "speaking") setMode("speaking");
    if (speakerLevel < 0.025 && state.mode === "speaking") setMode("listening");
  }
  requestAnimationFrame(updateAudioMeters);
}
updateAudioMeters();

function updateVoiceInfo(info: DirectVoice) {
  state.directVoice = info;
  mic.classList.toggle("active", info.voiceActive);
  if (provider !== "claude" && provider !== "claude-code") $("#voice-auth").textContent = info.codexConnected
    ? `${info.protocol} · ${info.voiceActive ? "connected" : info.phase}`
    : `${info.protocol} · standby`;
  if (info.threadId) {
    state.session = { threadId: info.threadId, cwd: workspace };
    if (provider !== "claude" && provider !== "claude-code") $("#thread-id").textContent = info.threadId;
    localStorage.setItem(`${THREAD_KEY_PREFIX}${workspace}`, info.threadId);
  }
}

async function handle(message: Message) {
  if (message.id !== undefined && message.method) {
    triggerCharacterAction("approval", 1800);
    approvalId = message.id; $("#approval-copy").textContent = `Codex requests approval: ${message.method}`; approval.showModal(); return;
  }
  const method = message.method, params = message.params;
  if (method === "thread/realtime/sdp") {
    if (!peer || activeVoiceProvider !== "codex" || !params?.sdp) return;
    try {
      await peer.setRemoteDescription({ type: "answer", sdp: params.sdp });
    } catch (error) {
      triggerCharacterAction("error");
      setMode("degraded");
      response.textContent = `Codex Voice connection failed: ${String(error)}`;
    }
  } else if (method === "thread/realtime/started") {
    if (activeVoiceProvider !== "codex") return;
    voiceIdle.start();
    updateVoiceInfo({
      codexConnected: true,
      voiceActive: true,
      phase: "connected",
      protocol: "Codex app-server V3 · WebRTC",
      threadId: params?.threadId,
      realtimeSessionId: params?.realtimeSessionId,
    });
    banner.hidden = true;
    setMode("listening");
    triggerCharacterAction("acknowledge");
    setWorker("orchestrator", "Official Voice online");
    response.textContent = `Codex Voice is online. You can speak with ${assistantName} now.`;
  } else if (method === "thread/realtime/transcript/delta") {
    voiceIdle.activity();
    const delta = typeof params?.delta === "string" ? params.delta : "";
    if (params?.role === "assistant") {
      assistantTranscriptBuffer += delta;
      response.textContent = assistantTranscriptBuffer;
      if (!state.agentWorking) setMode("speaking");
    } else {
      userTranscriptBuffer += delta;
      transcript.textContent = userTranscriptBuffer;
      if (!state.agentWorking) setMode("listening");
    }
  } else if (method === "thread/realtime/transcript/done") {
    voiceIdle.activity();
    const text = typeof params?.text === "string" ? params.text.trim() : "";
    if (params?.role === "assistant") {
      if (text) response.textContent = text;
      assistantTranscriptBuffer = "";
      if (!state.agentWorking) setMode("listening");
    } else {
      if (text) transcript.textContent = text;
      userTranscriptBuffer = "";
      if (text) triggerCharacterAction("acknowledge");
    }
  } else if (method === "thread/realtime/itemAdded") {
    const itemType = String(params?.item?.type ?? "");
    if (itemType.includes("handoff") || itemType.includes("delegation")) {
      setMode("working");
      setWorker("orchestrator", "Delegating to Codex");
    }
  } else if (method === "thread/realtime/error") {
    triggerCharacterAction("error");
    setMode("degraded");
    banner.hidden = false;
    const detail = params?.message ?? "Codex Voice realtime error";
    $("#degraded-copy").textContent = detail;
    response.textContent = detail;
  } else if (method === "thread/realtime/closed") {
    if (activeVoiceProvider !== "codex") return;
    cleanupPeer();
    updateVoiceInfo({
      codexConnected: true,
      voiceActive: false,
      phase: "closed",
      protocol: "Codex app-server V3 · WebRTC",
      threadId: params?.threadId ?? state.session?.threadId,
    });
    if (!state.manualStop && !voiceSleepInFlight) {
      setMode("ready");
      response.textContent = `Codex Voice ended. Say "${wakePhrase()}" to wake me again.`;
      await armWakeListener();
    }
  } else if (method === "turn/started") {
    if (state.manualStop) return;
    voiceIdle.activity();
    agentMessageBuffer = "";
    state.agentWorking = true;
    setMode("working"); setWorker("orchestrator", "Codex working");
  } else if (method === "item/agentMessage/delta") {
    voiceIdle.activity();
    const delta = typeof params?.delta === "string" ? params.delta : "";
    agentMessageBuffer += delta;
    if (agentMessageBuffer) response.textContent = agentMessageBuffer;
  } else if (method === "turn/completed") {
    voiceIdle.activity();
    state.agentWorking = false;
    if (!state.manualStop) triggerCharacterAction("complete", 1400);
    setMode(state.manualStop ? "stopped" : state.directVoice?.voiceActive ? "listening" : "ready");
    setWorker("orchestrator", state.manualStop ? "Interrupted" : "Ready", !state.manualStop);
    for (const role of ["developer", "researcher", "reviewer"]) {
      setWorker(role, state.manualStop ? "Interrupted" : "Standby", false);
    }
  } else if (method === "item/started") {
    if (!state.manualStop) setWorker(roleOf(params), "Working");
  }
  else if (method === "item/completed") {
    setWorker(roleOf(params), "Complete", false);
    if (params?.item?.type === "agentMessage") {
      const text = typeof params.item.text === "string" ? params.item.text : agentMessageBuffer;
      if (text) response.textContent = text;
    }
  }
}

async function waitForIceGathering(connection: RTCPeerConnection) {
  if (connection.iceGatheringState === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      connection.removeEventListener("icegatheringstatechange", changed);
      reject(new Error("WebRTC ICE gathering timed out"));
    }, 12_000);
    const changed = () => {
      if (connection.iceGatheringState !== "complete") return;
      window.clearTimeout(timer);
      connection.removeEventListener("icegatheringstatechange", changed);
      resolve();
    };
    connection.addEventListener("icegatheringstatechange", changed);
  });
}

function attachAnalyser(stream: MediaStream, target: "microphone" | "remote") {
  audioContext ??= new AudioContext();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  audioContext.createMediaStreamSource(stream).connect(analyser);
  if (target === "microphone") microphoneAnalyser = analyser;
  else remoteAnalyser = analyser;
}

function cleanupPeer() {
  voiceIdle.stop();
  if (activeVoiceProvider === "claude" || activeVoiceProvider === "claude-code") {
    $("#voice-auth").textContent = `${activeVoiceProvider === "claude-code" ? "Claude Agent" : "Claude"} · standby`;
  }
  claudeVoiceGeneration += 1;
  claudeVoiceActive = false;
  claudeBusy = false;
  if (claudeMeterTimer !== undefined) window.clearInterval(claudeMeterTimer);
  claudeMeterTimer = undefined;
  if (claudeRecorder?.state === "recording") claudeRecorder.stop();
  claudeRecorder = null;
  claudePlaybackResolve?.();
  claudePlaybackResolve = null;
  if (disconnectTimer !== undefined) window.clearTimeout(disconnectTimer);
  disconnectTimer = undefined;
  apiSpeechActive = false;
  apiResponseActive = false;
  if (state.directVoice) state.directVoice = { ...state.directVoice, voiceActive: false, phase: "closed" };
  mic.classList.remove("active");
  const closingPeer = peer;
  peer = null;
  activeVoiceProvider = null;
  closingPeer?.close();
  microphoneStream?.getTracks().forEach((track) => track.stop());
  microphoneStream = null;
  remoteStream?.getTracks().forEach((track) => track.stop());
  remoteStream = null;
  voiceAudio.pause();
  voiceAudio.srcObject = null;
  voiceAudio.removeAttribute("src");
  microphoneAnalyser = null;
  remoteAnalyser = null;
}

function claudeRecordingMime() {
  return ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"]
    .find((mime) => MediaRecorder.isTypeSupported(mime));
}

function listenClaudeUtterance(generation: number) {
  if (!claudeVoiceActive || generation !== claudeVoiceGeneration || !microphoneStream) return;
  const mimeType = claudeRecordingMime();
  if (!mimeType) throw new Error("This Mac cannot record a supported speech format.");
  const recorder = new MediaRecorder(microphoneStream, { mimeType });
  claudeRecorder = recorder;
  const chunks: Blob[] = [];
  let speakingSince = 0;
  let lastSpeechAt = 0;
  const startedAt = performance.now();
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
  recorder.onerror = () => {
    if (generation === claudeVoiceGeneration) void sleepVoice("connection");
  };
  recorder.onstop = () => {
    if (claudeMeterTimer !== undefined) window.clearInterval(claudeMeterTimer);
    claudeMeterTimer = undefined;
    if (generation !== claudeVoiceGeneration || !claudeVoiceActive) return;
    if (!speakingSince || performance.now() - speakingSince < 250) {
      listenClaudeUtterance(generation);
      return;
    }
    void processClaudeUtterance(new Blob(chunks, { type: mimeType }), mimeType, generation);
  };
  recorder.start();
  setMode("listening");
  claudeMeterTimer = window.setInterval(() => {
    if (generation !== claudeVoiceGeneration || recorder.state !== "recording") return;
    const now = performance.now();
    const level = analyserLevel(microphoneAnalyser);
    if (level > 0.09) {
      if (!speakingSince) speakingSince = now;
      lastSpeechAt = now;
      voiceIdle.activity();
    }
    if ((speakingSince && now - lastSpeechAt > 850) || now - startedAt > 20_000) recorder.stop();
  }, 100);
}

async function sendClaudeCodeTurn(text: string) {
  if (activeClaudeCodeRequest) throw new Error("Claude Agent is already working. Press STOP before starting another task.");
  const requestId = crypto.randomUUID();
  activeClaudeCodeRequest = requestId;
  claudeCodeStreamBuffer = "";
  const sessionAssistantContext = assistantContext();
  try {
    const turn = await invoke<ClaudeCodeTurn>("send_claude_code", {
      text, model: claudeModel, cwd: workspace, sessionId: savedClaudeCodeSession(),
      permissionMode, requestId,
    });
    localStorage.setItem(`${CLAUDE_CODE_SESSION_PREFIX}${workspace}`, turn.sessionId);
    localStorage.setItem(`${CLAUDE_CODE_SESSION_NAME_PREFIX}${workspace}`, sessionAssistantContext);
    if (provider === "claude-code") $("#thread-id").textContent = turn.sessionId;
    return turn.answer;
  } finally {
    if (activeClaudeCodeRequest === requestId) activeClaudeCodeRequest = null;
  }
}

async function processClaudeUtterance(blob: Blob, mimeType: string, generation: number) {
  claudeBusy = true;
  voiceIdle.activity();
  setMode("working");
  response.textContent = "Transcribing speech…";
  try {
    const audio = Array.from(new Uint8Array(await blob.arrayBuffer()));
    const text = await invoke<string>("transcribe_claude_audio", { audio, mimeType });
    if (generation !== claudeVoiceGeneration || !claudeVoiceActive) return;
    if (!text) return;
    transcript.textContent = text;
    response.textContent = "Claude is thinking…";
    const answer = provider === "claude-code"
      ? await sendClaudeCodeTurn(text)
      : await invoke<string>("send_claude_text", { text, model: claudeModel });
    if (generation !== claudeVoiceGeneration || !claudeVoiceActive) return;
    response.textContent = answer;
    const audioReply = await invoke<number[]>("speak_claude_text", { text: answer, voice: claudeVoice });
    if (generation !== claudeVoiceGeneration || !claudeVoiceActive) return;
    const url = URL.createObjectURL(new Blob([new Uint8Array(audioReply)], { type: "audio/mpeg" }));
    voiceAudio.src = url;
    setMode("speaking");
    try {
      await new Promise<void>((resolve, reject) => {
        claudePlaybackResolve = resolve;
        voiceAudio.onended = () => resolve();
        voiceAudio.onerror = () => reject(new Error("Could not play Claude's speech response"));
        void voiceAudio.play().catch(reject);
      });
    } finally {
      claudePlaybackResolve = null;
      voiceAudio.onended = null;
      voiceAudio.onerror = null;
      voiceAudio.removeAttribute("src");
      URL.revokeObjectURL(url);
    }
  } catch (error) {
    if (generation === claudeVoiceGeneration) {
      response.textContent = `Claude voice error: ${String(error)}`;
      banner.hidden = false;
      $("#degraded-copy").textContent = String(error);
    }
  } finally {
    if (generation === claudeVoiceGeneration && claudeVoiceActive) {
      claudeBusy = false;
      voiceIdle.activity();
      listenClaudeUtterance(generation);
    }
  }
}

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

function isNotAllowedError(error: unknown) {
  return error instanceof DOMException
    ? error.name === "NotAllowedError"
    : String(error).includes("NotAllowedError");
}

async function acquireMicrophone(coldStart: boolean) {
  const attempts = coldStart ? 6 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      if (!coldStart || !isNotAllowedError(error) || attempt === attempts) throw error;
      response.textContent = `Waiting for the microphone to become available… ${attempt}/${attempts - 1}`;
      await sleep(700);
    }
  }
  throw new Error("Microphone initialization failed");
}

async function startDirectVoice({ coldStart = false } = {}) {
  if (!currentWindow) {
    setMode("voice-starting");
    window.setTimeout(() => setMode("listening"), FORMATION_DURATION);
    return;
  }
  if (promptForCodexSignIn()) return;
  if (voiceStartInFlight || peer || state.directVoice?.voiceActive || claudeVoiceActive) return;
  const voiceProvider = provider;
  voiceStartInFlight = true;
  state.manualStop = false;
  recoverableColdStartError = false;
  setMode("voice-starting");
  banner.hidden = true;
  response.textContent = "Connecting to voice…";
  try {
    const microphoneAuthorization = await invoke<string>("request_microphone_permission");
    if (microphoneAuthorization !== "authorized") {
      throw new Error("Allow Mark Codex to use the microphone in System Settings → Privacy & Security → Microphone.");
    }
    await invoke("disarm_wake_listener");
    if (coldStart) {
      // A newly created WKWebView can reject an otherwise-authorized
      // getUserMedia call until its first visible/focused render cycle.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      await sleep(900);
    }
    microphoneStream = await acquireMicrophone(coldStart);
    attachAnalyser(microphoneStream, "microphone");

    if (voiceProvider === "claude" || voiceProvider === "claude-code") {
      const keys = await invoke<ClaudeConfiguration>("claude_configuration");
      if (voiceProvider === "claude-code" && !keys.claudeCodeInstalled) {
        throw new Error("Install the official Claude CLI to use Claude Agent voice.");
      }
      if (voiceProvider === "claude-code" && !keys.claudeCodeAuthenticated) {
        throw new Error("Claude CLI is not signed in. Run claude auth login in Terminal.");
      }
      if (!keys.openaiKey || (voiceProvider === "claude" && !keys.anthropicKey)) {
        throw new Error(`Claude voice needs ${[voiceProvider === "claude" && !keys.anthropicKey && "ANTHROPIC_API_KEY", !keys.openaiKey && "OPENAI_API_KEY"].filter(Boolean).join(" and ")}.`);
      }
      const mimeType = claudeRecordingMime();
      if (!mimeType) throw new Error("This Mac cannot record a supported speech format.");
      activeVoiceProvider = voiceProvider;
      claudeVoiceActive = true;
      mic.classList.add("active");
      $("#voice-auth").textContent = `${voiceProvider === "claude-code" ? "Claude Agent" : "Claude"} · listening`;
      voiceIdle.start();
      listenClaudeUtterance(claudeVoiceGeneration);
      response.textContent = "Claude voice is listening. Speech is AI-generated.";
      return;
    }

    const connection = new RTCPeerConnection();
    peer = connection;
    activeVoiceProvider = voiceProvider;
    const track = microphoneStream.getAudioTracks()[0];
    if (!track) throw new Error("No microphone audio track found");
    connection.addTrack(track, microphoneStream);
    const dataChannel = connection.createDataChannel("oai-events");
    dataChannel.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        const payload = message?.type === "response.event" ? message.event : message;
        const eventType = payload?.type;
        if (eventType === "input_audio_buffer.speech_started") apiSpeechActive = true;
        if (eventType === "input_audio_buffer.speech_stopped") apiSpeechActive = false;
        if (eventType === "response.created") apiResponseActive = true;
        if (eventType === "response.done") {
          apiResponseActive = false;
          if (!state.agentWorking) setMode("listening");
        }
        if (["input_audio_buffer.speech_started", "input_audio_buffer.speech_stopped", "response.created", "response.done"].includes(eventType)) {
          voiceIdle.activity();
        }
        const delta = payload?.delta ?? payload?.item?.content?.[0]?.transcript;
        if (typeof delta === "string") {
          voiceIdle.activity();
          assistantTranscriptBuffer += delta;
          response.textContent = assistantTranscriptBuffer;
          setMode("speaking");
        }
      } catch { /* ignore non-JSON events */ }
    };
    connection.ontrack = (event) => {
      remoteStream = event.streams[0] ?? new MediaStream([event.track]);
      voiceAudio.srcObject = remoteStream;
      attachAnalyser(remoteStream, "remote");
      void audioContext?.resume();
      void voiceAudio.play();
    };
    connection.onconnectionstatechange = () => {
      if (connection !== peer) return;
      if (disconnectTimer !== undefined) window.clearTimeout(disconnectTimer);
      disconnectTimer = undefined;
      if (connection.connectionState === "failed" || connection.connectionState === "closed") {
        void sleepVoice("connection");
      } else if (connection.connectionState === "disconnected") {
        disconnectTimer = window.setTimeout(() => {
          if (connection === peer && connection.connectionState === "disconnected") void sleepVoice("connection");
        }, 5_000);
      }
    };
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    await waitForIceGathering(connection);
    const sdp = connection.localDescription?.sdp;
    if (!sdp) throw new Error("WebRTC did not generate an SDP offer");

    if (voiceProvider === "openai-api") {
      const answer = await invoke<string>("start_openai_realtime", { sdp, model: apiVoiceModel, voice: apiVoice });
      if (connection !== peer) return;
      await connection.setRemoteDescription({ type: "answer", sdp: answer });
      voiceIdle.start();
      setMode("listening"); response.textContent = "OpenAI Realtime voice online.";
      return;
    }
    const info = await invoke<DirectVoice>("start_codex_voice", {
      cwd: workspace,
      threadId: savedThreadId(),
      permissionMode,
      model: codexModel || null,
      sdp,
      voice: codexVoice,
    });
    if (connection !== peer) {
      await invoke("stop_codex_voice");
      return;
    }
    updateVoiceInfo(info);
  } catch (error) {
    cleanupPeer();
    recoverableColdStartError = coldStart && isNotAllowedError(error);
    setMode("degraded");
    banner.hidden = false;
    $("#degraded-copy").textContent = String(error);
    response.textContent = String(error);
    await armWakeListener();
  } finally {
    voiceStartInFlight = false;
  }
}

async function stopDirectVoice() {
  const stopCodex = activeVoiceProvider === "codex" || state.directVoice?.voiceActive === true;
  const stopClaude = activeVoiceProvider === "claude" || activeVoiceProvider === "claude-code";
  cleanupPeer();
  if (stopClaude) await invoke("interrupt_claude");
  if (!stopCodex) return;
  const info = await invoke<DirectVoice>("stop_codex_voice");
  updateVoiceInfo(info);
}

async function sleepVoice(reason: "idle" | "manual" | "connection") {
  if (voiceSleepInFlight || (!peer && !state.directVoice?.voiceActive && !claudeVoiceActive)) return;
  voiceSleepInFlight = true;
  try {
    await stopDirectVoice();
  } catch {
    cleanupPeer();
  } finally {
    if (!state.agentWorking) {
      setMode("ready");
      response.textContent = reason === "connection"
        ? `Voice disconnected. Say "${wakePhrase()}" to reconnect.`
        : reason === "idle"
          ? `${assistantName} is sleeping after 60 seconds of inactivity. Say "${wakePhrase()}" to wake me.`
          : `Voice off. Say "${wakePhrase()}" to wake me.`;
    }
    await armWakeListener();
    voiceSleepInFlight = false;
  }
}

if (currentWindow) {
  await listen<ClaudeCodeEvent>("claude-code-event", ({ payload }) => {
    if (payload.requestId !== activeClaudeCodeRequest) return;
    if (payload.kind === "delta" && payload.data?.text) {
      claudeCodeStreamBuffer += payload.data.text;
      response.textContent = claudeCodeStreamBuffer;
      voiceIdle.activity();
    } else if (payload.kind === "tool" && payload.data?.name) {
      setWorker("developer", `Claude: ${payload.data.name}`);
      voiceIdle.activity();
    }
  });
  await listen<Message>("codex-event", ({ payload }) => void handle(payload));
  await listen<WakeStatus>("jarvis-wake-status", ({ payload }) => {
    state.wake = payload;
    $("#wake-auth").textContent = payload.ready
      ? "Local listener ready"
      : payload.authorization === "authorized"
        ? "Waiting to re-arm"
        : payload.authorization;
    if (payload.ready) {
      if (recoverableColdStartError && state.mode === "degraded") {
        recoverableColdStartError = false;
        banner.hidden = true;
        setMode("ready");
      }
      if (state.mode === "ready") {
        response.textContent = `I’m here. Say "${wakePhrase()}" to begin.`;
        setWorker("orchestrator", "Wake word armed");
      }
    }
  });
  await listen<WakeEvent>("jarvis-wake", ({ payload }) => {
    transcript.textContent = payload.phrase ? `“${payload.phrase}”` : `“${wakePhrase()}”`;
    state.manualStop = false;
    if (!payload.ok) {
      setMode("degraded");
      banner.hidden = false;
      $("#degraded-copy").textContent = payload.error ?? "Could not open Codex Voice.";
      response.textContent = payload.error ?? "Could not open Codex Voice.";
      return;
    }
    banner.hidden = true;
    void startDirectVoice({ coldStart: payload.cold === true });
  });
}
$("#command-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const input = $("#command-input") as HTMLInputElement, text = input.value.trim();
  if (!text) return;
  if (promptForCodexSignIn()) return;
  state.manualStop = false;
  transcript.textContent = text;
  input.value = "";
  if (!currentWindow) {
    response.textContent = "Preview: the text task is now in progress.";
    setMode("working");
    return;
  }
  if (state.directVoice?.voiceActive) {
    response.textContent = "Text added to the current Codex Voice session.";
    await invoke("append_codex_voice_text", { text });
    return;
  }
  if (claudeVoiceActive) await sleepVoice("manual");
  if (provider === "claude" || provider === "claude-code") {
    setMode("working");
    banner.hidden = true;
    response.textContent = provider === "claude-code" ? "Claude Agent is working…" : "Contacting Claude…";
    try {
      const answer = provider === "claude-code"
        ? await sendClaudeCodeTurn(text)
        : await invoke<string>("send_claude_text", { text, model: claudeModel });
      if (state.manualStop) return;
      response.textContent = answer;
      setMode("ready");
    } catch (error) {
      if (state.manualStop) return;
      response.textContent = `Claude error: ${String(error)}`;
      setMode("degraded");
      banner.hidden = false;
      $("#degraded-copy").textContent = String(error);
    }
    return;
  }
  if (provider === "openai-api") {
    setMode("working");
    banner.hidden = true;
    response.textContent = "Contacting OpenAI…";
    try {
      const answer = await invoke<string>("send_openai_text", { text, model: apiTextModel });
      response.textContent = answer || "OpenAI returned an empty response.";
      setMode("ready");
    } catch (error) {
      response.textContent = `OpenAI API error: ${String(error)}`;
      setMode("degraded");
      banner.hidden = false;
      $("#degraded-banner b").textContent = "OPENAI API ERROR";
      $("#degraded-copy").textContent = String(error);
    }
    return;
  }
  if (!state.session) {
    state.session = await invoke<Session>("start_jarvis", {
      cwd: workspace,
      threadId: savedThreadId(),
      permissionMode,
      model: codexModel || null,
    });
    localStorage.setItem(`${THREAD_KEY_PREFIX}${workspace}`, state.session.threadId);
    $("#thread-id").textContent = state.session.threadId;
    $("#workspace").textContent = state.session.cwd;
  }
  setMode("working");
  await invoke("send_text", { text });
});
mic.addEventListener("click", () => {
  if (state.directVoice?.voiceActive || peer || claudeVoiceActive) void sleepVoice("manual");
  else void startDirectVoice();
});
$("#stop").addEventListener("click", async () => {
  triggerCharacterAction("error", 700);
  state.manualStop = true; setMode("stopped");
  activeClaudeCodeRequest = null;
  state.agentWorking = false;
  for (const role of ["orchestrator", "developer", "researcher", "reviewer"]) setWorker(role, "Interrupted", false);
  if (!currentWindow) return;
  if (state.directVoice?.voiceActive || peer || claudeVoiceActive) {
    try { await stopDirectVoice(); } catch { /* task interruption still continues */ }
  }
  await invoke("stop_all");
  await armWakeListener();
});
function syncPermissionControls() {
  shell.dataset.provider = provider;
  const input = document.querySelector<HTMLInputElement>(
    `input[name="permission-mode"][value="${permissionMode}"]`,
  );
  if (input) input.checked = true;
  $("#permission-mode-label").textContent = permissionLabels[permissionMode];
  $("#provider-label").textContent = provider === "openai-api" ? "OpenAI API" : provider === "claude" ? "Claude Chat" : provider === "claude-code" ? "Claude Agent" : "Codex";
  $("#voice-provider-label").textContent = provider === "openai-api" ? "OPENAI VOICE" : provider === "claude-code" ? "CLAUDE AGENT VOICE" : provider === "claude" ? "CLAUDE VOICE" : "CODEX VOICE";
  $("#voice-transport-label").textContent = provider === "claude" || provider === "claude-code" ? "TURN-BASED SPEECH · API" : "REALTIME WEBRTC · DIRECT";
  $("#thread-label").textContent = provider === "claude-code" ? "Claude Agent session" : provider === "claude" ? "Conversation" : "Codex thread";
  $("#thread-id").textContent = provider === "claude-code" ? savedClaudeCodeSession() ?? "Not started" : provider === "claude" ? "In memory" : state.session?.threadId ?? "Not started";
  if (provider === "claude" || provider === "claude-code") $("#voice-auth").textContent = claudeVoiceActive ? `${provider === "claude-code" ? "Claude Agent" : "Claude"} · listening` : `${provider === "claude-code" ? "Claude Agent" : "Claude"} · standby`;
  $("#new-thread").textContent = provider === "claude" || provider === "claude-code" ? "＋ New Conversation" : "＋ New Thread";
  $("#permission-mode-label").textContent = provider === "claude-code"
    ? { safe: "Safe · read-only", auto: "Automatic · file edits", full: "Full access · unrestricted" }[permissionMode]
    : permissionLabels[permissionMode];
  const providerInput = document.querySelector<HTMLInputElement>(`input[name="provider"][value="${provider}"]`);
  if (providerInput) providerInput.checked = true;
  ($("#codex-model") as HTMLSelectElement).value = codexModel;
  ($("#codex-voice") as HTMLSelectElement).value = codexVoice;
  ($("#api-text-model") as HTMLSelectElement).value = apiTextModel;
  ($("#api-voice-model") as HTMLSelectElement).value = apiVoiceModel;
  ($("#api-voice") as HTMLSelectElement).value = apiVoice;
  ($("#claude-model") as HTMLSelectElement).value = claudeModel;
  ($("#claude-voice") as HTMLSelectElement).value = claudeVoice;
  syncModelPanels();
}
async function refreshCodexModels() {
  if (!currentWindow) return;
  try {
    const available = await invoke<string[]>("list_codex_models");
    if (!settings.open) return;
    if (!available.length) return;
    const select = $("#codex-model") as HTMLSelectElement;
    const selected = select.value;
    codexModels = ["", ...new Set(available.filter(validCodexModel).filter(Boolean))];
    if (selected && !codexModels.includes(selected)) codexModels.push(selected);
    select.replaceChildren(...codexModels.map((model) => new Option(model || "Codex default", model)));
    select.value = selected;
  } catch (error) {
    console.warn("Could not refresh Codex models; using saved model choices", error);
  }
}
function syncModelPanels() {
  const selectedProvider = document.querySelector<HTMLInputElement>('input[name="provider"]:checked')?.value;
  ($("#codex-model-settings") as HTMLElement).hidden = selectedProvider !== "codex";
  ($("#api-model-settings") as HTMLElement).hidden = selectedProvider !== "openai-api";
  ($("#claude-model-settings") as HTMLElement).hidden = selectedProvider !== "claude" && selectedProvider !== "claude-code";
  ($(".permission-setting") as HTMLElement).hidden = selectedProvider !== "codex" && selectedProvider !== "claude-code";
  ($(".permission-setting legend") as HTMLElement).textContent = selectedProvider === "claude-code" ? "Claude Agent permissions" : "Codex permissions";
  const claudeCodeSelected = selectedProvider === "claude-code";
  const descriptions: Record<PermissionMode, string> = claudeCodeSelected
    ? { safe: "Read and plan only; no edits or commands", auto: "Edit files in the workspace; shell commands unavailable", full: "Unrestricted local tools; use with care" }
    : { safe: "Ask before elevated or risky actions", auto: "Work autonomously inside the selected workspace", full: "Unrestricted access; use with care" };
  for (const mode of ["safe", "auto", "full"] as const) {
    const small = document.querySelector<HTMLInputElement>(`input[name="permission-mode"][value="${mode}"]`)?.parentElement?.querySelector("small");
    if (small) small.textContent = descriptions[mode];
  }
}
for (const input of document.querySelectorAll<HTMLInputElement>('input[name="provider"]')) {
  input.addEventListener("change", () => { syncModelPanels(); void refreshClaudeKeyStatus(); });
}

async function refreshClaudeKeyStatus() {
  if (!currentWindow) return;
  try {
    const keys = await invoke<ClaudeConfiguration>("claude_configuration");
    const selected = document.querySelector<HTMLInputElement>('input[name="provider"]:checked')?.value ?? provider;
    $("#claude-key-status").textContent = selected === "claude-code"
      ? `Claude CLI: ${keys.claudeCodeInstalled ? "installed" : "missing"} · Sign-in: ${keys.claudeCodeAuthenticated ? "ready" : "run claude auth login"} · OpenAI speech key: ${keys.openaiKey ? "configured" : "missing"}`
      : `Anthropic API key: ${keys.anthropicKey ? "configured" : "missing"} · OpenAI speech key: ${keys.openaiKey ? "configured" : "missing"}`;
  } catch (error) {
    $("#claude-key-status").textContent = `Could not check API keys: ${String(error)}`;
  }
}

async function refreshGoogleWorkspaceStatus() {
  if (!currentWindow) return;
  try {
    const google = await invoke<GoogleWorkspaceStatus>("google_workspace_status");
    $("#google-workspace-status").textContent = google.authenticated
      ? "Connected · Gmail, Calendar, Sheets"
      : google.clientConfigured ? "Client ready · sign in with Google" : google.installed
        ? "CLI installed · OAuth client not configured" : "CLI not installed";
  } catch (error) {
    $("#google-workspace-status").textContent = `Could not check Google connection: ${String(error)}`;
  }
}

function previewAvatarDraft() {
  const next = avatarSettingsFromForm(settings);
  const appearanceChanged = applyAvatar(shell, characterRig, next);
  if (!next.effects.particles) {
    visualParticles = [];
    return;
  }
  if (appearanceChanged) {
    visualParticles = [];
    if (state.mode !== "voice-starting") replayAssembly(shell);
    prepareVisualParticles(() => startParticleFormation());
    return;
  }
  prepareVisualParticles();
}

function restoreCommittedAvatar() {
  applyAvatar(shell, characterRig, committedAvatar);
  syncAvatarForm(settings, committedAvatar);
  if (state.mode !== "voice-starting") cancelAssembly(shell);
  prepareVisualParticles();
}

function openChatGptSignIn() {
  if (chatgptSignIn.open) return;
  signInStatus.textContent = "";
  chatgptSignIn.showModal();
}

function promptForCodexSignIn(): boolean {
  if (!currentWindow || provider !== "codex" || !codexSignInRequired) return false;
  openChatGptSignIn();
  return true;
}

async function checkCodexSignIn(showPrompt: boolean) {
  if (!currentWindow || provider !== "codex") return;
  try {
    codexSignInRequired = await invoke<boolean>("codex_sign_in_required");
    $<HTMLButtonElement>("#open-chatgpt-sign-in").hidden = !codexSignInRequired;
    if (showPrompt) promptForCodexSignIn();
  } catch (error) {
    console.warn("Could not check Codex sign-in", error);
  }
}

startSignIn.addEventListener("click", async () => {
  startSignIn.disabled = true;
  dismissSignIn.textContent = "Cancel sign-in";
  signInStatus.textContent = "Complete sign-in in your browser.";
  try {
    if (await invoke<boolean>("sign_in_with_chatgpt")) {
      codexSignInRequired = false;
      $<HTMLButtonElement>("#open-chatgpt-sign-in").hidden = true;
      chatgptSignIn.close();
      response.textContent = "Codex is ready.";
    } else {
      signInStatus.textContent = "Sign-in canceled.";
    }
  } catch (error) {
    signInStatus.textContent = String(error);
  } finally {
    startSignIn.disabled = false;
    dismissSignIn.disabled = false;
    dismissSignIn.textContent = "Not now";
  }
});

dismissSignIn.addEventListener("click", async () => {
  if (!startSignIn.disabled) {
    chatgptSignIn.close();
    return;
  }
  dismissSignIn.disabled = true;
  try {
    await invoke("cancel_chatgpt_login");
  } catch (error) {
    signInStatus.textContent = String(error);
    dismissSignIn.disabled = false;
  }
});

chatgptSignIn.addEventListener("cancel", (event) => {
  if (!startSignIn.disabled) return;
  event.preventDefault();
  dismissSignIn.click();
});

$("#open-chatgpt-sign-in").addEventListener("click", () => {
  if (!currentWindow) return;
  settings.close();
  openChatGptSignIn();
});

$("#settings").addEventListener("click", async () => {
  if (compactWindow) {
    await toggleWindowMode();
    if (compactWindow) return;
  }
  syncAvatarForm(settings, committedAvatar);
  syncPermissionControls();
  ($("#assistant-name-setting") as HTMLInputElement).value = assistantName;
  ($("#user-name-setting") as HTMLInputElement).value = assistantProfile.userName;
  ($("#assistant-instructions-setting") as HTMLTextAreaElement).value = assistantProfile.instructions;
  $("#assistant-profile-status").textContent = "";
  settings.showModal();
  void refreshCodexModels();
  void refreshClaudeKeyStatus();
  void refreshGoogleWorkspaceStatus();
});
$("#close-settings").addEventListener("click", () => settings.close());
settings.addEventListener("close", () => {
  if (avatarPersist) {
    avatarPersist = false;
    return;
  }
  restoreCommittedAvatar();
});
settings.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (target.name === "appearance" || target.name === "mask-style" || target.id.startsWith("effect-")) previewAvatarDraft();
});
$("#new-thread").addEventListener("click", async () => {
  if (currentWindow && provider === "codex" && codexSignInRequired) {
    settings.close();
    promptForCodexSignIn();
    return;
  }
  const button = $("#new-thread") as HTMLButtonElement;
  button.disabled = true;
  state.manualStop = true;
  settings.close();
  response.textContent = "Ending the current task and creating a new Codex thread…";
  try {
    if (state.directVoice?.voiceActive || peer || claudeVoiceActive) {
      try { await stopDirectVoice(); } catch { cleanupPeer(); }
    }
    if (provider === "claude" || provider === "claude-code") {
      await invoke("reset_claude_conversation");
      if (provider === "claude-code") {
        localStorage.removeItem(`${CLAUDE_CODE_SESSION_PREFIX}${workspace}`);
        localStorage.removeItem(`${CLAUDE_CODE_SESSION_NAME_PREFIX}${workspace}`);
        $("#thread-id").textContent = "Not started";
      }
      response.textContent = `New ${provider === "claude-code" ? "Claude Agent" : "Claude"} conversation started.`;
      setMode("ready");
      return;
    }
    try { await invoke("stop_all"); } catch { /* no active runtime */ }
    await invoke("shutdown");
    const freshSession = await invoke<Session>("start_jarvis", {
      cwd: workspace,
      threadId: null,
      permissionMode,
      model: codexModel || null,
    });
    state.session = freshSession;
    state.directVoice = null;
    localStorage.setItem(`${THREAD_KEY_PREFIX}${workspace}`, freshSession.threadId);
    $("#thread-id").textContent = freshSession.threadId;
    $("#workspace").textContent = freshSession.cwd;
    userTranscriptBuffer = "";
    assistantTranscriptBuffer = "";
    agentMessageBuffer = "";
    transcript.textContent = '“New Thread”';
    response.textContent = "New Codex thread created. Voice and text tasks will use it.";
    setMode("ready");
    setWorker("orchestrator", "Fresh thread ready");
  } catch (error) {
    try { await invoke("shutdown"); } catch { /* already stopped */ }
    state.session = null;
    state.directVoice = null;
    setMode("degraded");
    response.textContent = `Could not create a new thread. You can still resume the previous one: ${String(error)}`;
  } finally {
    button.disabled = false;
    await armWakeListener();
  }
});
$("#save-settings").addEventListener("click", async () => {
  const nextWorkspace = ($("#workspace-setting") as HTMLInputElement).value.trim();
  if (!nextWorkspace) return;
  const nameInput = $("#assistant-name-setting") as HTMLInputElement;
  const nextAssistantName = nameInput.value.trim();
  if (!/^[A-Za-z]{2,20}$/.test(nextAssistantName)) {
    nameInput.setCustomValidity("Use 2–20 English letters, without spaces.");
    nameInput.reportValidity();
    nameInput.addEventListener("input", () => nameInput.setCustomValidity(""), { once: true });
    return;
  }
  const nextProfile: AssistantProfile = {
    assistantName: nextAssistantName,
    userName: ($("#user-name-setting") as HTMLInputElement).value.trim(),
    instructions: ($("#assistant-instructions-setting") as HTMLTextAreaElement).value.trim(),
  };
  const nameChanged = nextAssistantName !== assistantName;
  const profileChanged = JSON.stringify(nextProfile) !== assistantContext();
  if (profileChanged) {
    try {
      assistantProfile = currentWindow
        ? await invoke<AssistantProfile>("set_assistant_profile", { profile: nextProfile })
        : nextProfile;
      applyAssistantName(assistantProfile.assistantName);
      $("#assistant-profile-status").textContent = "";
    } catch (error) {
      $("#assistant-profile-status").textContent = `Could not save assistant profile: ${String(error)}`;
      return;
    }
  }
  const selectedPermission = document.querySelector<HTMLInputElement>(
    'input[name="permission-mode"]:checked',
  )?.value as PermissionMode | undefined;
  const selectedProvider = document.querySelector<HTMLInputElement>('input[name="provider"]:checked')?.value as Provider | undefined;
  const nextProvider = selectedProvider ?? provider;
  const nextPermission = selectedPermission ?? permissionMode;
  const nextCodexModel = validOption(($("#codex-model") as HTMLSelectElement).value, codexModels, codexModel);
  const nextCodexVoice = validOption(($("#codex-voice") as HTMLSelectElement).value, CODEX_VOICES, codexVoice);
  const nextApiTextModel = validOption(($("#api-text-model") as HTMLSelectElement).value, API_TEXT_MODELS, apiTextModel);
  const nextApiVoiceModel = validOption(($("#api-voice-model") as HTMLSelectElement).value, API_VOICE_MODELS, apiVoiceModel);
  const nextApiVoice = validOption(($("#api-voice") as HTMLSelectElement).value, API_VOICES, apiVoice);
  const nextClaudeModel = validOption(($("#claude-model") as HTMLSelectElement).value, CLAUDE_MODELS, claudeModel);
  const nextClaudeVoice = validOption(($("#claude-voice") as HTMLSelectElement).value, CLAUDE_VOICES, claudeVoice);
  const restartCodex = nextPermission !== permissionMode || nextCodexModel !== codexModel || profileChanged;
  const restartVoice = nextProvider !== provider || nextCodexVoice !== codexVoice ||
    nextApiVoiceModel !== apiVoiceModel || nextApiVoice !== apiVoice ||
    nextClaudeModel !== claudeModel || nextClaudeVoice !== claudeVoice || restartCodex;
  if (restartVoice && (state.directVoice?.voiceActive || peer || claudeVoiceActive)) {
    try { await stopDirectVoice(); } catch { cleanupPeer(); }
    if (!nameChanged) await armWakeListener();
  }
  if (restartCodex) {
    state.manualStop = true;
    try { await invoke("stop_all"); } catch { /* no active runtime */ }
    await invoke("shutdown");
    state.session = null;
    state.directVoice = null;
    setMode("ready");
    if (!nameChanged) await armWakeListener();
  }
  provider = nextProvider;
  permissionMode = nextPermission;
  codexModel = nextCodexModel;
  codexVoice = nextCodexVoice;
  apiTextModel = nextApiTextModel;
  apiVoiceModel = nextApiVoiceModel;
  apiVoice = nextApiVoice;
  claudeModel = nextClaudeModel;
  claudeVoice = nextClaudeVoice;
  localStorage.setItem(PROVIDER_KEY, provider);
  localStorage.setItem(PERMISSION_KEY, permissionMode);
  localStorage.setItem(CODEX_MODEL_KEY, codexModel);
  localStorage.setItem(CODEX_VOICE_KEY, codexVoice);
  localStorage.setItem(API_TEXT_MODEL_KEY, apiTextModel);
  localStorage.setItem(API_VOICE_MODEL_KEY, apiVoiceModel);
  localStorage.setItem(API_VOICE_KEY, apiVoice);
  localStorage.setItem(CLAUDE_MODEL_KEY, claudeModel);
  localStorage.setItem(CLAUDE_VOICE_KEY, claudeVoice);
  committedAvatar = avatarSettingsFromForm(settings);
  writeAvatarSettings(committedAvatar);
  avatarPersist = true;
  if (nameChanged && currentWindow) {
    await invoke("disarm_wake_listener");
    await armWakeListener();
  }
  if (nextWorkspace !== workspace) {
    localStorage.setItem(WORKSPACE_KEY, nextWorkspace);
    response.textContent = "Workspace saved. Restart the app for it to take effect.";
  } else {
    response.textContent = profileChanged
      ? `${assistantName}'s profile is saved for voice and text. Say “${wakePhrase()}” to wake me.`
      : "Settings saved. Model changes apply to the next request; voice changes apply to a new session.";
  }
  syncPermissionControls();
  settings.close();
  if (restartCodex) void checkCodexSignIn(true);
});
for (const [selector, approved] of [["#approve", true], ["#deny", false]] as const) {
  $(selector).addEventListener("click", async () => { await invoke("resolve_server_request", { requestId: approvalId, approved }); approval.close(); });
}

if (currentWindow) {
  try {
    assistantProfile = await invoke<AssistantProfile>("get_assistant_profile");
    applyAssistantName(assistantProfile.assistantName);
    workspace = localStorage.getItem(WORKSPACE_KEY)
      ?? await invoke<string>("default_workspace");
    localStorage.setItem(WORKSPACE_KEY, workspace);
    $("#thread-id").textContent = "Not started";
    $("#workspace").textContent = workspace;
    ($("#workspace-setting") as HTMLInputElement).value = workspace;
    syncPermissionControls();
    setWorker("orchestrator", "Wake word starting");
    setMode("ready");
    const backgroundStart = await invoke<boolean>("startup_is_background");
    void checkCodexSignIn(!backgroundStart);
    if (!backgroundStart) {
      const microphoneAuthorization = await invoke<string>("request_microphone_permission");
      if (microphoneAuthorization !== "authorized") {
        setMode("degraded");
        banner.hidden = false;
        $("#degraded-copy").textContent =
          "Allow Mark Codex to use the microphone in System Settings → Privacy & Security → Microphone.";
      }
    }
    await armWakeListener();
    updateVoiceInfo(await invoke<DirectVoice>("direct_voice_status"));
    if (await invoke<boolean>("consume_cold_wake")) {
      transcript.textContent = `“${wakePhrase()}”`;
    }
  } catch (error) { setMode("stopped"); response.textContent = `Startup failed: ${String(error)}`; }
} else {
  workspace = "Visual preview · native systems disconnected";
  $("#thread-id").textContent = "Preview only";
  $("#workspace").textContent = workspace;
  ($("#workspace-setting") as HTMLInputElement).value = workspace;
  $("#wake-auth").textContent = "Preview · not connected";
  $("#voice-auth").textContent = "Preview · not connected";
  transcript.textContent = visualPreviewMode === "stopped" ? '“Stop”' : `“${wakePhrase()}”`;
  response.textContent = visualPreviewMode === "voice-starting"
    ? `Assembling the ${assistantName} core…`
    : visualPreviewMode === "working"
      ? "Codex is working on your task."
      : visualPreviewMode === "speaking"
        ? "Voice output is active."
        : visualPreviewMode === "stopped"
          ? "All tasks stopped. Waiting for the next wake phrase."
          : `${assistantName} visual preview is ready.`;
  setMode(visualPreviewMode);
  if (["acknowledge", "approval", "complete", "error"].includes(previewActionValue ?? "")) {
    window.setTimeout(() => triggerCharacterAction(previewActionValue as CharacterAction, 1800), 180);
  }
  setWorker("orchestrator", visualPreviewMode === "working" ? "Codex working" : "Visual preview");
  if (visualPreviewMode === "working") {
    setWorker("developer", "Working");
  }
}

async function armWakeListener() {
  try {
    state.wake = await invoke<WakeStatus>("arm_wake_listener");
    $("#wake-auth").textContent = state.wake.ready ? "Local listener ready" : state.wake.authorization;
    if (["denied", "restricted"].includes(state.wake.authorization)) {
      setMode("degraded");
      banner.hidden = false;
      $("#degraded-copy").textContent = "Allow microphone and speech recognition access in System Settings → Privacy & Security.";
    }
  } catch (error) {
    $("#wake-auth").textContent = String(error);
  }
}
