// Records a backup video of the full demo through the dashboard: explorers, every fix, then the crowd.
// node tools/record-demo.mjs [target]  ->  runs/backup-video/legios-demo-<time>.webm
import { chromium } from "playwright";
import { mkdir, rename, readdir } from "node:fs/promises";
import { join } from "node:path";

const API = "http://127.0.0.1:4000";
const out = "runs/backup-video";
await mkdir(out, { recursive: true });
const before = new Set(await readdir(out));
const post = (path) => fetch(API + path, { method: "POST" });
const state = async () => (await (await fetch(API + "/api/state")).json());

await post(`/api/target?id=${process.argv[2] || "notely"}`);
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, recordVideo: { dir: out, size: { width: 1366, height: 768 } } });
const page = await context.newPage();
const idle = async () => { do { await page.waitForTimeout(1500); } while ((await state()).busy); };

await page.goto(API);
await page.waitForTimeout(3000);
await page.getByRole("button", { name: "Run headless" }).click();
await page.waitForTimeout(1500);
await idle();
await page.waitForTimeout(3000);
const s = (await state()).state;
const order = { data_leak: 0, crash: 1, false_success: 2 };
const findings = s.findings.map((f, i) => ({ f, i })).sort((a, b) => (order[a.f.kind] ?? 9) - (order[b.f.kind] ?? 9));
for (const { f, i } of findings) {
  await page.getByText(f.title).first().click().catch(() => {});
  await page.waitForTimeout(2500);
  await post(`/api/findings/${i}/fix`);
  await idle();
  await page.waitForTimeout(4000);
}
await page.getByRole("button", { name: /fixed app/i }).click().catch(() => {});
await page.waitForTimeout(1500);
await idle();
await page.waitForTimeout(5000);
await context.close();
await browser.close();
const video = (await readdir(out)).find((f) => !before.has(f) && f.endsWith(".webm"));
const name = `legios-demo-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
if (video) await rename(join(out, video), join(out, name));
const final = (await state()).state;
console.log(`Saved ${join(out, name)}`);
console.log(`findings: ${final.findings.map((f) => `${f.kind}=${final.fixes[f.signature]?.status || "not fixed"}`).join(", ")}`);
console.log(`crowd: ${final.crowd?.completed}/${final.crowd?.requested}, peak ${final.crowd?.peakSimultaneous}, server errors ${final.crowd?.serverErrors}`);
