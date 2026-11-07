// Writes one self-contained HTML report for a run: findings with evidence and screenshots,
// fixes with diffs and verification checks, crowd numbers, and exported patches.
// Opens offline (screenshots embedded). Recorded passwords are never included.
// node tools/report.mjs <runDir>   ->  <runDir>/legios-report.html and <runDir>/patches/*.patch
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, basename } from "node:path";

const runDir = resolve(process.argv[2]);
const state = JSON.parse(await readFile(join(runDir, "state.json"), "utf8"));
let tests = [];
try { tests = JSON.parse(await readFile(join(runDir, "regression-tests", "index.json"), "utf8")); } catch { /* none exported */ }

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const KIND = { data_leak: "Data leak", crash: "Server error", false_success: "False success", outcome_failure: "Outcome failure" };
const shot = async (rel) => {
  if (!rel) return "";
  try { return `<img alt="Screenshot at the moment of the failure" src="data:image/jpeg;base64,${(await readFile(join(runDir, rel))).toString("base64")}">`; } catch { return ""; }
};
const diffHtml = (diff) => `<pre class="diff">${esc(diff).split("\n").map((l) => `<span class="${/^\+(?!\+\+)/.test(l) ? "add" : /^-(?!--)/.test(l) ? "del" : /^@@/.test(l) ? "hunk" : ""}">${l}</span>`).join("\n")}</pre>`;
const checks = (v) => !v?.contract?.checks?.length ? "" : `<table>${v.contract.checks.map((c) => `<tr><td class="${c.pass ? "pass" : "fail"}">${c.pass ? "PASS" : "FAIL"}</td><td>${esc(c.name)}</td><td class="dim">${esc(c.detail)}</td></tr>`).join("")}</table>`;

// Patches: one file per applied fix, in the order they were verified.
await mkdir(join(runDir, "patches"), { recursive: true });
const patches = [];
let n = 0;
for (const f of state.findings || []) {
  const fix = state.fixes?.[f.signature];
  if (!fix?.diff) continue;
  const name = `${String(++n).padStart(2, "0")}-${f.kind}.patch`;
  await writeFile(join(runDir, "patches", name), `# Legios fix for: ${f.title}\n# Verification: ${fix.status}\n${fix.diff}`);
  patches.push({ name, title: f.title, status: fix.status });
}

const sections = [];
for (const [i, f] of (state.findings || []).entries()) {
  const fix = state.fixes?.[f.signature];
  const ev = f.evidence || {};
  const test = tests.find((t) => t.finding === f.title);
  sections.push(`<section class="finding">
    <div class="tag ${esc(f.kind)}">${esc(KIND[f.kind] || f.kind)} · ${esc(f.severity || "")}</div>
    <h2>${i + 1}. ${esc(f.title)}</h2>
    <p class="status ${f.status}">${f.status === "confirmed" ? "Confirmed: it happened again when repeated" : "Uncertain: seen once, not reproduced"}${fix ? ` · Fix: <b>${esc(fix.status.replace(/_/g, " "))}</b>` : ""}</p>
    <div class="grid">
      <div><h3>Expected</h3><p>${esc(f.expected)}</p><h3>What happened</h3><p>${esc(f.observed)}</p>
        <h3>Evidence</h3><pre>${esc([ev.request && `${ev.request} -> ${ev.status}`, ev.discovery && `Found by: ${ev.discovery}`, ev.leakedText && `Private text exposed: "${ev.leakedText}"`, ev.toast && `Message shown: "${ev.toast}"`, ev.response && `Response: ${ev.response}`].filter(Boolean).join("\n"))}</pre>
        <h3>Steps to reproduce</h3><ol>${(f.steps || []).map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
        <p class="dim">${esc(f.confirmation)}</p></div>
      <div>${await shot(ev.shot)}</div>
    </div>
    ${fix ? `<h3>Fix (${esc(fix.model || "Codex CLI")}${fix.seconds ? `, ${fix.seconds}s` : ""}; based on the ${esc(fix.base || "original app")})</h3><p>${esc(fix.summary)}</p>${fix.diff ? diffHtml(fix.diff) : ""}
      <div class="grid"><div><h3>Before: original app replayed</h3>${checks(fix.before)}</div><div><h3>After: patched copy replayed</h3>${checks(fix.after)}</div></div>` : ""}
    ${test ? `<p class="dim">Regression test: <code>${esc(basename(test.file))}</code> (fails on the original app, passes after the fix)</p>` : ""}
  </section>`);
}

