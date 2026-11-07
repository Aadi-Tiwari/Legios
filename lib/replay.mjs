// Replays recorded journeys from a clean start, without any model calls, and decides whether a
// finding is fixed. "Fixed" requires positive evidence; if the replay cannot reach the failing
// point, the result is "blocked", never "fixed".
import { chromium, request as pwRequest } from "playwright";
import { startTarget } from "./target.mjs";
import { attachRecorder } from "./agent.mjs";
import { findIssues, signatureOf, privateTextOf, ensureSession } from "./checks.mjs";
import { checkOutcomes } from "./outcomes.mjs";

const MUTATING = new Set(["POST", "PUT", "PATCH"]);

export function locate(page, step) {
  const t = step.target || {};
  if (t.selector) return page.locator(t.selector);
  // Links are found by their visible text. Ids in recorded addresses change after a reset (a replay of one
  // user gets different ids than the shared original run), and the same title can be listed twice (a list
  // and search results) in one person's own view, so the first match is the same choice.
  if (t.kind === "link") return page.getByRole("link", { name: t.name, exact: true }).first();
  if (t.kind === "button") return page.getByRole("button", { name: t.name, exact: true });
  if (t.kind === "dropdown") return page.getByRole("combobox", { name: t.name, exact: true });
  return page.getByLabel(t.name, { exact: true });
}

// Recreates every user's session on a fresh copy of the app and repeats their steps in the original
// global order. Ambiguous or missing elements are recorded as "blocked", never as bugs.
export async function replayJourneys({ target, appDir, port, records, headed = false }) {
  const app = await startTarget(target, appDir, port);
  const browser = await chromium.launch({ headless: !headed });
  const users = [];
  const blocked = [];
  try {
    for (const rec of records) {
      const context = await browser.newContext({ viewport: rec.viewport || { width: 1100, height: 800 } });
      if (target.offline) await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        return ["data:", "blob:"].includes(url.protocol) || url.origin === new URL(app.url).origin ? route.continue() : route.abort();
      });
      const page = await context.newPage();
      const record = { id: rec.id, baseUrl: app.url, name: rec.name, goal: rec.goal, viewport: rec.viewport, steps: [], network: [], pageErrors: [], consoleErrors: [], memory: [] };
      attachRecorder(context, page, record);
      await page.goto(app.url);
      await page.waitForTimeout(300);
      users.push({ record, context, page, source: rec });
    }
    const timeline = users.flatMap((u) => u.source.steps.map((step) => ({ u, step }))).sort((a, b) => a.step.at - b.step.at);
    for (const { u, step } of timeline) {
      const out = { ...step, at: Date.now(), network: [], pageErrors: [], error: undefined };
      const netBefore = u.record.network.length, errBefore = u.record.pageErrors.length;
      const before = await u.page.evaluate(() => document.body.innerText).catch(() => "");
      try {
        if (step.action === "goto") await u.page.goto(new URL(step.target.path, app.url).href);
        else {
          const loc = locate(u.page, step);
          const count = await loc.count();
          if (count !== 1) throw new Error(count ? `ambiguous element "${step.target?.name}" (${count} matches)` : `element "${step.target?.name}" not found`);
          if (step.action === "type") await loc.fill(step.text ?? "", { timeout: 5000 });
          else if (step.action === "choose") await loc.selectOption({ label: step.text }, { timeout: 5000 });
          else await loc.click({ timeout: 5000 });
        }
        await u.page.waitForTimeout(500);
      } catch (error) {
        out.error = String(error.message).split("\n")[0];
        if (!step.error) blocked.push({ user: u.record.name, step: step.n, reason: out.error });
      }
      const after = await u.page.evaluate(() => document.body.innerText).catch(() => "");
      const beforeLines = new Set(before.split("\n").map((l) => l.trim()));
      out.toast = after.split("\n").map((l) => l.trim()).filter((l) => l && l.length <= 80 && !beforeLines.has(l) && /\b(saved|success|updated|created|done|added)\b/i.test(l)).join(" | ");
      out.network = u.record.network.slice(netBefore).map(({ method, path, status }) => ({ method, path, status }));
      out.pageErrors = u.record.pageErrors.slice(errBefore).map((e) => e.message);
      out.outcomes = await checkOutcomes({ target, record: u.record, rows: u.record.network.slice(netBefore), request: u.context.request, baseUrl: app.url, step: step.n });
      u.record.steps.push(out);
    }
    return { app, browser, users, blocked };
  } catch (error) {
    await browser.close().catch(() => {});
    await app.stop();
    throw error;
  }
}

