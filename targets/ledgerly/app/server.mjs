// Ledgerly: a small expense tracker used as a second Legios test target.
// Written at the event with realistic mistakes, and a different design from Notely
// (email accounts, text ids, a list endpoint filtered by an owner parameter).
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.LEDGERLY_PORT || 4200);
const DATA = process.env.LEDGERLY_DATA || join(here, "data.json");
let db = { accounts: [], expenses: [] };
try { db = JSON.parse(await readFile(DATA, "utf8")); } catch { /* fresh */ }
const sessions = new Map();
const persist = () => writeFile(DATA, JSON.stringify(db));
const digest = (s) => createHash("sha256").update(String(s)).digest("hex");
const newId = (prefix) => `${prefix}_${randomBytes(3).toString("hex")}`;

const reply = (res, status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
const body = async (req) => { let s = ""; for await (const c of req) s += c; try { return s ? JSON.parse(s) : {}; } catch { return {}; } };
const account = (req) => { const m = /(?:^|;\s*)ledgerly_session=(\w+)/.exec(req.headers.cookie || ""); return db.accounts.find((a) => a.id === sessions.get(m?.[1])) || null; };
const login = (res, a, status = 200) => {
  const token = randomBytes(18).toString("hex");
  sessions.set(token, a.id);
  reply(res, status, { id: a.id, email: a.email }, { "set-cookie": `ledgerly_session=${token}; HttpOnly; Path=/; SameSite=Lax` });
};

// Amounts are stored in cents.
function toCents(input) {
  const [dollars, cents = "0"] = String(input).trim().replace(/^\$/, "").split(".");
  return Number(BigInt(dollars) * 100n + BigInt(cents.padEnd(2, "0").slice(0, 2)));
}
const view = (e) => ({ id: e.id, description: e.description, amount: (e.cents / 100).toFixed(2), category: e.category, owner: e.owner, created: e.created });

async function handle(req, res, url) {
  const { pathname } = url;
  if (req.method === "POST" && pathname === "/auth/register") {
    const { email, password } = await body(req);
    if (!/^\S+@\S+$/.test(email || "") || String(password || "").length < 6) return reply(res, 400, { error: "Use an email address and a password of at least 6 characters." });
    if (db.accounts.some((a) => a.email === email.toLowerCase())) return reply(res, 409, { error: "An account with that email already exists." });
    const a = { id: newId("u"), email: email.toLowerCase(), hash: digest(password) };
    db.accounts.push(a); await persist();
    return login(res, a, 201);
  }
  if (req.method === "POST" && pathname === "/auth/login") {
    const { email, password } = await body(req);
    const a = db.accounts.find((x) => x.email === String(email || "").toLowerCase() && x.hash === digest(password));
    return a ? login(res, a) : reply(res, 401, { error: "Email or password is incorrect." });
  }
  if (req.method === "POST" && pathname === "/auth/logout") return reply(res, 200, { ok: true }, { "set-cookie": "ledgerly_session=; Path=/; Max-Age=0" });

  const me = account(req);
  if (!me) return reply(res, 401, { error: "Log in first." });
  if (req.method === "GET" && pathname === "/auth/whoami") return reply(res, 200, { id: me.id, email: me.email });

  if (req.method === "GET" && pathname === "/api/expenses") {
    const owner = url.searchParams.get("owner") || me.id;
    return reply(res, 200, db.expenses.filter((e) => e.owner === owner).map(view));
  }
  if (req.method === "POST" && pathname === "/api/expenses") {
    const { description, amount, category } = await body(req);
    if (!description) return reply(res, 400, { error: "Add a description." });
    const e = { id: newId("exp"), owner: me.id, description: String(description), cents: toCents(amount), category: category || "Other", created: new Date().toISOString() };
    db.expenses.push(e); await persist();
    return reply(res, 201, view(e));
  }
  const m = /^\/api\/expenses\/(exp_\w+)$/.exec(pathname);
  if (m && req.method === "PATCH") {
    const e = db.expenses.find((x) => x.id === m[1] && x.owner === me.id);
    if (!e) return reply(res, 404, { error: "Expense not found." });
    const { description, amount } = await body(req);
    if (description !== undefined) e.description = String(description);
    if (amount !== undefined) e.cents = toCents(amount);
    await persist();
    return reply(res, 200, view(e));
  }
  return reply(res, 404, { error: "Not found." });
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return await handle(req, res, url);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(await readFile(join(here, "index.html")));
  } catch (error) {
    console.error(error);
    reply(res, 500, { error: "Something went wrong." });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Ledgerly on http://127.0.0.1:${PORT}`));
