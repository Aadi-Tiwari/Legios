const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };
const valueAt = (obj, path) => path.split(".").reduce((value, key) => value?.[key], obj);
const matches = (rule, row) => row.method === rule.trigger.method && new RegExp(rule.trigger.path).test(row.path.split("?")[0]);

// Rules describe user outcomes independently of the code a repair agent can change.
export async function checkOutcomes({ target, record, rows, request, baseUrl, step }) {
  const results = [];
  for (const rule of target.outcomes || []) {
    for (const row of rows.filter((r) => matches(rule, r))) {
      const result = { rule: rule.id, name: rule.name, step, request: `${row.method} ${row.path}`, requestStatus: row.status, status: "blocked", detail: "Outcome could not be checked" };
      try {
        if (row.status >= 300) {
          results.push({ ...result, status: "failing", detail: `Request returned ${row.status}` });
          continue;
        }
        if (rule.kind === "persist") {
          const sent = parse(row.requestBody);
          const response = parse(row.body);
          const fields = (rule.fields || []).filter((key) => valueAt(sent, key) !== undefined);
          const id = response?.[rule.idField || "id"] ?? row.path.split("?")[0].split("/").pop();
          if (!fields.length) { results.push({ ...result, detail: "No configured content fields were submitted" }); continue; }
          const path = rule.readPath.replaceAll("{requestPath}", row.path).replaceAll("{id}", encodeURIComponent(id));
          const url = new URL(path, baseUrl);
          if (url.origin !== new URL(baseUrl).origin) throw new Error("Outcome read must stay on the test app");
          const equal = (item, key) => rule.numericFields?.includes(key)
            ? Number.isFinite(Number(valueAt(item, key))) && Number(valueAt(item, key)) === Number(valueAt(sent, key))
            : valueAt(item, key) === valueAt(sent, key);
          let kept = false, read;
          for (let attempt = 0; attempt < 2; attempt++) {
            read = await request.get(url.href);
            const body = await read.json().catch(() => null);
            const items = rule.collection ? (Array.isArray(body) ? body : []) : [body];
            kept = read.ok() && items.some((item) => (!rule.collection || row.method === "POST" || String(item?.[rule.idField || "id"]) === String(id)) && fields.every((key) => equal(item, key)));
            if (kept) break;
          }
          Object.assign(result, { status: kept ? "passed" : "failing", confirmed: !kept, detail: `Independent GET ${path} -> ${read.status()}; submitted content ${kept ? "persisted" : "missing or changed on two reads"}` });
        } else if (rule.kind === "search") {
          const query = new URL(row.path, baseUrl).searchParams.get(rule.queryParam || "q");
          const saved = record.network.filter((r) => r.method === "POST" && r.status < 300 && new RegExp(rule.sourcePath).test(r.path.split("?")[0])).map((r) => parse(r.body)).filter(Boolean);
          const expected = saved.filter((item) => query && rule.searchFields.some((key) => String(valueAt(item, key) || "").toLowerCase().includes(query.toLowerCase())));
          const found = parse(row.body);
          if (!expected.length) { results.push({ ...result, detail: "No previously saved content is known to match this query" }); continue; }
          const containsExpected = (items) => Array.isArray(items) && expected.every((item) => items.some((hit) => valueAt(hit, rule.identityField || "id") === valueAt(item, rule.identityField || "id")));
          let kept = containsExpected(found);
          if (!kept) {
            const read = await request.get(new URL(row.path, baseUrl).href);
            kept = read.ok() && containsExpected(await read.json().catch(() => null));
          }
          Object.assign(result, { status: kept ? "passed" : "failing", confirmed: !kept, detail: `${expected.length} known matching record(s) ${kept ? "present" : "missing on repeated reads"} in search results` });
        }
      } catch (error) { result.detail = String(error.message).split("\n")[0]; }
      results.push(result);
    }
  }
  return results;
}
