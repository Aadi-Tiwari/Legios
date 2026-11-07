// Seeds and tests the cached-fix fallback.
//   node tools/fix-cache.mjs seed <runDir>   save every verified fix from a run into fix-cache/
//   node tools/fix-cache.mjs test <runDir>   for each finding in the run, apply its cached fix to the original
//                                            app (no Codex) and verify it live by replay
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadTarget } from "../lib/config.mjs";
import { saveVerifiedFix, loadVerifiedFix, applyCachedFix } from "../lib/fixcache.mjs";
import { verifyFinding } from "../lib/replay.mjs";

const [mode, dir] = process.argv.slice(2);
const runDir = resolve(dir);
const state = JSON.parse(await readFile(join(runDir, "state.json"), "utf8"));
const records = JSON.parse(await readFile(join(runDir, "recording.json"), "utf8")).records;
const target = await loadTarget(state.app.id);

if (mode === "seed") {
  for (const f of state.findings) {
    const fix = state.fixes?.[f.signature];
    if (fix?.status === "fixed" && fix.diff && !fix.cached) { await saveVerifiedFix(target, f, fix); console.log(`saved: ${f.kind} (${f.title})`); }
  }
} else {
  let ok = 0;
  for (const [i, f] of state.findings.entries()) {
    const cached = await loadVerifiedFix(target, f);
    if (!cached) { console.log(`no cache: ${f.kind}`); continue; }
    const candidateDir = join(tmpdir(), `legios-cachetest-${Date.now()}-${i}`);
    try {
      await applyCachedFix({ target, baseDir: target.appDir, candidateDir, cached });
      const v = await verifyFinding({ target, appDir: candidateDir, port: 4160 + i, records, finding: f });
      console.log(`${v.status === "fixed" ? "PASS" : "FAIL"}  ${f.kind}: cached patch applied to the original app, live verification says "${v.status}"`);
      if (v.status === "fixed") ok++;
    } catch (error) { console.log(`FAIL  ${f.kind}: ${error.message}`); }
  }
  console.log(`${ok} of ${state.findings.length} cached fixes verified live`);
}
