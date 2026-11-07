import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

const dataPath = resolve(process.env.PANTRY_DATA || './data.json');
let data;
try { data = JSON.parse(await readFile(dataPath, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  data = { users: [], items: [] };
}
const page = await readFile(new URL('./public/index.html', import.meta.url));
const sessions = new Map();
let writes = Promise.resolve();
function save() {
  const snapshot = JSON.stringify(data, null, 2);
  const pending = writes.then(async () => {
    await mkdir(dirname(dataPath), { recursive: true });
    await writeFile(dataPath + '.tmp', snapshot, { mode: 0o600 });
    await rename(dataPath + '.tmp', dataPath);
  });
  writes = pending.catch(() => {});
  return pending;
}
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function cleanItem(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const notes = typeof body.notes === 'string' ? body.notes.trim() : '';
  if (!name || name.length > 120) fail(400, 'Enter an item name (up to 120 characters).');
  if (notes.length > 2000) fail(400, 'Notes must be under 2,000 characters.');
  if ((typeof body.price !== 'string' && typeof body.price !== 'number') || String(body.price).trim() === '') fail(400, 'Enter a valid price.');
  const price = Number(body.price);
  if (!Number.isFinite(price) || price < 0 || price > 1000000) fail(400, 'Enter a price between 0 and 1,000,000.');
  if (typeof body.shared !== 'boolean') fail(400, 'Choose whether this item is shared.');
  return { name, notes, price: Math.round(price * 100) / 100, shared: body.shared };
}
async function bodyOf(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 16384) fail(413, 'Request is too large.');
  }
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { fail(400, 'Invalid JSON request.'); }
}
const server = http.createServer(async (req, res) => {
  const send = (status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(page);
    }
    if (!url.pathname.startsWith('/api/')) return send(404, { error: 'Not found.' });
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) fail(403, 'Request origin is not allowed.');
      if (!req.headers['content-type']?.startsWith('application/json')) fail(415, 'Send JSON requests.');
    }
    const token = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('pantry_session='))?.slice(15);
    const session = sessions.get(token);
    if (session && session.expires <= Date.now()) sessions.delete(token);
    const user = session && session.expires > Date.now() ? data.users.find(u => u.id === session.userId) : null;
    const publicUser = u => ({ id: u.id, username: u.username });
    if (req.method === 'POST' && ['/api/signup', '/api/login'].includes(url.pathname)) {
      const body = await bodyOf(req);
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = body.password;
      if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) fail(400, 'Use 3 to 32 letters, numbers, underscores or hyphens for your username.');
      if (typeof password !== 'string' || password.length < 8 || password.length > 128) fail(400, 'Use a password with 8 to 128 characters.');
      let account = data.users.find(u => u.username.toLowerCase() === username.toLowerCase());
      if (url.pathname === '/api/signup') {
        if (account) fail(409, 'That username is already taken.');
        const salt = randomBytes(16).toString('hex');
        account = { id: randomUUID(), username, salt, hash: scryptSync(password, salt, 64).toString('hex') };
        data.users.push(account);
        await save();
      } else {
        const hash = scryptSync(password, account?.salt || 'dummy-salt', 64);
        if (!account || !timingSafeEqual(hash, Buffer.from(account.hash, 'hex'))) fail(401, 'Incorrect username or password.');
      }
      if (token) sessions.delete(token);
      const newToken = randomBytes(32).toString('hex');
      sessions.set(newToken, { userId: account.id, expires: Date.now() + 7 * 86400000 });
      res.setHeader('Set-Cookie', `pantry_session=${newToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`);
      return send(200, { user: publicUser(account) });
    }
    if (req.method === 'GET' && url.pathname === '/api/me') return send(200, { user: user ? publicUser(user) : null });
    if (!user) fail(401, 'Please log in.');
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      sessions.delete(token);
      res.setHeader('Set-Cookie', 'pantry_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      return send(200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/items') {
      const query = (url.searchParams.get('q') || '').toLowerCase();
      return send(200, { items: data.items.filter(i => (i.ownerId === user.id || i.shared) && `${i.name} ${i.notes}`.toLowerCase().includes(query)).map(i => ({ ...i, owner: data.users.find(u => u.id === i.ownerId)?.username })) });
    }
    if (req.method === 'POST' && url.pathname === '/api/items') {
      const item = { ...cleanItem(await bodyOf(req)), id: randomUUID(), ownerId: user.id };
      data.items.push(item);
      await save();
      return send(201, { item });
    }
    const match = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (match && ['PUT', 'DELETE'].includes(req.method)) {
      const item = data.items.find(i => i.id === match[1] && i.ownerId === user.id);
      if (!item) fail(404, 'Item not found.');
      if (req.method === 'PUT') Object.assign(item, cleanItem(await bodyOf(req)));
      else data.items = data.items.filter(i => i !== item);
      await save();
      return send(200, { ok: true });
    }
    send(404, { error: 'Not found.' });
  } catch (error) {
    send(error.status || 500, { error: error.status ? error.message : 'Could not complete the request.' });
  }
});
server.listen(Number(process.env.PORT || 4300), '127.0.0.1', () => console.log(`Pantry Share listening on http://127.0.0.1:${server.address().port}`));