async function getJSON(requestContext, url, init) {
  const resp = await requestContext.fetch(url, init);
  const text = await resp.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: resp.status(), text, json };
}

// Requests that worked for their own user in the recording must still work in the replay.
function regressionCheck(users, sourceRecords) {
  const broken = [];
  for (const u of users) {
    const src = sourceRecords.find((r) => r.name === u.record.name);
    if (!src) continue;
    const othersSecrets = sourceRecords.filter((r) => r !== src).flatMap((r) => privateTextOf(r).map((s) => s.text));
    const worked = new Set(src.network.filter((r) => r.status < 300 && !othersSecrets.some((s) => r.body.includes(s))).map((r) => signatureOf("ok", r.method, r.path)));
    const nowWorks = new Set(u.record.network.filter((r) => r.status < 300).map((r) => signatureOf("ok", r.method, r.path)));
    const nowTried = new Set(u.record.network.map((r) => signatureOf("ok", r.method, r.path)));
    for (const sig of worked) if (!nowWorks.has(sig)) broken.push({ text: `${u.record.name}: ${sig.slice(3)}`, reached: nowTried.has(sig) });
  }
  const failed = broken.filter((b) => b.reached), unreached = broken.filter((b) => !b.reached);
  // A request the replay never got to is not evidence of a regression: it is "blocked", never "failing".
  return {
    name: "Everything that worked before still works", pass: failed.length === 0 && unreached.length === 0,
    status: failed.length ? "failing" : unreached.length ? "blocked" : "passed",
    detail: broken.length ? [...failed.map((b) => `${b.text} failed`), ...unreached.map((b) => `${b.text} not reached`)].slice(0, 4).join("; ") : "all previously successful requests still succeed",
  };
}

