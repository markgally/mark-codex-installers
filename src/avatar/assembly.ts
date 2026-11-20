export const ASSEMBLY_DURATION_MS = 3200;

// The helmet's last armor shard starts 560 ms after the main animation.
const ASSEMBLY_SETTLE_MS = 600;
const pending = new WeakMap<HTMLElement, number>();

export function cancelAssembly(shell: HTMLElement): void {
  const timer = pending.get(shell);
  if (timer !== undefined) window.clearTimeout(timer);
  pending.delete(shell);
  shell.classList.remove("is-forming");
}

export function replayAssembly(shell: HTMLElement): void {
  cancelAssembly(shell);
  void shell.offsetWidth;
  shell.classList.add("is-forming");
  // A bounded completion also works when particles are disabled, an image is
  // unavailable, or a WebView does not dispatch a CSS animationend event.
  const timer = window.setTimeout(() => {
    if (pending.get(shell) !== timer) return;
    pending.delete(shell);
    shell.classList.remove("is-forming");
  }, ASSEMBLY_DURATION_MS + ASSEMBLY_SETTLE_MS);
  pending.set(shell, timer);
}
