import assert from "node:assert/strict";
import test from "node:test";
import { VoiceIdleTimer } from "../src/voice-idle.ts";

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const scheduled = new Map();
  return {
    schedule(callback, delay) {
      const id = nextId++;
      scheduled.set(id, { at: now + delay, callback });
      return id;
    },
    cancel(id) { scheduled.delete(id); },
    tick(duration) {
      const end = now + duration;
      while (true) {
        const next = [...scheduled].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at;
        scheduled.delete(next[0]);
        next[1].callback();
      }
      now = end;
    },
  };
}

test("voice sleeps once after sixty seconds of inactivity", () => {
  const clock = fakeClock();
  let sleeps = 0;
  const idle = new VoiceIdleTimer(60_000, () => false, () => sleeps++, 1_000, clock.schedule, clock.cancel);
  idle.start();
  clock.tick(59_999);
  assert.equal(sleeps, 0);
  clock.tick(1);
  assert.equal(sleeps, 1);
  clock.tick(60_000);
  assert.equal(sleeps, 1);
});

test("speech or playback activity resets the idle deadline", () => {
  const clock = fakeClock();
  let sleeps = 0;
  const idle = new VoiceIdleTimer(60_000, () => false, () => sleeps++, 1_000, clock.schedule, clock.cancel);
  idle.start();
  clock.tick(45_000);
  idle.activity();
  clock.tick(59_999);
  assert.equal(sleeps, 0);
  clock.tick(1);
  assert.equal(sleeps, 1);
});

test("active work defers sleep until it is finished", () => {
  const clock = fakeClock();
  let busy = true;
  let sleeps = 0;
  const idle = new VoiceIdleTimer(60_000, () => busy, () => sleeps++, 1_000, clock.schedule, clock.cancel);
  idle.start();
  clock.tick(120_000);
  assert.equal(sleeps, 0);
  busy = false;
  clock.tick(1_000);
  assert.equal(sleeps, 1);
});

test("stopping voice cancels the idle timer", () => {
  const clock = fakeClock();
  let sleeps = 0;
  const idle = new VoiceIdleTimer(60_000, () => false, () => sleeps++, 1_000, clock.schedule, clock.cancel);
  idle.start();
  clock.tick(5_000);
  idle.stop();
  clock.tick(120_000);
  assert.equal(sleeps, 0);
});

test("default scheduler calls timer methods on their host", () => {
  const originalSchedule = globalThis.setTimeout;
  const originalCancel = globalThis.clearTimeout;
  const host = globalThis;
  let scheduled = false;
  let canceled = false;
  try {
    globalThis.setTimeout = function () {
      assert.equal(this, host);
      scheduled = true;
      return 123;
    };
    globalThis.clearTimeout = function (timer) {
      assert.equal(this, host);
      assert.equal(timer, 123);
      canceled = true;
    };
    const idle = new VoiceIdleTimer(60_000, () => false, () => {});
    idle.start();
    idle.stop();
    assert.equal(scheduled, true);
    assert.equal(canceled, true);
  } finally {
    globalThis.setTimeout = originalSchedule;
    globalThis.clearTimeout = originalCancel;
  }
});