// The privacy contract for a data-leak finding: the owner keeps full access, everyone else is denied.
async function privacyContract({ target, users, baseUrl, finding, sourceRecords }) {
  const owner = users.find((u) => u.record.name === finding.probe.ownerName);
  const other = finding.probe.anonymous ? null : users.find((u) => u.record.name === finding.probe.requesterName);
  const checks = [];
  const check = (name, pass, detail) => { checks.push({ name, pass, detail }); return pass; };
  if (!owner || (!finding.probe.anonymous && !other)) return { status: "blocked", checks: [{ name: "Both users exist in the replay", pass: false, detail: "missing user" }] };

  const a = await ensureSession(owner.context.request, owner.source.steps, target, baseUrl, owner.record.name);
  const b = other ? await ensureSession(other.context.request, other.source.steps, target, baseUrl, other.record.name) : { ok: true, detail: "signed-out visitor" };
  if (!check("Each session is signed in as the right account", a.ok && b.ok, `${a.detail}; ${b.detail}`)) return { status: "blocked", checks };

  // Find where the private text lives in this replay (ids can change after a reset).
  const sig = signatureOf("x", "GET", finding.probe.path);
  const sameKind = owner.record.network.filter((r) => r.method === "GET" && signatureOf("x", "GET", r.path) === sig);
  const read = [...sameKind].reverse().find((r) => r.status < 300 && r.body.includes(finding.probe.secret));
  if (!read) {
    // The owner asked for their own data in the replay and did not get it: access was broken, not just hidden.
    if (sameKind.length) {
      check(`${owner.record.name} can still read it`, false, `${owner.record.name}'s own requests: ${sameKind.map((r) => `${r.path} -> ${r.status}`).slice(0, 3).join(", ")}`);
      checks.push(regressionCheck(users, sourceRecords));
      return { status: "failed", checks };
    }
    check(`${owner.record.name}'s private data exists after replay`, false, "the replay never requested it");
    return { status: "blocked", checks };
  }
  check(`${owner.record.name}'s private data exists after replay`, true, `found at ${read.path}`);
  const url = baseUrl + read.path;

  if (other) {
    const r = await getJSON(other.context.request, url);
    check(`${other.record.name} cannot read it`, !r.text.includes(finding.probe.secret), `GET as ${other.record.name} -> ${r.status}`);
  }
  const anon = await pwRequest.newContext();
  const r2 = await getJSON(anon, url);
  await anon.dispose();
  check("A signed-out visitor cannot read it", !r2.text.includes(finding.probe.secret), `GET signed out -> ${r2.status}`);

  const r3 = await getJSON(owner.context.request, url);
  check(`${owner.record.name} can still read it`, r3.status < 300 && r3.text.includes(finding.probe.secret), `GET as ${owner.record.name} -> ${r3.status}`);

  // The owner's own saves still work: repeat each kind of successful write from the replay.
  const writes = new Map();
  for (const w of owner.record.network.filter((n) => MUTATING.has(n.method) && n.status < 300 && !/sign|log|auth|session|register/i.test(n.path))) writes.set(signatureOf("w", w.method, w.path), w);
  for (const w of writes.values()) {
    const r = await getJSON(owner.context.request, baseUrl + w.path, { method: w.method, data: w.requestBody || undefined, headers: { "content-type": "application/json" } });
    check(`${owner.record.name} can still ${w.method === "POST" ? "create" : "edit"} (${w.method} ${w.path.replace(/\d+/g, ":id")})`, r.status < 300, `${w.method} -> ${r.status}`);
  }
  const regression = regressionCheck(users, sourceRecords);
  checks.push(regression);
  const otherFailed = checks.some((c) => !c.pass && c !== regression);
  return { status: otherFailed || regression.status === "failing" ? "failed" : regression.status === "blocked" ? "blocked" : "passed", checks };
}

