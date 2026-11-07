import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, relative, extname, isAbsolute } from "node:path";

const root = resolve(".");
const entry = process.argv[2] || "/index.html";
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2" };
createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (pathname === "/") { res.writeHead(302, { location: entry }); return res.end(); }
    if (pathname.endsWith("/")) pathname += "index.html";
    const file = resolve(root, "." + pathname), rel = relative(root, file);
    if (rel.startsWith("..") || isAbsolute(rel)) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404); res.end("Not found"); }
}).listen(Number(process.env.PORT), "127.0.0.1");
