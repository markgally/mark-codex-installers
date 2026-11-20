export const APPEARANCES = ["helmet", "cyber_boy", "cyber_girl"] as const;
export const MASK_STYLES = ["segmented", "equalizer", "waveform"] as const;

export type Appearance = (typeof APPEARANCES)[number];
export type MaskStyle = (typeof MASK_STYLES)[number];
export type CharacterKind = Exclude<Appearance, "helmet">;

export interface AvatarEffects {
  particles: boolean;
  talkingMask: boolean;
  eyeTrack: boolean;
  scanGlow: boolean;
}

/** Visual preferences. They never change provider, voice, or permission state. */
export interface AvatarSettings {
  appearance: Appearance;
  maskStyle: MaskStyle;
  effects: AvatarEffects;
}

export const DEFAULT_AVATAR_SETTINGS: AvatarSettings = {
  appearance: "helmet",
  maskStyle: "segmented",
  effects: {
    particles: true,
    talkingMask: true,
    eyeTrack: true,
    scanGlow: true,
  },
};

export function isAppearance(value: string | null | undefined): value is Appearance {
  return APPEARANCES.some((appearance) => appearance === value);
}

export function isMaskStyle(value: string | null | undefined): value is MaskStyle {
  return MASK_STYLES.some((style) => style === value);
}