// Full verification of one finding against one copy of the app.
export async function verifyFinding({ target, appDir, port, records, finding, headed = false }) {
  const involved = records.filter((r) => [finding.user, finding.owner, finding.probe?.ownerName, finding.probe?.requesterName].includes(r.name));
  const run = await replayJourneys({ target, appDir, port, records: involved.length ? involved : records, headed });
  try {
    const replayFindings = await findIssues(run.users, { target });
    const same = replayFindings.find((f) => f.signature === finding.signature);
    let contract = null, status;
    if (finding.kind === "data_leak") {
      contract = await privacyContract({ target, users: run.users, baseUrl: run.app.url, finding, sourceRecords: records });
      status = contract.status === "blocked" ? "blocked" : contract.status === "passed" && !same ? "fixed" : "failing";
    } else if (finding.kind === "outcome_failure") {
      const outcomes = run.users.find((u) => u.record.name === finding.user)?.record.steps.flatMap((s) => s.outcomes || []).filter((o) => o.rule === finding.evidence.rule) || [];
      status = !outcomes.length || outcomes.some((o) => o.status === "blocked") ? "blocked" : outcomes.every((o) => o.status === "passed") ? "fixed" : "failing";
      contract = { status: status === "fixed" ? "passed" : status === "blocked" ? "blocked" : "failed", checks: outcomes.map((o) => ({ name: o.name, pass: o.status === "passed", detail: o.detail })) };
    } else {
      const checks = [];
      const user = run.users.find((u) => u.record.name === finding.user);
      const [method, path] = finding.evidence.request.split(" ");
      const want = signatureOf("x", method, path);
      if (finding.kind === "crash") {
        const tries = (user?.record.network || []).filter((r) => signatureOf("x", r.method, r.path) === want);
        checks.push({ name: `The replay sent ${method} ${path.split("?")[0]} again`, pass: tries.length > 0, detail: `${tries.length} time(s)` });
        if (tries.length) checks.push({ name: "The intended request now succeeds", pass: tries.every((r) => r.status < 300), detail: tries.map((r) => r.status).join(", ") });
        status = !tries.length ? "blocked" : tries.some((r) => r.status >= 300) ? "failing" : "fixed";
      } else {
        const step = user?.record.steps.find((s) => s.n === finding.evidence.step);
        const writes = (step?.network || []).filter((n) => MUTATING.has(n.method));
        checks.push({ name: "The replay pressed the same save control", pass: Boolean(step && !step.error), detail: step?.error || (step ? `step ${step.n}` : "step not reached") });
        if (step && !step.error) checks.push({ name: "The save request now succeeds", pass: writes.length > 0 && writes.every((n) => n.status < 300), detail: writes.map((n) => `${n.method} ${n.path} -> ${n.status}`).join(", ") || "no save request was sent" });
        status = !step || step.error ? "blocked" : same || !writes.length || writes.some((n) => n.status >= 300) ? "failing" : "fixed";
      }
      const regression = regressionCheck(run.users, records);
      checks.push(regression);
      if (status === "fixed" && checks.some((c) => !c.pass && c !== regression)) status = "failing";
      if (status === "fixed" && regression.status === "failing") status = "failing";
      if (status === "fixed" && regression.status === "blocked") status = "blocked";
      contract = { status: checks.every((c) => c.pass) ? "passed" : "failed", checks };
    }
    const [findingMethod, findingPath = ""] = (finding.evidence.request || "").split(" ");
    const relevant = (u, outcome) => {
      const rule = (target.outcomes || []).find((r) => r.id === outcome.rule);
      return outcome.rule === finding.evidence.rule || (u.record.name === finding.user && rule?.trigger.method === findingMethod && new RegExp(rule.trigger.path).test(findingPath.split("?")[0]))
        || u.source.steps.some((s) => s.outcomes?.some((o) => o.rule === outcome.rule && o.status === "passed"));
    };
    const outcomeChecks = run.users.flatMap((u) => u.record.steps.flatMap((s) => (s.outcomes || []).filter((o) => relevant(u, o)).map((o) => ({ name: `${u.record.name}: ${o.name}`, pass: o.status === "passed", detail: o.detail, status: o.status }))));
    for (const rule of target.outcomes || []) {
      if (rule.id !== finding.evidence.rule && !(rule.trigger.method === findingMethod && new RegExp(rule.trigger.path).test(findingPath.split("?")[0]))) continue;
      const reached = run.users.some((u) => u.record.name === finding.user && u.record.steps.some((s) => s.outcomes?.some((o) => o.rule === rule.id)));
      if (!reached) outcomeChecks.push({ name: rule.name, pass: false, status: "blocked", detail: "The configured outcome checkpoint was not reached" });
    }
    if (outcomeChecks.length) {
      contract.checks.push(...outcomeChecks);
      if (status === "fixed" && outcomeChecks.some((c) => c.status === "failing")) status = "failing";
      if (status === "fixed" && outcomeChecks.some((c) => c.status === "blocked")) status = "blocked";
      contract.status = status === "fixed" ? "passed" : status === "blocked" ? "blocked" : "failed";
    }
    return {
      status, reproduced: Boolean(same), contract, blocked: run.blocked,
      otherFindings: replayFindings.filter((f) => f.signature !== finding.signature).map((f) => f.title),
      replayedUsers: run.users.map((u) => u.record.name), steps: run.users.reduce((n, u) => n + u.record.steps.length, 0),
      app: { url: run.app.url, pid: run.app.pid, dir: appDir },
    };
  } finally {
    await run.browser.close().catch(() => {});
    await run.app.stop();
  }
}
