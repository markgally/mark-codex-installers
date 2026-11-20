export class VoiceIdleTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private readonly idleMs: number;
  private readonly isBusy: () => boolean;
  private readonly onIdle: () => void;
  private readonly retryMs: number;
  private readonly schedule: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  private readonly cancel: (timer: ReturnType<typeof setTimeout>) => void;

  constructor(
    idleMs: number,
    isBusy: () => boolean,
    onIdle: () => void,
    retryMs = 1_000,
    schedule = (callback: () => void, delay: number) => globalThis.setTimeout(callback, delay),
    cancel = (timer: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(timer),
  ) {
    this.idleMs = idleMs;
    this.isBusy = isBusy;
    this.onIdle = onIdle;
    this.retryMs = retryMs;
    this.schedule = schedule;
    this.cancel = cancel;
  }

  start() {
    this.active = true;
    this.activity();
  }

  activity() {
    if (!this.active) return;
    this.arm(this.idleMs);
  }

  stop() {
    this.active = false;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
  }

  private arm(delay: number) {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = this.schedule(() => {
      this.timer = null;
      if (!this.active) return;
      if (this.isBusy()) {
        this.arm(this.retryMs);
        return;
      }
      this.stop();
      this.onIdle();
    }, delay);
  }
}
