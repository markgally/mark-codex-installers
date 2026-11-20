import assert from "node:assert/strict";
import test from "node:test";
import { cancelAssembly, replayAssembly } from "../src/avatar/assembly.ts";
import { startBlinking } from "../src/avatar/blink.ts";

function classList() {
  const values = new Set();
  return {
    add: (name) => values.add(name),
    remove: (name) => values.delete(name),
    contains: (name) => values.has(name),
  };
}

function setup(t) {
  let now = 0;
  let nextId = 1;
  const callbacks = new Map();
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  globalThis.window = {
    setTimeout(callback, delay) {
      const id = nextId++;
      callbacks.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id) { callbacks.delete(id); },
  };
  globalThis.document = { hidden: false };
  t.after(() => {
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
  });
  const avatar = { classList: classList() };
  const shell = { classList: classList(), offsetWidth: 480, avatar,
    querySelector() { return this.avatar; } };
  return {
    shell, avatar,
    tick(duration) {
      const end = now + duration;
      while (true) {
        const entry = [...callbacks].sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry || entry[1].at > end) break;
        now = entry[1].at;
        callbacks.delete(entry[0]);
        entry[1].callback();
      }
      now = end;
    },
  };
}

test("saving a portrait lets assembly finish and blinking resume without reopening Settings", (t) => {
  const { shell, avatar, tick } = setup(t);
  startBlinking(shell, () => "ready");
  replayAssembly(shell);
  tick(1200);
  assert.equal(avatar.classList.contains("is-blinking"), false);
  tick(2600);
  assert.equal(shell.classList.contains("is-forming"), false);
  tick(3400);
  assert.equal(avatar.classList.contains("is-blinking"), true);
  tick(120);
  assert.equal(avatar.classList.contains("is-blinking"), false);
});

test("a repeated wake or portrait selection gets its full assembly duration", (t) => {
  const { shell, tick } = setup(t);
  replayAssembly(shell);
  tick(3000);
  replayAssembly(shell);
  tick(800);
  assert.equal(shell.classList.contains("is-forming"), true);
  tick(3000);
  assert.equal(shell.classList.contains("is-forming"), false);
});

test("assembly completes when there are no particle or CSS completion events", (t) => {
  const { shell, tick } = setup(t);
  replayAssembly(shell);
  tick(3800);
  assert.equal(shell.classList.contains("is-forming"), false);
});

test("cancelling a Settings preview clears its assembly state", (t) => {
  const { shell, tick } = setup(t);
  replayAssembly(shell);
  cancelAssembly(shell);
  assert.equal(shell.classList.contains("is-forming"), false);
  tick(4000);
  assert.equal(shell.classList.contains("is-forming"), false);
});

test("the blink loop follows the portrait mounted after switching characters", (t) => {
  const { shell, avatar, tick } = setup(t);
  startBlinking(shell, () => "listening");
  const nextAvatar = { classList: classList() };
  shell.avatar = nextAvatar;
  tick(1200);
  assert.equal(avatar.classList.contains("is-blinking"), false);
  assert.equal(nextAvatar.classList.contains("is-blinking"), true);
  tick(120);
  assert.equal(nextAvatar.classList.contains("is-blinking"), false);
});
