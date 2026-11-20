/**
 * Talking mask.
 * Speech is not lip-synced. The existing audio meter (`state.level`) brightens
 * the center of the mask first, then the outer segments follow a short ripple.
 * Idle breathing stays in CSS until a live mode takes over.
 */

const LIVE_MODES = new Set(["listening", "voice-starting", "speaking", "working", "stopped"]);

function clearDriven(avatar: SVGSVGElement): void {
  avatar.classList.remove("mask-driven");
  avatar.querySelectorAll<SVGElement>(".mask-bar, .eq-bar").forEach((bar) => {
    bar.style.opacity = "";
    bar.style.transform = "";
  });
}

function energyFor(mode: string, level: number, now: number): number {
  if (mode === "speaking") return 0.3 + Math.max(0, Math.min(1, level)) * 0.7;
  if (mode === "working") return 0.38 + Math.max(0, Math.min(1, level)) * 0.42 + Math.sin(now / 220) * 0.06;
  if (mode === "listening" || mode === "voice-starting") return 0.2 + Math.sin(now / 460) * 0.05;
  if (mode === "stopped") return Math.sin(now / 120) > 0.72 ? 0.85 : 0.12;
  return 0;
}

function paintBars(bars: SVGElement[], energy: number, now: number, vertical: boolean): void {
  bars.forEach((bar) => {
    const distance = Number(bar.dataset.distance ?? "0");
    const falloff = 1 - Math.min(distance, 3) * 0.16;
    const ripple = 0.55 + 0.45 * Math.sin(now / (170 - energy * 70) - distance * 0.55);
    const amount = Math.max(0.08, Math.min(1, energy * falloff * ripple));
    bar.style.opacity = String(0.22 + amount * 0.78);
    bar.style.transformBox = "fill-box";
    bar.style.transformOrigin = vertical ? "center bottom" : "center";
    bar.style.transform = vertical ? `scaleY(${0.22 + amount * 0.9})` : `scaleX(${0.94 + amount * 0.06})`;
  });
}

function paintWave(avatar: SVGSVGElement, energy: number, now: number): void {
  const wave = avatar.querySelector<SVGPathElement>(".mask-wave");
  if (!wave) return;
  const left = Number(wave.dataset.left ?? "150");
  const right = Number(wave.dataset.right ?? "330");
  const mid = Number(wave.dataset.mid ?? "370");
  const steps = 22;
  let path = "";
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const envelope = Math.sin(t * Math.PI);
    const x = left + (right - left) * t;
    const y = mid + Math.sin(t * Math.PI * 3 + now / 150) * (4 + energy * 20) * envelope;
    path += index === 0 ? `M${x.toFixed(1)} ${y.toFixed(1)}` : `L${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  wave.setAttribute("d", path);
}

function paintMask(avatar: SVGSVGElement, mode: string, level: number, now: number): void {
  if (!LIVE_MODES.has(mode)) {
    clearDriven(avatar);
    return;
  }
  const energy = energyFor(mode, level, now);
  avatar.classList.add("mask-driven");
  avatar.style.setProperty("--mask-level", energy.toFixed(3));
  paintBars([...avatar.querySelectorAll<SVGElement>(".mask-bar")], energy, now, false);
  paintBars([...avatar.querySelectorAll<SVGElement>(".eq-bar")], energy, now, true);
  paintWave(avatar, energy, now);
}

export function startTalkingMask(shell: HTMLElement, level: () => number, mode: () => string): void {
  const frame = (now: number) => {
    const avatar = shell.querySelector<SVGSVGElement>(".holo-avatar");
    if (avatar && shell.dataset.effectTalkingMask !== "off" && !document.hidden) {
      paintMask(avatar, mode(), level(), now);
    } else if (avatar) {
      clearDriven(avatar);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
