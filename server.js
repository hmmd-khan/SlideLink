const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomInt } = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const sessions = new Map();
const SESSION_TTL_MS = 3 * 60 * 60 * 1000;
const AGENT_STALE_MS = 15_000;
const RATE_LIMIT_MS = 180;

function makeCode() {
  let code;
  do { code = String(randomInt(100000, 1000000)); } while (sessions.has(code));
  return code;
}
function createSession() {
  const now = Date.now();
  const code = makeCode();
  const session = { code, createdAt: now, agentLastSeen: 0, lastCommandAt: 0, commands: [], commandCount: 0, remoteLastSeen: new Map() };
  sessions.set(code, session);
  return session;
}
function getLanAddresses() {
  const found = [];
  for (const list of Object.values(os.networkInterfaces())) for (const net of (list || [])) {
    if (net.family === "IPv4" && !net.internal) found.push(net.address);
  }
  return [...new Set(found)];
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 8192) req.destroy(); });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}
function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}
function isAgentOnline(session) { return Date.now() - session.agentLastSeen < AGENT_STALE_MS; }

function createAppServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    try {
      if (req.method === "GET" && url.pathname === "/api/health") return sendJson(res, 200, { ok: true, service: "SlideLink" });
      if (req.method === "GET" && url.pathname === "/api/addresses") return sendJson(res, 200, { addresses: getLanAddresses() });
      if (req.method === "POST" && url.pathname === "/api/sessions") {
        const session = createSession();
        return sendJson(res, 201, { code: session.code, expiresInMinutes: 180 });
      }
      const statusMatch = url.pathname.match(/^\/api\/sessions\/(\d{6})\/status$/);
      if (req.method === "GET" && statusMatch) {
        const session = sessions.get(statusMatch[1]);
        if (!session) return sendJson(res, 404, { error: "Session not found or expired" });
        const now = Date.now();
        for (const [id, seen] of session.remoteLastSeen) if (now - seen > 10_000) session.remoteLastSeen.delete(id);
        return sendJson(res, 200, { code: session.code, agentConnected: isAgentOnline(session), remoteCount: session.remoteLastSeen.size, commands: session.commandCount });
      }
      if (req.method === "POST" && url.pathname === "/api/agent/connect") {
        const body = await readBody(req);
        const session = sessions.get(String(body.code || ""));
        if (!session) return sendJson(res, 404, { error: "Invalid or expired session" });
        session.agentLastSeen = Date.now();
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/remote/heartbeat") {
        const body = await readBody(req);
        const session = sessions.get(String(body.code || ""));
        const remoteId = String(body.remoteId || "").slice(0, 80);
        if (!session || !remoteId) return sendJson(res, 404, { error: "Invalid session or remote ID" });
        session.remoteLastSeen.set(remoteId, Date.now());
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/api/agent/poll") {
        const code = url.searchParams.get("code") || "";
        const session = sessions.get(code);
        if (!session) return sendJson(res, 404, { error: "Invalid or expired session" });
        session.agentLastSeen = Date.now();
        const command = session.commands.shift() || null;
        return sendJson(res, 200, { ok: true, command });
      }
      if (req.method === "POST" && url.pathname === "/api/commands") {
        const body = await readBody(req);
        const session = sessions.get(String(body.code || ""));
        if (!session) return sendJson(res, 404, { error: "Invalid or expired session" });
        if (!isAgentOnline(session)) return sendJson(res, 409, { error: "Laptop helper is not connected yet." });
        if (!["NEXT", "PREVIOUS"].includes(body.command)) return sendJson(res, 400, { error: "Unsupported command" });
        const now = Date.now();
        if (now - session.lastCommandAt < RATE_LIMIT_MS) return sendJson(res, 429, { error: "Please wait a moment between commands." });
        session.lastCommandAt = now;
        session.commandCount += 1;
        session.commands.push({ command: body.command, at: now });
        return sendJson(res, 202, { ok: true, command: body.command });
      }
      if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "Method not allowed" });
      let requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
      const normalized = path.normalize(requested).replace(/^([/\\]?\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
      const filePath = path.join(PUBLIC_DIR, normalized);
      if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: "Forbidden" });
      fs.readFile(filePath, (err, data) => {
        if (err) return sendJson(res, 404, { error: "Not found" });
        res.writeHead(200, { "Content-Type": contentType(filePath), "Cache-Control": "no-cache" });
        if (req.method === "HEAD") return res.end();
        res.end(data);
      });
    } catch (error) {
      if (!res.headersSent) sendJson(res, 400, { error: error.message || "Bad request" });
      else res.end();
    }
  });
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [code, session] of sessions) if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(code);
  }, 60_000);
  cleanup.unref();
  return { server, sessions };
}

if (require.main === module) {
  const { server } = createAppServer();
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`SlideLink running on http://localhost:${PORT}`);
    console.log("On your phone, use the laptop's LAN IP shown by /api/addresses.");
    console.log("Keep this server and the laptop helper running during the presentation.");
  });
}
module.exports = { createAppServer };
