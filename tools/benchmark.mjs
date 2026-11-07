// Measures accuracy. Runs the live AI explorers several times on the buggy app (three planted bugs)
// and on a hand-fixed healthy control (no planted bugs), then reports how often each bug was
// confirmed and how many confirmed findings appeared on the healthy app (false alarms).
// node tools/benchmark.mjs --runs=3
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runCrowd } from "../lib/crowd.mjs";
import { loadTarget, ROOT } from "../lib/config.mjs";
import { MODEL } from "../lib/llm.mjs";

const runs = Number(process.argv.find((a) => a.startsWith("--runs="))?.slice(7) || 3);
const PLANTED = { data_leak: "Data leak (other user reads private note)", crash: "Search crash", false_success: 'False "Saved!" on edit' };
const outDir = join(ROOT, "runs", "benchmark-" + new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(outDir, { recursive: true });

const results = { model: MODEL, runsPerApp: runs, buggy: [], healthy: [] };
for (const [key, id] of [["buggy", "notely"], ["healthy", "notely-healthy"]]) {
  const target = await loadTarget(id);
  for (let i = 1; i <= runs; i++) {
    const started = Date.now();
    const { findings } = await runCrowd({ target, port: 4120, runDir: join(outDir, `${key}-${i}`), headed: false, remember: false, reflect: false });
    const row = {
      seconds: Math.round((Date.now() - started) / 1000),
      confirmed: findings.filter((f) => f.status === "confirmed").map((f) => ({ kind: f.kind, title: f.title, discovery: f.evidence.discovery })),
      uncertain: findings.filter((f) => f.status !== "confirmed").map((f) => ({ kind: f.kind, title: f.title })),
    };
    results[key].push(row);
    console.log(`${key} run ${i}: ${row.seconds}s, confirmed: ${row.confirmed.map((f) => f.kind).join(", ") || "none"}; uncertain: ${row.uncertain.length}`);
  }
}

const lines = [`# Legios accuracy benchmark`, ``, `Model: ${MODEL} (local). ${runs} runs of 4 live AI users on each app. Every number below comes from these runs.`, ``,
  `## Buggy app (3 planted bugs)`, ``, `| Planted bug | Confirmed in | `, `| --- | --- |`];
for (const [kind, label] of Object.entries(PLANTED)) lines.push(`| ${label} | ${results.buggy.filter((r) => r.confirmed.some((f) => f.kind === kind)).length} of ${runs} runs |`);
const allThree = results.buggy.filter((r) => Object.keys(PLANTED).every((k) => r.confirmed.some((f) => f.kind === k))).length;
const fp = results.healthy.reduce((n, r) => n + r.confirmed.length, 0);
lines.push(``, `All three bugs confirmed in the same run: ${allThree} of ${runs}.`, ``, `## Healthy control (same app, bugs fixed by hand)`, ``,
  `Confirmed findings (false alarms): ${fp} across ${runs} runs. Uncertain observations: ${results.healthy.reduce((n, r) => n + r.uncertain.length, 0)}.`);
const extra = results.buggy.flatMap((r) => r.confirmed.filter((f) => !PLANTED[f.kind]));
if (extra.length) lines.push(``, `Other confirmed findings on the buggy app: ${extra.map((f) => f.title).join("; ")}`);
await writeFile(join(outDir, "results.json"), JSON.stringify(results, null, 2));
await writeFile(join(outDir, "RESULTS.md"), lines.join("\n") + "\n");
console.log("\n" + lines.join("\n") + `\n\nSaved: ${outDir}`);
