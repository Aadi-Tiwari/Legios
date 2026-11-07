// Proves the exported regression tests are meaningful: each must FAIL on the original app and
// PASS on the fully fixed app from the same run.
// node tools/check-regression-tests.mjs <runDir>
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadTarget } from "../lib/config.mjs";
import { startTarget } from "../lib/target.mjs";

const runDir = resolve(process.argv[2]);
const state = JSON.parse(await readFile(join(runDir, "state.json"), "utf8"));
const target = await loadTarget(state.app.id);
if (!state.latestFixed) throw new Error("This run has no verified fixes yet");
const tests = JSON.parse(await readFile(join(runDir, "regression-tests", "index.json"), "utf8"));

const results = [];
for (const [label, dir, expect] of [["original app", target.appDir, "FAIL"], ["fixed app", state.latestFixed, "PASS"]]) {
  for (const t of tests) {
    const app = await startTarget(target, dir, 4150);
    const r = spawnSync(process.execPath, [t.file, app.url], { encoding: "utf8", timeout: 120_000 });
    await app.stop();
    const got = /^PASS/m.test(r.stdout) ? "PASS" : "FAIL";
    results.push({ test: t.kind, on: label, got, expect, ok: got === expect, detail: r.stdout.trim().split("\n").pop() });
    console.log(`${got === expect ? "OK  " : "BAD "} ${t.kind} on ${label}: ${got} (expected ${expect}) | ${r.stdout.trim().split("\n").pop()}`);
  }
}
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
