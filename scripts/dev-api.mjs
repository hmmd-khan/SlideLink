// Local simulation of the cloud deployment: serves public/ and the SAME API logic that
// Vercel runs, backed by an in-memory fake Redis (nothing is sent to Upstash).
//   npm run dev:cloud        -> http://127.0.0.1:3100   (PORT env overrides)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHandler } from "../lib/slidelink-core.mjs";
import { createFakeRedis, createClock } from "../tests/helpers/fake-redis.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const clock = { now: () => Date.now() };
const redis = createFakeRedis(clock);
const handle = createHandler(() => redis, { minCommandIntervalMs: Number(process.env.MIN_INTERVAL_MS ?? 150) });
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

export function startDevServer(port = Number(process.env.PORT || 3100)) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname.startsWith("/api")) {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        const r = await handle(new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body }));
        res.writeHead(r.status, Object.fromEntries(r.headers));
        res.end(Buffer.from(await r.arrayBuffer()));
        return;
      }
      const file = path.join(root, "public", url.pathname === "/" ? "index.html" : url.pathname);
      if (!file.startsWith(path.join(root, "public")) || !fs.existsSync(file)) { res.writeHead(404); return res.end("Not found"); }
      res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startDevServer();
  console.log(`SlideLink cloud simulation on http://127.0.0.1:${s.address().port}`);
}
