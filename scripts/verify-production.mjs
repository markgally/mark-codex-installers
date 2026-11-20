import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

const root = new URL("../dist/", import.meta.url);
const html = await readFile(new URL("index.html", root), "utf8");
assert.doesNotMatch(html, /\/src\/|localhost:1420|127\.0\.0\.1:1420/);
const entrypoints = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(m => m[1]);
assert(entrypoints.some(p => p.endsWith(".js")), "Missing production JavaScript");
assert(entrypoints.some(p => p.endsWith(".css")), "Missing production CSS");
for (const path of [...entrypoints, "/assets/jarvis-character-v2.png", "/assets/jarvis-avatar.png"]) {
  assert((await stat(new URL(path.slice(1), root))).size > 0, `Missing asset: ${path}`);
  if (path.endsWith(".js") || path.endsWith(".css")) {
    const source = await readFile(new URL(path.slice(1), root), "utf8");
    assert.doesNotMatch(source, /https?:\/\/(?:localhost|127\.0\.0\.1):1420/);
    for (const match of source.matchAll(/(?:url\(["']?|src=["'])(\/assets\/[^\s"')]+)/g)) {
      await stat(new URL(match[1].slice(1), root));
    }
  }
  console.log(`Production asset present: ${path}`);
}
console.log("Production HTML references local compiled assets; no development server reference.");
