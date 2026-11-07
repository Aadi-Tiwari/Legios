// Turns recorded observations into findings, for any app. A finding is "confirmed" only when
// the failure happens again on request; otherwise it stays "uncertain". Denied requests
// (401, 403, 404) are expected behavior and never count as bugs.
import { request as pwRequest } from "playwright";

export const signatureOf = (kind, method, path) =>
  `${kind}:${method} ${path.replace(/\?.*$/, "").replace(/\/(\d+|[0-9a-f-]{8,}|[a-z]+_[\w]+)(?=\/|$)/gi, "/:id")}`;

const CREDENTIAL_FIELD = /pass|user ?name|^name$|e-?mail|login|account/i;
const NOT_PRIVATE_FIELD = /search|query|find|filter/i;
const MUTATING = new Set(["POST", "PUT", "PATCH"]);

// Credentials a user actually signed in with: the values in the form when sign-up or sign-in succeeded.
export function credentialsOf(steps) {
  let name = null, password = null, creds = null;
  for (const s of steps) {
    if (s.action === "type" && s.secretField) password = s.text;
    else if (s.action === "type" && CREDENTIAL_FIELD.test(s.target?.name || "")) name = s.text;
    if ((s.network || []).some((n) => MUTATING.has(n.method) && n.status < 300 && /sign|log|auth|session|register/i.test(n.path))) creds = name && password ? { name, password } : creds;
  }
  return creds;
}

// Private content: text a user typed into a content field that was then saved by a successful request.
// Content saved in a request the target marks as public (for example { "shared": true }) is meant for
// others to see, so it never counts as private.
function isPublicSave(target, requestBody) {
  const rule = target?.publicContent;
  if (!rule?.field) return false;
  try { return JSON.parse(requestBody)?.[rule.field] === rule.value; } catch { return false; }
}

export function privateTextOf(record, target = null) {
  const typed = record.steps
    .filter((s) => s.action === "type" && !s.secretField && !CREDENTIAL_FIELD.test(s.target?.name || "") && !NOT_PRIVATE_FIELD.test(s.target?.name || ""))
    .map((s) => ({ text: String(s.text || "").trim(), field: s.target?.name }))
    .filter((t) => t.text.length >= 10);
  const saved = record.network.filter((r) => MUTATING.has(r.method) && r.status < 300 && !isPublicSave(target, r.requestBody));
  const out = [];
  for (const t of typed) {
    if (saved.some((r) => r.requestBody.includes(JSON.stringify(t.text).slice(1, -1)) || r.requestBody.includes(t.text))) {
      if (!out.some((o) => o.text === t.text)) out.push(t);
    }
  }
  return out;
}

// Makes sure a session is signed in as the account from its own recorded journey, signing in again
// with those credentials if the journey ended signed out. Without an identity endpoint it cannot check.
export async function ensureSession(requestContext, steps, target, baseUrl, displayName) {
  const auth = target?.auth;
  if (!auth?.identityPath) return { ok: true, checked: false, detail: "no identity endpoint configured" };
  const creds = credentialsOf(steps);
  const who = async () => {
    const r = await requestContext.get(baseUrl + auth.identityPath);
    try { const json = await r.json(); return String(auth.identityName || "name").split(".").reduce((v, k) => v?.[k], json); } catch { return null; }
  };
  const expected = String(creds?.name || displayName).toLowerCase();
  let name = await who();
  if (String(name || "").toLowerCase() !== expected && auth.login && creds) {
    const data = JSON.parse(JSON.stringify(auth.login.body).replace("{name}", creds.name).replace("{password}", creds.password));
    await requestContext.fetch(baseUrl + auth.login.path, { method: auth.login.method || "POST", data, headers: { "content-type": "application/json" } });
    name = await who();
  }
  return { ok: String(name || "").toLowerCase() === expected, checked: true, detail: `${displayName} -> ${name ?? "not signed in"}` };
}

const isPublic = (target, path) => (target?.publicPaths || []).some((p) => new RegExp(p).test(path));

