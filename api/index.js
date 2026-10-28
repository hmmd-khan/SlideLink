
import { Redis } from "@upstash/redis";
import { randomInt } from "node:crypto";

const redis = Redis.fromEnv();

const SESSION_TTL = 3 * 60 * 60;
const AGENT_STALE_MS = 15000;
const RATE_LIMIT_MS = 180;

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function readBody(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error();
    }
    return body;
  } catch {
    throw new Error("Invalid JSON");
  }
}

async function getSession(code) {
  if (!/^\d{6}$/.test(code || "")) return null;
  return redis.get(`slidelink:session:${code}`);
}

async function saveSession(session) {
  await redis.set(`slidelink:session:${session.code}`, session, {
    ex: SESSION_TTL,
  });
}

async function createSession() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = String(randomInt(100000, 1000000));
    const key = `slidelink:session:${code}`;
    const session = {
      code,
      createdAt: Date.now(),
      agentLastSeen: 0,
      lastCommandAt: 0,
      commands: [],
      commandCount: 0,
      remoteLastSeen: {},
    };

    const created = await redis.set(key, session, {
      ex: SESSION_TTL,
      nx: true,
    });

    if (created === "OK") return session;
  }

  throw new Error("Could not create a unique session. Try again.");
}

function isAgentOnline(session) {
  return Date.now() - session.agentLastSeen < AGENT_STALE_MS;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    try {
      if (method === "GET" && pathname === "/api") {
        return json({ ok: true, service: "SlideLink" });
      }

      if (method === "GET" && pathname === "/api/health") {
        await redis.set("slidelink:health", "ok", { ex: 60 });
        return json({ ok: true, service: "SlideLink" });
      }

      if (method === "GET" && pathname === "/api/addresses") {
        return json({ addresses: [] });
      }

      if (method === "POST" && pathname === "/api/sessions") {
        const session = await createSession();
        return json(
          { code: session.code, expiresInMinutes: 180 },
          201
        );
      }

      const statusMatch = pathname.match(
        /^\/api\/sessions\/(\d{6})\/status$/
      );

      if (method === "GET" && statusMatch) {
        const session = await getSession(statusMatch[1]);

        if (!session) {
          return json({ error: "Session not found or expired" }, 404);
        }

        const now = Date.now();
        for (const [id, seen] of Object.entries(session.remoteLastSeen || {})) {
          if (now - seen > 10000) delete session.remoteLastSeen[id];
        }

        await saveSession(session);

        return json({
          code: session.code,
          agentConnected: isAgentOnline(session),
          remoteCount: Object.keys(session.remoteLastSeen || {}).length,
          commands: session.commandCount,
        });
      }

      if (method === "POST" && pathname === "/api/agent/connect") {
        const body = await readBody(request);
        const session = await getSession(String(body.code || ""));

        if (!session) {
          return json({ error: "Invalid or expired session" }, 404);
        }

        session.agentLastSeen = Date.now();
        await saveSession(session);
        return json({ ok: true });
      }

      if (method === "POST" && pathname === "/api/remote/heartbeat") {
        const body = await readBody(request);
        const code = String(body.code || "");
        const remoteId = String(body.remoteId || "").slice(0, 80);
        const session = await getSession(code);

        if (!session || !remoteId) {
          return json({ error: "Invalid session or remote ID" }, 404);
        }

        session.remoteLastSeen = session.remoteLastSeen || {};
        session.remoteLastSeen[remoteId] = Date.now();
        await saveSession(session);

        return json({ ok: true });
      }

      if (method === "GET" && pathname === "/api/agent/poll") {
        const code = url.searchParams.get("code") || "";
        const session = await getSession(code);

        if (!session) {
          return json({ error: "Invalid or expired session" }, 404);
        }

        session.agentLastSeen = Date.now();
        const command = session.commands.shift() || null;
        await saveSession(session);

        return json({ ok: true, command });
      }

      if (method === "POST" && pathname === "/api/commands") {
        const body = await readBody(request);
        const session = await getSession(String(body.code || ""));

        if (!session) {
          return json({ error: "Invalid or expired session" }, 404);
        }

        if (!isAgentOnline(session)) {
          return json({
            error: "Laptop helper is not connected yet.",
          }, 409);
        }

        if (!["NEXT", "PREVIOUS"].includes(body.command)) {
          return json({ error: "Unsupported command" }, 400);
        }

        const now = Date.now();

        if (now - session.lastCommandAt < RATE_LIMIT_MS) {
          return json({
            error: "Please wait a moment between commands.",
          }, 429);
        }

        session.lastCommandAt = now;
        session.commandCount += 1;
        session.commands.push({ command: body.command, at: now });
        await saveSession(session);

        return json({ ok: true, command: body.command }, 202);
      }

      if (method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Allow": "GET, POST, OPTIONS",
          },
        });
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      console.error("SlideLink API error:", error);
      return json({ error: "Internal server error" }, 500);
    }
  },
};
