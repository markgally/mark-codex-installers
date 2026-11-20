import { characterMarkup } from "./characters";
export { cancelAssembly, replayAssembly } from "./assembly";
import {
  DEFAULT_AVATAR_SETTINGS,
  isAppearance,
  isMaskStyle,
  type AvatarSettings,
} from "./types";

export const APPEARANCE_KEY = "jarvis.appearance";
export const MASK_STYLE_KEY = "jarvis.maskStyle";
export const EFFECT_PARTICLES_KEY = "jarvis.effectParticles";
export const EFFECT_TALKING_MASK_KEY = "jarvis.effectTalkingMask";
export const EFFECT_EYE_TRACK_KEY = "jarvis.effectEyeTrack";
export const EFFECT_SCAN_KEY = "jarvis.effectScan";

function storedFlag(key: string, fallback: boolean): boolean {
  const value = localStorage.getItem(key);
  if (value === "0") return false;
  if (value === "1") return true;
  return fallback;
}

/** Saved appearance. A preview URL may override the avatar without writing storage. */
export function readAvatarSettings(override?: URLSearchParams | null): AvatarSettings {
  const appearance = localStorage.getItem(APPEARANCE_KEY);
  const maskStyle = localStorage.getItem(MASK_STYLE_KEY);
  const settings: AvatarSettings = {
    appearance: isAppearance(appearance) ? appearance : DEFAULT_AVATAR_SETTINGS.appearance,
    maskStyle: isMaskStyle(maskStyle) ? maskStyle : DEFAULT_AVATAR_SETTINGS.maskStyle,
    effects: {
      particles: storedFlag(EFFECT_PARTICLES_KEY, true),
      talkingMask: storedFlag(EFFECT_TALKING_MASK_KEY, true),
      eyeTrack: storedFlag(EFFECT_EYE_TRACK_KEY, true),
      scanGlow: storedFlag(EFFECT_SCAN_KEY, true),
    },
  };
  const previewAppearance = override?.get("appearance");
  if (isAppearance(previewAppearance)) settings.appearance = previewAppearance;
  return settings;
}

export function writeAvatarSettings(settings: AvatarSettings): void {
  localStorage.setItem(APPEARANCE_KEY, settings.appearance);
  localStorage.setItem(MASK_STYLE_KEY, settings.maskStyle);
  localStorage.setItem(EFFECT_PARTICLES_KEY, settings.effects.particles ? "1" : "0");
  localStorage.setItem(EFFECT_TALKING_MASK_KEY, settings.effects.talkingMask ? "1" : "0");
  localStorage.setItem(EFFECT_EYE_TRACK_KEY, settings.effects.eyeTrack ? "1" : "0");
  localStorage.setItem(EFFECT_SCAN_KEY, settings.effects.scanGlow ? "1" : "0");
}

export function avatarSettingsFromForm(root: ParentNode): AvatarSettings {
  const appearance = root.querySelector<HTMLInputElement>('input[name="appearance"]:checked')?.value;
  const maskStyle = root.querySelector<HTMLInputElement>('input[name="mask-style"]:checked')?.value;
  const checked = (id: string) => (root.querySelector<HTMLInputElement>(`#${id}`)?.checked ?? true);
  return {
    appearance: isAppearance(appearance) ? appearance : "helmet",
    maskStyle: isMaskStyle(maskStyle) ? maskStyle : "segmented",
    effects: {
      particles: checked("effect-particles"),
      talkingMask: checked("effect-talking-mask"),
      eyeTrack: checked("effect-eye-track"),
      scanGlow: checked("effect-scan"),
    },
  };
}

export function syncAvatarForm(root: ParentNode, settings: AvatarSettings): void {
  const appearance = root.querySelector<HTMLInputElement>(`input[name="appearance"][value="${settings.appearance}"]`);
  const maskStyle = root.querySelector<HTMLInputElement>(`input[name="mask-style"][value="${settings.maskStyle}"]`);
  if (appearance) appearance.checked = true;
  if (maskStyle) maskStyle.checked = true;
  const flags: Array<[string, boolean]> = [
    ["effect-particles", settings.effects.particles],
    ["effect-talking-mask", settings.effects.talkingMask],
    ["effect-eye-track", settings.effects.eyeTrack],
    ["effect-scan", settings.effects.scanGlow],
  ];
  for (const [id, enabled] of flags) {
    const input = root.querySelector<HTMLInputElement>(`#${id}`);
    if (input) input.checked = enabled;
  }
}

function flag(enabled: boolean): "on" | "off" {
  return enabled ? "on" : "off";
}

/**
 * Apply appearance attributes and mount the SVG when needed.
 * Returns true only when the avatar kind changed after the first paint.
 */
export function applyAvatar(shell: HTMLElement, rig: HTMLElement, settings: AvatarSettings): boolean {
  const previous = shell.dataset.appearance;
  const appearanceChanged = previous !== undefined && previous !== settings.appearance;
  shell.dataset.appearance = settings.appearance;
  shell.dataset.mask = settings.maskStyle;
  shell.dataset.effectParticles = flag(settings.effects.particles);
  shell.dataset.effectTalkingMask = flag(settings.effects.talkingMask);
  shell.dataset.effectEyeTrack = flag(settings.effects.eyeTrack);
  shell.dataset.effectScan = flag(settings.effects.scanGlow);
  if (!settings.effects.eyeTrack || settings.appearance === "helmet") {
    rig.style.setProperty("--look-x", "0");
    rig.style.setProperty("--look-y", "0");
  }

  const mounted = rig.querySelector<SVGSVGElement>(".holo-avatar");
  if (settings.appearance === "helmet") {
    mounted?.remove();
  } else if (!mounted || mounted.dataset.kind !== settings.appearance) {
    mounted?.remove();
    rig.insertAdjacentHTML("beforeend", characterMarkup(settings.appearance));
  }
  return appearanceChanged;
}

/** Subtle whole-portrait tilt. Photo eyes stay still. The rig still receives the drag gesture. */
export function bindEyeTracking(rig: HTMLElement, shell: HTMLElement): void {
  rig.addEventListener("pointermove", (event) => {
    if (shell.dataset.appearance === "helmet" || shell.dataset.effectEyeTrack === "off") {
      rig.style.setProperty("--look-x", "0");
      rig.style.setProperty("--look-y", "0");
      return;
    }
    const bounds = rig.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / Math.max(1, bounds.width) - 0.5;
    const y = (event.clientY - bounds.top) / Math.max(1, bounds.height) - 0.5;
    rig.style.setProperty("--look-x", (Math.max(-1, Math.min(1, x)) * 1.6).toFixed(2));
    rig.style.setProperty("--look-y", (Math.max(-1, Math.min(1, y)) * 1.1).toFixed(2));
  });
  rig.addEventListener("pointerleave", () => {
    rig.style.setProperty("--look-x", "0");
    rig.style.setProperty("--look-y", "0");
  });
}
