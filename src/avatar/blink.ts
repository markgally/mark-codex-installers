/**
 * Closed-eye blink for the portrait avatars.
 * The helmet has no portrait, so the timer does nothing until one is mounted.
 */

const LISTENING = new Set(["listening", "voice-starting", "speaking"]);
const BLINK_MS = 120;

function intervalFor(mode: string): number {
  if (LISTENING.has(mode)) return 3500;
  if (mode === "working") return 9000;
  return 6000;
}

export function startBlinking(shell: HTMLElement, mode: () => string): void {
  const blink = () => {
    const avatar = shell.querySelector<SVGSVGElement>(".holo-avatar");
    if (avatar && !shell.classList.contains("is-forming") && !document.hidden) {
      avatar.classList.add("is-blinking");
      window.setTimeout(() => avatar.classList.remove("is-blinking"), BLINK_MS);
    }
    window.setTimeout(blink, intervalFor(mode()));
  };
  window.setTimeout(blink, 1200);
}
