// Crowd mode: repeats the recorded journeys as many simultaneous browser users, each with its
// own account and session. No model calls. Every number reported here is measured in this run.
import { chromium } from "playwright";
import { startTarget } from "./target.mjs";
import { locate } from "./replay.mjs";
import { credentialsOf } from "./checks.mjs";
import { contentVariants, textFor } from "../features/crowd-variety.mjs";

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);

export async function runScale({ target: config, appDir, port, records, users = 120, onProgress, varied = true }) {
  const journeys = records.map((r) => ({ ...r, account: credentialsOf(r.steps)?.name, steps: r.steps.filter((s) => !s.error && s.action) })).filter((r) => r.steps.length);
  // AI-varied content: the local model writes different text for each crowd user before the run starts.
  // Actions stay replayed; only the content they type differs.
  const variants = {};
  if (varied) {
    onProgress?.({ status: "preparing", requested: users, note: "The local model is writing varied content for the crowd" });
    for (const j of journeys) { try { variants[j.id] = await contentVariants(j, Math.min(users, 25)); } catch { variants[j.id] = {}; } }
  }
  const target = await startTarget(config, appDir, port);
  const browser = await chromium.launch({ headless: true });
  const stats = { status: "running", target: target.url, requested: users, journeys: journeys.map((j) => j.name), started: 0, active: 0, peakSimultaneous: 0,
    completed: 0, failed: 0, requests: 0, serverErrors: 0, pageErrors: 0, blockedSteps: 0, blockedBy: {}, errorsByEndpoint: {}, latencies: [], seconds: 0,
    varied, variedFields: Object.values(variants).reduce((n, v) => n + Object.keys(v).length, 0),
    distinctTexts: Object.values(variants).reduce((n, v) => n + Object.values(v).reduce((m, list) => m + new Set(list).size, 0), 0) };
  const startedAt = Date.now();
  const report = () => {
    const sorted = [...stats.latencies].sort((a, b) => a - b);
    const { latencies, ...rest } = stats;
    return { ...rest, p50ms: Math.round(pct(sorted, 50)), p95ms: Math.round(pct(sorted, 95)), seconds: Math.round((Date.now() - startedAt) / 1000) };
  };
  const tick = setInterval(() => onProgress?.(report()), 1000);

  async function one(k) {
    const journey = journeys[k % journeys.length];
    const tag = String(k + 1).padStart(3, "0");
    const context = await browser.newContext({ viewport: journey.viewport || { width: 1100, height: 800 } });
    stats.started++; stats.active++; stats.peakSimultaneous = Math.max(stats.peakSimultaneous, stats.active);
    const page = await context.newPage();
    page.on("requestfinished", (req) => {
      if (!["fetch", "xhr"].includes(req.resourceType())) return;
      const t = req.timing();
      if (t.responseEnd > 0) stats.latencies.push(t.responseEnd);
    });
    page.on("response", (r) => {
      const path = new URL(r.url()).pathname;
      if (!["fetch", "xhr"].includes(r.request().resourceType())) return;
      stats.requests++;
      if (r.status() >= 500) { stats.serverErrors++; const key = `${r.request().method()} ${path.replace(/\/\d+$/, "/:id")}`; stats.errorsByEndpoint[key] = (stats.errorsByEndpoint[key] || 0) + 1; }
    });
    page.on("pageerror", () => { stats.pageErrors++; });
    let ok = true;
    try {
      await page.goto(target.url);
      // What this crowd user typed in place of the original text, so links and buttons named after
      // that text (a note title, an item name) are found under this user's own wording.
      const typedAs = new Map();
      for (const step of journey.steps) {
        try {
          if (step.action === "goto") await page.goto(new URL(step.target.path, target.url).href);
          else {
            // Each crowd user has their own records, so ids in recorded link addresses do not apply:
            // find links by visible text, using this user's own wording.
            const name = typedAs.get(String(step.target?.name || "").trim()) ?? step.target?.name;
            const found = locate(page, { ...step, target: { ...step.target, href: undefined, name } });
            // The same title can appear twice (a list and search results); in a user's own data both are theirs.
            const loc = step.target?.kind === "link" ? found.first() : found;
            if (step.action === "type") {
              // Each simulated user gets its own account name.
              const base = textFor(journey, variants[journey.id] || {}, step, k);
              const text = journey.account && String(step.text ?? "") === journey.account ? `${journey.account}${tag}` : String(base ?? "");
              if (String(step.text ?? "").trim()) typedAs.set(String(step.text).trim(), text);
              await loc.fill(text, { timeout: 8000 });
            } else if (step.action === "choose") await loc.selectOption({ label: step.text }, { timeout: 8000 });
            else await loc.click({ timeout: 8000 });
          }
          await page.waitForTimeout(250);
        } catch (error) {
          stats.blockedSteps++; ok = false;
          const why = `${journey.name}: ${step.action} "${step.target?.name || step.target?.path}" (${String(error.message).split("\n")[0].slice(0, 60)})`;
          stats.blockedBy[why] = (stats.blockedBy[why] || 0) + 1;
        }
      }
    } catch { ok = false; }
    ok ? stats.completed++ : stats.failed++;
    stats.active--;
    await context.close().catch(() => {});
  }

  try {
    await Promise.all(Array.from({ length: users }, (_, k) => new Promise((r) => setTimeout(r, k * 12)).then(() => one(k))));
    stats.status = "done";
    return report();
  } finally {
    clearInterval(tick);
    await browser.close().catch(() => {});
    await target.stop();
  }
}
