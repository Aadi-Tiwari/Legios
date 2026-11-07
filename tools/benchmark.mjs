// Measures accuracy and explorer quality. Runs the live AI explorers several times on the buggy app
// (three planted bugs) and on a hand-fixed healthy control (no planted bugs), plus runs on the AI-built
// app nobody planted bugs in. Reports bugs confirmed, false alarms, how many users reached their goal,
// wasted (rejected) actions, time, and measured API cost for hosted models.
// node tools/benchmark.mjs --runs=3 [--unplanted=1] [--port=4120]
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runCrowd } from "../lib/crowd.mjs";
import { loadTarget, ROOT } from "../lib/config.mjs";
import { MODEL_LABEL, PROVIDER, USAGE, usageCost } from "../lib/llm.mjs";

const arg = (k, d) => Number(process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d);
const runs = arg("runs", 3), unplanted = arg("unplanted", 1), port = arg("port", 4120);
const PLANTED = { data_leak: "Data leak (other user reads private note)", crash: "Search crash", false_success: 'False "Saved!" on edit' };
const outDir = join(ROOT, "runs", `benchmark-${PROVIDER}-` + new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(outDir, { recursive: true });

const results = { model: MODEL_LABEL, runsPerApp: runs, buggy: [], healthy: [], unplanted: [] };
const plan = [...Array(runs).fill(["buggy", "notely"]), ...Array(runs).fill(["healthy", "notely-healthy"]), ...Array(unplanted).fill(["unplanted", "promptbuilt"])];
for (const [i, [key, id]] of plan.entries()) {
  const target = await loadTarget(id);
  const started = Date.now();
  const { findings, records } = await runCrowd({ target, port, runDir: join(outDir, `${key}-${i + 1}`), headed: false, remember: false, reflect: false });
  const row = {
    seconds: Math.round((Date.now() - started) / 1000),
    confirmed: findings.filter((f) => f.status === "confirmed").map((f) => ({ kind: f.kind, title: f.title, discovery: f.evidence.discovery })),
    uncertain: findings.filter((f) => f.status !== "confirmed").map((f) => ({ kind: f.kind, title: f.title })),
    users: records.length,
    goalReached: records.filter((r) => r.goalStatus === "model_stopped").length,
    stuck: records.filter((r) => r.goalStatus === "blocked").length,
    stepLimit: records.filter((r) => r.goalStatus === "step_limit").length,
    steps: records.reduce((n, r) => n + r.steps.length, 0),
    rejected: records.reduce((n, r) => n + (r.rejected || 0), 0),
  };
  results[key].push(row);
  console.log(`${key} run ${results[key].length}: ${row.seconds}s, confirmed: ${row.confirmed.map((f) => f.kind).join(", ") || "none"}; users reached goal ${row.goalReached}/${row.users}, stuck ${row.stuck}; rejected actions ${row.rejected}/${row.steps + row.rejected}`);
}
results.usage = { ...USAGE, dollars: usageCost() };

const all = [...results.buggy, ...results.healthy, ...results.unplanted];
const sum = (k) => all.reduce((n, r) => n + r[k], 0);
const lines = [`# Legios benchmark: ${MODEL_LABEL}`, ``, `${runs} runs of 4 live AI users on each app${unplanted ? `, plus ${unplanted} on the AI-built app` : ""}. Every number below comes from these runs.`, ``,
  `## Buggy app (3 planted bugs)`, ``, `| Planted bug | Confirmed in |`, `| --- | --- |`];
for (const [kind, label] of Object.entries(PLANTED)) lines.push(`| ${label} | ${results.buggy.filter((r) => r.confirmed.some((f) => f.kind === kind)).length} of ${runs} runs |`);
lines.push(``, `All three bugs confirmed in the same run: ${results.buggy.filter((r) => Object.keys(PLANTED).every((k) => r.confirmed.some((f) => f.kind === k))).length} of ${runs}.`,
  ``, `## Healthy control (same app, bugs fixed by hand)`, ``, `Confirmed findings (false alarms): ${results.healthy.reduce((n, r) => n + r.confirmed.length, 0)} across ${runs} runs.`,
  ...(unplanted ? [``, `## AI-built app (no planted bugs)`, ``, `Confirmed findings: ${results.unplanted.map((r) => r.confirmed.length).join(", ")} (${results.unplanted.map((r) => r.confirmed.map((f) => f.kind).join("+") || "none").join("; ")}).`] : []),
  ``, `## Explorer quality (all runs)`, ``,
  `| Measure | Value |`, `| --- | --- |`,
  `| Users who said their goal was done | ${sum("goalReached")} of ${sum("users")} |`,
  `| Users stopped after repeated invalid actions | ${sum("stuck")} of ${sum("users")} |`,
  `| Users who hit the step limit | ${sum("stepLimit")} of ${sum("users")} |`,
  `| Rejected (wasted) actions | ${sum("rejected")} of ${sum("steps") + sum("rejected")} |`,
  `| Average seconds per run | ${Math.round(sum("seconds") / all.length)} |`,
  `| Model calls | ${USAGE.calls || "local"} |`,
  `| Measured API cost | ${usageCost() === null ? "none (local model)" : `$${usageCost().toFixed(2)} (${USAGE.inputTokens} input, ${USAGE.outputTokens} output tokens)`} |`);
await writeFile(join(outDir, "results.json"), JSON.stringify(results, null, 2));
await writeFile(join(outDir, "RESULTS.md"), lines.join("\n") + "\n");
console.log("\n" + lines.join("\n") + `\n\nSaved: ${outDir}`);
