import { verifyFinding } from "./replay.mjs";

export async function recheckFindings({ target, appDir, records, findings, port = Number(process.env.LEGIOS_RECHECK_PORT || 4125), onResult = () => {} }) {
  const results = [];
  for (const finding of findings) {
    let result;
    try { result = await verifyFinding({ target, appDir, records, finding, port }); }
    catch (error) { result = { status: "blocked", error: String(error.message).split("\n")[0] }; }
    const row = { signature: finding.signature, title: finding.title, ...result };
    results.push(row);
    await onResult(row);
  }
  const counts = { fixed: 0, failing: 0, blocked: 0 };
  for (const row of results) counts[row.status === "fixed" ? "fixed" : row.status === "failing" ? "failing" : "blocked"]++;
  return { status: "done", appDir, finishedAt: new Date().toISOString(), counts, results };
}
