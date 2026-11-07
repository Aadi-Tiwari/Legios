// Runs a group of AI users against a fresh copy of the app under test, then checks for findings.
import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { startTarget } from "./target.mjs";
import { runUser } from "./agent.mjs";
import { findIssues } from "./checks.mjs";
import { summarizeFeedback } from "../features/reflection.mjs";

export async function runCrowd({ target, appDir = target.appDir, port, personas = target.users, runDir, headed = true, onUpdate, log = () => {}, remember = true, reflect = true }) {
  await mkdir(runDir, { recursive: true });
  const app = await startTarget(target, appDir, port);
  log(`Started a fresh copy of ${target.name} at ${app.url}`);
  const browser = await chromium.launch({ headless: !headed });
  try {
    const users = await Promise.all(personas.map((persona, i) =>
      new Promise((r) => setTimeout(r, i * 400)).then(() =>
        runUser({ browser, baseUrl: app.url, persona, target, runDir, remember, reflect, onUpdate: (rec) => onUpdate?.({ type: "user", user: summarize(rec) }) }))));
    log("All users finished. Checking what they recorded.");
    const findings = await findIssues(users, { target });
    const records = users.map((u) => u.record);
    // UX feedback from each AI user: opinions, kept apart from confirmed bugs.
    const feedback = summarizeFeedback(records.map((r) => r.reflection));
    feedback.byUser = records.filter((r) => r.reflection).map((r) => r.reflection);
    // "Goal met" comes from what the runner recorded (the user finished on its own), not from what the
    // model said about itself afterwards; the self-report is kept separately.
    feedback.saidGoalMet = feedback.goalMet;
    feedback.goalMet = records.filter((r) => r.goalStatus === "model_stopped").length;
    feedback.users = records.length;
    feedback.stuck = records.filter((r) => r.goalStatus === "blocked").length;
    await writeFile(join(runDir, "recording.json"), JSON.stringify({ target: target.id, url: app.url, personas, records }, null, 2));
    await writeFile(join(runDir, "findings.json"), JSON.stringify(findings, null, 2));
    await writeFile(join(runDir, "feedback.json"), JSON.stringify(feedback, null, 2));
    return { records, findings, feedback };
  } finally {
    await browser.close().catch(() => {});
    await app.stop();
  }
}

export function summarize(rec) {
  return {
    id: rec.id, name: rec.name, goal: rec.goal, status: rec.status, goalStatus: rec.goalStatus, current: rec.current, lastShot: rec.lastShot,
    viewport: rec.viewport, steps: rec.steps.length, requests: rec.network.length, rejected: rec.rejected || 0,
    errors: rec.network.filter((n) => n.status >= 500).length + rec.pageErrors.length,
    rememberedVisits: rec.rememberedVisits || 0, reflection: rec.reflection || null,
    memory: rec.memory.slice(-6),
  };
}