const c = state.crowd;
const users = Object.values(state.users || {});
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Legios report: ${esc(state.app?.name)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font: 15px/1.5 "Segoe UI", system-ui, sans-serif; color: #1c1f24; background: #f4f5f7; margin: 0; }
  header { background: #111418; color: #f2f3f5; padding: 28px 40px; }
  header h1 { margin: 0; font-size: 26px; letter-spacing: .5px; } header p { margin: 6px 0 0; color: #b9bec7; }
  main { max-width: 1100px; margin: 0 auto; padding: 24px 40px 60px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 18px 0 26px; }
  .stat { background: #fff; border-radius: 10px; padding: 14px 16px; box-shadow: 0 1px 2px rgba(0,0,0,.06); }
  .stat b { display: block; font-size: 24px; } .stat span { color: #69707d; font-size: 13px; }
  section.finding { background: #fff; border-radius: 12px; padding: 22px 26px; margin: 18px 0; box-shadow: 0 1px 3px rgba(0,0,0,.07); }
  h2 { margin: 6px 0 4px; font-size: 20px; } h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .6px; color: #69707d; margin: 16px 0 6px; }
  .tag { display: inline-block; font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 6px; background: #eef0f3; }
  .tag.data_leak { background: #fde8e8; color: #9b1c1c; } .tag.crash { background: #fff1e0; color: #8a4b00; } .tag.false_success { background: #fff8db; color: #7a5b00; }
  .status { margin: 0; color: #3b4250; } .status.confirmed { color: #0f6b3e; }
  .grid { display: grid; grid-template-columns: 1.3fr 1fr; gap: 22px; } img { max-width: 100%; border: 1px solid #e3e6ea; border-radius: 8px; }
  pre { background: #f6f7f9; border: 1px solid #e3e6ea; border-radius: 8px; padding: 10px 12px; white-space: pre-wrap; word-break: break-word; font: 12.5px/1.45 Consolas, monospace; font-variant-ligatures: none; }
  pre.diff span.add { background: #e6f6ec; color: #0f5b2e; display: block; } pre.diff span.del { background: #fdecec; color: #8f1d1d; display: block; } pre.diff span.hunk { color: #5b6ad0; display: block; }
  table { border-collapse: collapse; width: 100%; font-size: 13.5px; } td { border-bottom: 1px solid #eceef1; padding: 5px 6px; vertical-align: top; }
  td.pass { color: #0f6b3e; font-weight: 700; width: 46px; } td.fail { color: #a11d1d; font-weight: 700; width: 46px; } .dim { color: #69707d; }
  footer { color: #69707d; font-size: 13px; margin-top: 30px; }
</style></head><body>
<header><h1>Legios report: ${esc(state.app?.name)}</h1><p>${esc(state.app?.description)}${state.app?.label ? ` · ${esc(state.app.label)}` : ""}</p></header>
<main>
  <div class="stats">
    <div class="stat"><b>${users.length}</b><span>AI explorers (${esc(state.model)}, local)</span></div>
    <div class="stat"><b>${(state.findings || []).filter((f) => f.status === "confirmed").length}</b><span>confirmed findings</span></div>
    <div class="stat"><b>${Object.values(state.fixes || {}).filter((x) => ["fixed", "already_fixed"].includes(x.status)).length}</b><span>fixes verified by replay</span></div>
    ${c?.completed !== undefined ? `<div class="stat"><b>${c.completed}/${c.requested}</b><span>crowd journeys on the ${esc(c.which)} app, peak ${c.peakSimultaneous} at once, ${c.serverErrors} server errors (replayed, no AI calls)</span></div>` : ""}
    <div class="stat"><b>${state.seconds ?? "?"}s</b><span>explorer run</span></div>
  </div>
  ${sections.join("\n") || "<p>No findings in this run.</p>"}
  ${patches.length ? `<h3>Patch files</h3><ul>${patches.map((p) => `<li><code>patches/${esc(p.name)}</code>: ${esc(p.title)} (${esc(p.status)})</li>`).join("")}</ul>` : ""}
  <footer>A verified fix means the recorded journey was replayed on the patched copy without AI and the checks above passed. It does not certify the whole app. Generated ${esc(new Date().toISOString())} from run ${esc(state.runId)}.</footer>
</main></body></html>`;
await writeFile(join(runDir, "legios-report.html"), html);
console.log(`Report: ${join(runDir, "legios-report.html")}\nPatches: ${patches.map((p) => p.name).join(", ") || "none"}`);
