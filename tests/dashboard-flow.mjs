import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { ROOT, loadTarget } from "../lib/config.mjs";

if (!process.argv[2]) throw new Error("Usage: node tests/dashboard-flow.mjs <Notely recording folder>");
const source = resolve(process.argv[2]);
const findings = JSON.parse(await readFile(join(source, "findings.json"), "utf8"));
const target = await loadTarget("notely-healthy");
const runs = join(ROOT, "runs", `dashboard-controls-${Date.now()}`), runDir = join(runs, "run-control");
await mkdir(runDir, { recursive: true });
await cp(join(source, "recording.json"), join(runDir, "recording.json"));
await cp(join(source, "shots"), join(runDir, "shots"), { recursive: true });
await writeFile(join(runDir, "state.json"), JSON.stringify({ runId: "run-control", phase: "done", app: { id: target.id, name: target.name, description: target.description }, users: {}, findings, fixes: {}, log: [] }));
const server = spawn(process.execPath, ["server.mjs"], { cwd: ROOT, env: { ...process.env, PORT: "4150", LEGIOS_RUNS: runs, LEGIOS_RECHECK_PORT: "4155" }, windowsHide: true, stdio: "ignore" });
let browser;
try {
  let up = false;
  for (let i = 0; i < 40; i++) {
    try { await fetch("http://127.0.0.1:4150/api/state"); up = true; break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  assert.ok(up, "Isolated dashboard should start");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => { errors.push(e.message); console.log(`Page error: ${e.message}`); });
  await page.goto("http://127.0.0.1:4150");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(runs, "before-check.png"), fullPage: true });
  console.log(`Dashboard before check: ${await page.locator('#phase').textContent()}; controls: ${await page.getByRole('button').allTextContents()}`);
  await page.getByRole("button", { name: "Recheck all findings" }).click();
  await page.waitForFunction(() => document.getElementById("finalChecks").textContent.includes("Final combined version: done"), null, { timeout: 150000 });
  assert.equal(await page.locator("#finalChecks .counts").filter({ hasText: /^FIXED:/ }).count(), findings.length);
  assert.equal(errors.length, 0, errors.join("\n"));
  const link = page.getByRole("link", { name: "Download developer report" });
  const response = await page.request.get("http://127.0.0.1:4150" + await link.getAttribute("href"));
  assert.equal(response.status(), 200);
  assert.match(response.headers()["content-disposition"], /attachment/);
  const report = await response.json();
  assert.equal(report.finalVerification.status, "fixed");
  assert.ok(report.reportMarkdown.includes("## Reproduce"));
  assert.ok(report.screenshot?.data, "Developer report should include journey screenshot");
  const shot = await page.request.get(`http://127.0.0.1:4150/runs/run-control/${report.screenshot.name}`);
  assert.equal(shot.status(), 200, "Journey screenshots must use the configured run root");
  await writeFile(join(runs, "developer-report.json"), JSON.stringify(report, null, 2));
  await page.screenshot({ path: join(runs, "dashboard.png"), fullPage: true });
  const invalid = await page.request.post("http://127.0.0.1:4150/api/findings/999/fix");
  assert.equal(invalid.status(), 404);
  console.log(`PASS dashboard: recheck button, ${findings.length} final results, developer download, screenshot, invalid finding rejected, no page errors`);
  console.log(`Evidence: ${runs}`);
} finally {
  await browser?.close();
  server.kill();
  await new Promise((r) => server.exitCode !== null ? r() : server.once("exit", r));
}