function storyUpTo(record, at) {
  return record.steps.filter((s) => s.at <= at + 50).map((s) =>
    s.action === "choose" ? `${record.name} chose "${s.text}" in "${s.target?.name}"` : s.action === "type" ? `${record.name} typed "${s.secretField ? "********" : s.text}" into "${s.target?.name}"`
      : s.action === "goto" ? `${record.name} opened ${s.target?.path}`
        : `${record.name} clicked ${s.target?.kind || "element"} "${s.target?.name || "?"}"`);
}
const shotAt = (record, at) => [...record.steps].reverse().find((s) => s.at <= at + 50)?.shot;

async function fetchText(requestContext, url) {
  const resp = await requestContext.get(url);
  return { status: resp.status(), body: (await resp.text()).slice(0, 4000) };
}

export async function findIssues(users, { probe = true, target = null } = {}) {
  const findings = new Map();
  const add = (f) => { if (!findings.has(f.signature)) findings.set(f.signature, f); };

  for (const { record, context } of users) {
    for (const step of record.steps) for (const outcome of step.outcomes || []) {
      if (outcome.status !== "failing" || outcome.requestStatus >= 300) continue;
      add({ signature: `outcome_failure:${record.id}:${outcome.rule}`, kind: "outcome_failure", severity: "high", user: record.name,
        title: `${record.name}: ${outcome.name}`, expected: outcome.name, observed: outcome.detail,
        evidence: { request: outcome.request, status: outcome.requestStatus, step: step.n, rule: outcome.rule, shot: step.shot, discovery: "user outcome check" },
        steps: storyUpTo(record, step.at), status: outcome.confirmed ? "confirmed" : "uncertain", confirmation: outcome.confirmed ? "Independent repeated reads confirmed that the expected content is missing." : "Outcome failed once. Replay is required to confirm it." });
    }
    // 1. Server errors.
    for (const r of record.network.filter((n) => n.status >= 500)) {
      let reproduced = r.repeatStatus >= 500 ? true : null;
      if (!reproduced && probe && r.method === "GET") {
        try { reproduced = (await fetchText(context.request, new URL(r.path, record.baseUrl).href)).status >= 500; } catch { reproduced = null; }
      }
      add({
        signature: signatureOf("crash", r.method, r.path), kind: "crash", severity: "high", user: record.name,
        title: `Server error when ${record.name} used ${r.path.split("?")[0]}`,
        expected: "The request completes, or the app shows a clear error message.",
        observed: `${r.method} ${r.path} returned ${r.status}.` + (record.pageErrors.length ? ` The page also threw: "${record.pageErrors[0].message}".` : ""),
        evidence: { request: `${r.method} ${r.path}`, status: r.status, response: r.body.slice(0, 300), pageErrors: record.pageErrors.map((e) => e.message).slice(0, 3), shot: shotAt(record, r.at), discovery: "live exploration" },
        steps: storyUpTo(record, r.at),
        status: reproduced ? "confirmed" : "uncertain",
        confirmation: reproduced ? "Sending the same request again, from the same session with the same data, failed again." : "Seen once; not reproduced yet.",
      });
    }

    // 2. The app said the change worked, but the request behind it failed.
    for (const step of record.steps) {
      const failed = (step.network || []).filter((n) => n.status >= 400 && MUTATING.has(n.method) || n.status >= 500);
      if (!step.toast || !/sav|success|updated|created|done|added/i.test(step.toast) || !failed.length) continue;
      const f = failed[0];
      const full = record.network.find((n) => n.method === f.method && n.path === f.path && n.status === f.status);
      let reproduced = null;
      if (probe && full) {
        try {
          const resp = await context.request.fetch(new URL(f.path, record.baseUrl).href, { method: f.method, data: full.requestBody || undefined, headers: { "content-type": "application/json" } });
          reproduced = resp.status() >= 400;
        } catch { reproduced = null; }
      }
      add({
        signature: signatureOf("false_success", f.method, f.path), kind: "false_success", severity: "high", user: record.name,
        title: `"${step.toast}" shown, but ${record.name}'s change was not saved`,
        expected: "When the app says a change was saved, the save request succeeded.",
        observed: `The app showed "${step.toast}" while ${f.method} ${f.path} returned ${f.status}.`,
        evidence: { request: `${f.method} ${f.path}`, status: f.status, response: (full?.body || "").slice(0, 300), toast: step.toast, shot: step.shot, step: step.n, discovery: "live exploration" },
        steps: storyUpTo(record, step.at),
        status: reproduced ? "confirmed" : "uncertain",
        confirmation: reproduced ? "Sending the same save request again failed again." : "Seen once; not reproduced yet.",
      });
    }
  }

  // 3. Private data reaching someone else. Each user's private content is what they typed and saved.
  //    Exposure is checked three ways: in the other user's own traffic, by the other user's session
  //    repeating the owner's reads, and by a signed-out visitor repeating them.
  // Probes need each user signed in as themself, even if their journey ended signed out.
  if (probe) for (const u of users) { try { u.session = await ensureSession(u.context.request, u.source?.steps || u.record.steps, target, u.record.baseUrl, u.record.name); } catch { u.session = { ok: false }; } }
  for (const owner of users) {
    const secrets = privateTextOf(owner.record, target);
    if (!secrets.length) continue;
    const hasSecret = (body) => secrets.find((s) => body.includes(s.text) || body.includes(JSON.stringify(s.text).slice(1, -1)));
    const ownerReads = owner.record.network.filter((r) => r.method === "GET" && r.status < 300 && hasSecret(r.body) && !isPublic(target, r.path));
    const viewers = [...users.filter((u) => u !== owner && u.session?.ok !== false).map((u) => ({ name: u.record.name, user: u, requestContext: u.context.request }))];
    let anon = null;
    if (probe) { anon = await pwRequest.newContext(); viewers.push({ name: "A signed-out visitor", user: null, requestContext: anon }); }
    try {
      for (const viewer of viewers) {
        // Text both people typed themselves cannot show who it belongs to, so it is ignored.
        const own = viewer.user ? privateTextOf(viewer.user.record, target).map((s) => s.text) : [];
        const hasSecretFor = (body) => { const s = hasSecret(body); return s && !own.includes(s.text) ? s : null; };
        // Passive: the viewer already received the owner's private text while using the app.
        const passive = viewer.user?.record.network.find((r) => r.status < 300 && hasSecretFor(r.body) && !isPublic(target, r.path));
        const candidates = passive ? [{ r: passive, hit: { status: passive.status, body: passive.body }, discovery: "live exploration" }]
          : ownerReads.map((r) => ({ r, hit: null, discovery: `${viewer.name}'s session repeated ${owner.record.name}'s request` }));
        for (const c of candidates) {
          if (!c.hit && probe) { try { c.hit = await fetchText(viewer.requestContext, new URL(c.r.path, owner.record.baseUrl).href); } catch { c.hit = null; } }
          if (!c.hit || c.hit.status >= 300) continue;
          const secret = hasSecretFor(c.hit.body);
          if (!secret) continue;
          let again = false;
          if (probe) { try { again = Boolean(hasSecretFor((await fetchText(viewer.requestContext, new URL(c.r.path, owner.record.baseUrl).href)).body)); } catch { again = false; } }
          const anonymous = !viewer.user;
          add({
            signature: signatureOf(anonymous ? "public_leak" : "data_leak", "GET", c.r.path), kind: "data_leak", severity: "critical",
            user: viewer.name, owner: owner.record.name, anonymous,
            title: anonymous ? `Anyone signed out can read ${owner.record.name}'s private data` : `${viewer.name} can read ${owner.record.name}'s private data`,
            expected: `Only ${owner.record.name} can read what ${owner.record.name} saved. (${target?.description || ""})`.trim(),
            observed: `${anonymous ? "A request with no account" : `${viewer.name}'s signed-in request`} GET ${c.r.path} returned ${owner.record.name}'s private text "${secret.text.slice(0, 60)}".`,
            evidence: { request: `GET ${c.r.path}`, status: c.hit.status, response: c.hit.body.slice(0, 300), requester: viewer.name, owner: owner.record.name, leakedText: secret.text.slice(0, 120), field: secret.field, discovery: c.discovery },
            steps: [...storyUpTo(owner.record, Infinity).filter((s) => !/clicked (link|element)/.test(s)).slice(0, 8), `${viewer.name} requested GET ${c.r.path}`],
            probe: { ownerName: owner.record.name, requesterName: anonymous ? null : viewer.name, anonymous, path: c.r.path, secret: secret.text },
            status: again ? "confirmed" : "uncertain",
            confirmation: again ? `Repeating the request returned the private text again.` : "Seen once; not reproduced yet.",
          });
          break;
        }
      }
    } finally {
      await anon?.dispose();
    }
  }
  return [...findings.values()];
}
