import { readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { credentialsOf } from "./checks.mjs";

export async function findingReport({ state, finding, records, runDir }) {
  const fix = state.fixes?.[finding.signature];
  const latest = state.recheck?.results?.find((r) => r.signature === finding.signature);
  const report = {
    format: "legios-finding-v1", exportedAt: new Date().toISOString(), runId: state.runId, app: state.app,
    finding, repair: fix || null, finalVerification: latest || null,
    scope: "Verification covers the recorded journeys and configured outcome checks. It does not certify the whole app.",
    screenshot: null,
  };
  const shot = finding.evidence?.shot || records.find((r) => r.name === finding.user)?.steps.findLast((s) => s.shot)?.shot;
  if (shot) {
    const file = resolve(runDir, shot), rel = relative(resolve(runDir), file);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
      try { report.screenshot = { name: rel.replaceAll("\\", "/"), encoding: "base64", data: (await readFile(file)).toString("base64") }; }
      catch { report.screenshot = { name: shot, unavailable: true }; }
    }
  }
  const secrets = records.flatMap((r) => {
    const creds = credentialsOf(r.steps);
    return [creds?.password, ...r.steps.filter((s) => s.secretField).map((s) => s.text)].filter(Boolean);
  });
  const redact = (value, key = "") => {
    if (/password|token|authorization|cookie|api.?key|hash/i.test(key)) return "[redacted]";
    if (Array.isArray(value)) return value.map((v) => redact(v));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
    if (typeof value !== "string") return value;
    let text = value;
    for (const secret of secrets) text = text.replaceAll(secret, "[redacted]");
    return text.replace(/((?:password|token|authorization|cookie|api[_-]?key|hash)["']?\s*[:=]\s*)(["'])(.*?)\2/gi, '$1"[redacted]"');
  };
  const clean = redact(report);
  const item = clean.finding;
  clean.reportMarkdown = [
    `# ${item.title}`, "", `App: ${clean.app?.name || clean.app?.id || "unknown"}`, `Finding: ${item.status}`,
    `Final combined verification: ${clean.finalVerification?.status || "not run"}`, "",
    "## Expected", item.expected, "", "## Observed", item.observed, "", "## Reproduce",
    ...(item.steps || []).map((step, i) => `${i + 1}. ${step}`), "", "## Evidence", JSON.stringify(item.evidence, null, 2),
    "", "## Repair", clean.repair?.summary || "No repair drafted", "", "```diff", clean.repair?.diff || "", "```",
    "", "## Verification", ...(clean.finalVerification?.contract?.checks || clean.repair?.after?.contract?.checks || []).map((c) => `${c.pass ? "PASS" : "FAIL"}: ${c.name}. ${c.detail}`),
    "", clean.scope,
  ].join("\n");
  return clean;
}
