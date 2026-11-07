// Notely: a small notes app used as the target app in the Legios demo.
// It was written during the event with realistic mistakes for Legios to find.
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4100);
const DATA_FILE = process.env.DATA_FILE || join(here, "data.json");

let db = { users: [], notes: [], nextNoteId: 1 };
try { db = JSON.parse(await readFile(DATA_FILE, "utf8")); } catch { /* fresh start */ }
const sessions = new Map();
const save = () => writeFile(DATA_FILE, JSON.stringify(db, null, 2));
const hashPw = (pw) => createHash("sha256").update(String(pw)).digest("hex");

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

function currentUser(req) {
  const match = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || "");
  const userId = match && sessions.get(match[1]);
  return db.users.find((u) => u.id === userId) || null;
}

function startSession(res, user, status = 200) {
  const sid = randomBytes(16).toString("hex");
  sessions.set(sid, user.id);
  send(res, status, { id: user.id, name: user.name }, { "set-cookie": `sid=${sid}; HttpOnly; Path=/; SameSite=Lax` });
}

const publicNote = (n) => ({ id: n.id, title: n.title, body: n.body, ownerId: n.ownerId, updatedAt: n.updatedAt });

async function api(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  if (method === "POST" && pathname === "/api/signup") {
    const { name, password } = await readBody(req);
    if (!name || !password) return send(res, 400, { error: "Name and password are required." });
    if (db.users.some((u) => u.name.toLowerCase() === String(name).toLowerCase())) return send(res, 409, { error: "That name is taken." });
    const user = { id: db.users.length + 1, name: String(name), password: hashPw(password) };
    db.users.push(user);
    await save();
    return startSession(res, user, 201);
  }
  if (method === "POST" && pathname === "/api/login") {
    const { name, password } = await readBody(req);
    const user = db.users.find((u) => u.name.toLowerCase() === String(name || "").toLowerCase() && u.password === hashPw(password));
    if (!user) return send(res, 401, { error: "Wrong name or password." });
    return startSession(res, user);
  }
  if (method === "POST" && pathname === "/api/logout") {
    return send(res, 200, { ok: true }, { "set-cookie": "sid=; Path=/; Max-Age=0" });
  }

  const user = currentUser(req);
  if (!user) return send(res, 401, { error: "Please sign in." });

  if (method === "GET" && pathname === "/api/me") return send(res, 200, { id: user.id, name: user.name });

  if (method === "GET" && pathname === "/api/notes") {
    return send(res, 200, db.notes.filter((n) => n.ownerId === user.id).map(publicNote));
  }
  if (method === "POST" && pathname === "/api/notes") {
    const { title, body } = await readBody(req);
    if (!title) return send(res, 400, { error: "A title is required." });
    const note = { id: db.nextNoteId++, ownerId: user.id, title: String(title), body: String(body || ""), updatedAt: new Date().toISOString() };
    db.notes.push(note);
    await save();
    return send(res, 201, publicNote(note));
  }
  if (method === "GET" && pathname === "/api/search") {
    const q = url.searchParams.get("q") || "";
    const pattern = new RegExp(q, "i");
    return send(res, 200, db.notes.filter((n) => n.ownerId === user.id && (pattern.test(n.title) || pattern.test(n.body))).map(publicNote));
  }

  const noteMatch = /^\/api\/notes\/(\d+)$/.exec(pathname);
  if (noteMatch) {
    const note = db.notes.find((n) => n.id === Number(noteMatch[1]));
    if (!note) return send(res, 404, { error: "Note not found." });
    if (method === "GET") {
      return send(res, 200, publicNote(note));
    }
    if (method === "PUT") {
      if (note.ownerId !== user.id) return send(res, 404, { error: "Note not found." });
      const { title, body } = await readBody(req);
      if (title !== undefined) note.title = String(title);
      if (body !== undefined) note.body = String(body);
      note.updatedAt = new Date().toISOString();
      await save();
      return send(res, 200, publicNote(note));
    }
  }
  return send(res, 404, { error: "Not found." });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    const html = await readFile(join(here, "public", "index.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (error) {
    console.error(error);
    send(res, 500, { error: "Internal server error" });
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`Notely listening on http://127.0.0.1:${PORT}`));
