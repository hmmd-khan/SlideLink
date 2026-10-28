// SlideLink cloud API core (Vercel + Upstash Redis).
//
// Behaviour mirrors the original local server.js: same endpoints, status codes, JSON
// shapes, error wording, order of checks and timings.
//
// Design rules:
//  * No read-modify-write on shared objects. Each piece of state is its own Redis key,
//    changed with one atomic command (SET NX, INCR, RPUSH, LPOP, ZADD, SADD) or one
//    atomic MULTI block, so concurrent requests cannot overwrite each other.
//  * Platform-independent: createHandler(getRedis) returns a standard
//    (Request) => Response function. api/index.mjs plugs in Upstash; tests plug in an
//    in-memory fake.
import { randomInt } from "node:crypto";

export class StorageConfigError extends Error {}

export const DEFAULTS = {
  sessionTtlSec: 3 * 60 * 60, // 180 minutes, as in server.js
  agentTtlSec: 15, // helper counts as online this long after its last ping (server.js: 15 s)
  remoteTtlSec: 10, // phone counts this long after its last heartbeat (server.js: 10 s)
  minCommandIntervalMs: 180, // server.js RATE_LIMIT_MS
  commandStaleMs: 10_000, // a queued tap older than this is dropped, never executed late
  queueMax: 20, // never keep more than this many pending taps
  maxBodyBytes: 8192, // server.js limit
  maxSessionsPerMinutePerIp: 20,
  maxBadCodesPerIp: 50, // distinct WRONG six-digit codes from one IP ...
  badCodeWindowSec: 600, // ... within this window => that IP is blocked for the window
  now: () => Date.now(),
};

const COMMANDS = new Set(["NEXT", "PREVIOUS"]);
const CODE_RE = /^\d{6}$/;

// Exact wording used by server.js (the frontend shows these messages to the user).
const MSG = {
  statusMissing: "Session not found or expired",
  sessionMissing: "Invalid or expired session",
  remoteMissing: "Invalid session or remote ID",
  helperOffline: "Laptop helper is not connected yet.",
  badCommand: "Unsupported command",
  slowDown: "Please wait a moment between commands.",
  badJson: "Invalid JSON",
  blocked: "Too many invalid codes. Try again later.",
};

const K = {
  session: (c) => `sl:s:${c}`,
  agent: (c) => `sl:a:${c}`,
  count: (c) => `sl:n:${c}`,
  queue: (c) => `sl:q:${c}`,
  remotes: (c) => `sl:r:${c}`,
  throttle: (c) => `sl:t:${c}`,
  badCodes: (ip) => `sl:f:${ip}`,
  blocked: (ip) => `sl:b:${ip}`,
  mintRate: (ip) => `sl:m:${ip}`,
};

const BASE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, ...extraHeaders },
  });
}
const fail = (status, error, extra) => json(status, { error }, extra);

function clientIp(request) {
  const raw =
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  return raw.replace(/[^A-Za-z0-9.:_-]/g, "_").slice(0, 64) || "unknown";
}

function resolveRoute(url) {
  let p = url.pathname;
  // vercel.json rewrites /api/... to /api/index?route=...; the original path may or may
  // not survive the rewrite, so support both and never depend on that detail.
  if (p === "/api" || p === "/api/index" || p === "/api/index.mjs") {
    p = "/api/" + (url.searchParams.get("route") || "");
  }
  p = p.replace(/^\/api/, "").replace(/\/+$/, "");
  return p === "" ? "/" : p;
}

// Like server.js: empty body = {}, malformed JSON = 400 "Invalid JSON".
async function readJsonBody(request, maxBytes) {
  const text = await request.text();
  if (text.length > maxBytes) return { error: fail(413, "Request body too large") };
  if (text.trim() === "") return { data: {} };
  try {
    const data = JSON.parse(text);
    return {
      data: data !== null && typeof data === "object" && !Array.isArray(data) ? data : {},
    };
  } catch {
    return { error: fail(400, MSG.badJson) };
  }
}

// Returns a six-digit string, or null for anything that cannot be a real code.
function normalizeCode(value) {
  if (typeof value === "number") value = String(value);
  if (typeof value !== "string") return null;
  const code = value.trim();
  return CODE_RE.test(code) ? code : null;
}

export function createHandler(getRedis, overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  const remoteMs = cfg.remoteTtlSec * 1000;

  // ONE Redis command: does the session exist? is the helper online? how many taps?
  // is this IP blocked?
  async function lookup(redis, code, ip) {
    const [session, agent, count, blocked] = await redis.mget(
      K.session(code),
      K.agent(code),
      K.count(code),
      K.blocked(ip)
    );
    const has = (v) => v !== null && v !== undefined;
    return {
      exists: has(session),
      agentOnline: has(agent),
      commands: Number(count || 0),
      blocked: has(blocked),
    };
  }

  // Count DISTINCT wrong codes per IP (a stale tab hammering one dead code counts once).
  async function recordBadCode(redis, ip, code) {
    const res = await redis
      .multi()
      .sadd(K.badCodes(ip), code)
      .expire(K.badCodes(ip), cfg.badCodeWindowSec, "NX")
      .scard(K.badCodes(ip))
      .exec();
    if (Number(res[2]) >= cfg.maxBadCodesPerIp) {
      await redis.set(K.blocked(ip), "1", { ex: cfg.badCodeWindowSec });
    }
  }

  // Returns { response } when the request must stop here, otherwise { state }.
  async function requireSession(redis, rawCode, ip, missingMessage) {
    const code = normalizeCode(rawCode);
    // A malformed code cannot be a guess at a real session: plain 404, like server.js.
    if (!code) return { response: fail(404, missingMessage) };
    const state = await lookup(redis, code, ip);
    if (state.blocked) {
      return {
        response: fail(429, MSG.blocked, { "retry-after": String(cfg.badCodeWindowSec) }),
      };
    }
    if (!state.exists) {
      await recordBadCode(redis, ip, code);
      return { response: fail(404, missingMessage) };
    }
    return { state, code };
  }

  const routes = {
    "GET /": async () => json(200, { ok: true, service: "SlideLink" }),
    "GET /health": async () => json(200, { ok: true, service: "SlideLink" }),
    // A cloud function cannot see the laptop's LAN; kept so the frontend keeps working.
    "GET /addresses": async () => json(200, { addresses: [] }),

    "POST /sessions": async ({ redis, ip }) => {
      const [minted] = await redis
        .multi()
        .incr(K.mintRate(ip))
        .expire(K.mintRate(ip), 60, "NX")
        .exec();
      if (Number(minted) > cfg.maxSessionsPerMinutePerIp) {
        return fail(429, "Too many sessions created. Try again in a minute.", {
          "retry-after": "60",
        });
      }
      for (let attempt = 0; attempt < 10; attempt++) {
        const code = String(randomInt(100000, 1000000));
        const created = await redis.set(K.session(code), "1", {
          nx: true,
          ex: cfg.sessionTtlSec,
        });
        if (created) {
          return json(201, {
            code,
            expiresInMinutes: Math.round(cfg.sessionTtlSec / 60),
          });
        }
      }
      return fail(503, "Could not allocate a session code. Please retry.");
    },

    "GET /sessions/:code/status": async ({ redis, ip, params }) => {
      const gate = await requireSession(redis, params.code, ip, MSG.statusMissing);
      if (gate.response) return gate.response;
      const remotes = await redis.zcount(K.remotes(gate.code), cfg.now() - remoteMs, "+inf");
      return json(200, {
        code: gate.code,
        agentConnected: gate.state.agentOnline,
        remoteCount: Number(remotes || 0),
        commands: gate.state.commands,
      });
    },

    "POST /agent/connect": async ({ redis, ip, request }) => {
      const body = await readJsonBody(request, cfg.maxBodyBytes);
      if (body.error) return body.error;
      const gate = await requireSession(redis, body.data.code, ip, MSG.sessionMissing);
      if (gate.response) return gate.response;
      await redis
        .multi()
        .set(K.agent(gate.code), "1", { ex: cfg.agentTtlSec })
        .del(K.queue(gate.code)) // a (re)connecting helper must not replay old taps
        .exec();
      return json(200, { ok: true });
    },

    "GET /agent/poll": async ({ redis, ip, url }) => {
      const gate = await requireSession(redis, url.searchParams.get("code"), ip, MSG.sessionMissing);
      if (gate.response) return gate.response;
      const code = gate.code;

      // Refresh "helper online" and consume at most one command, atomically.
      const p = redis.pipeline();
      p.set(K.agent(code), "1", { ex: cfg.agentTtlSec });
      p.lpop(K.queue(code));
      let [, raw] = await p.exec();

      for (let i = 0; i < 5; i++) {
        if (raw === null || raw === undefined) break;
        let item = raw;
        if (typeof raw === "string") {
          try {
            item = JSON.parse(raw);
          } catch {
            item = null;
          }
        }
        const fresh =
          item &&
          COMMANDS.has(item.command) &&
          Number.isFinite(item.at) &&
          cfg.now() - item.at <= cfg.commandStaleMs;
        if (fresh) {
          return json(200, { ok: true, command: { command: item.command, at: item.at } });
        }
        raw = await redis.lpop(K.queue(code)); // skip stale / malformed entries
      }
      return json(200, { ok: true, command: null });
    },

    "POST /remote/heartbeat": async ({ redis, ip, request }) => {
      const body = await readJsonBody(request, cfg.maxBodyBytes);
      if (body.error) return body.error;
      // Same as server.js: any non-empty id is accepted, truncated to 80 characters.
      const remoteId = String(body.data.remoteId || "").slice(0, 80);
      if (!remoteId) return fail(404, MSG.remoteMissing);
      const gate = await requireSession(redis, body.data.code, ip, MSG.remoteMissing);
      if (gate.response) return gate.response;
      const t = cfg.now();
      await redis
        .multi()
        .zadd(K.remotes(gate.code), { score: t, member: remoteId })
        .zremrangebyscore(K.remotes(gate.code), 0, t - remoteMs)
        .expire(K.remotes(gate.code), cfg.sessionTtlSec)
        .exec();
      return json(200, { ok: true });
    },

    // Order of checks is exactly server.js: session -> helper online -> command -> rate limit.
    "POST /commands": async ({ redis, ip, request }) => {
      const body = await readJsonBody(request, cfg.maxBodyBytes);
      if (body.error) return body.error;
      const gate = await requireSession(redis, body.data.code, ip, MSG.sessionMissing);
      if (gate.response) return gate.response;
      const code = gate.code;
      if (!gate.state.agentOnline) return fail(409, MSG.helperOffline);
      const command = body.data.command;
      if (typeof command !== "string" || !COMMANDS.has(command)) {
        return fail(400, MSG.badCommand);
      }
      // Atomic throttle: SET NX PX succeeds for exactly one of any set of concurrent taps.
      const allowed = await redis.set(K.throttle(code), "1", {
        nx: true,
        px: cfg.minCommandIntervalMs,
      });
      if (!allowed) return fail(429, MSG.slowDown);
      await redis
        .multi()
        .rpush(K.queue(code), JSON.stringify({ command, at: cfg.now() }))
        .ltrim(K.queue(code), -cfg.queueMax, -1)
        .expire(K.queue(code), cfg.sessionTtlSec)
        .incr(K.count(code))
        .expire(K.count(code), cfg.sessionTtlSec)
        .exec();
      return json(202, { ok: true, command });
    },
  };

  const patterns = Object.keys(routes).map((key) => {
    const [method, pattern] = key.split(" ");
    const regex = new RegExp("^" + pattern.replace(/:([a-z]+)/g, "(?<$1>[^/]+)") + "$");
    return { method, regex, handler: routes[key] };
  });

  return async function handle(request) {
    try {
      const url = new URL(request.url);
      const path = resolveRoute(url);
      const method = request.method.toUpperCase();

      const matches = patterns.filter((r) => r.regex.test(path));
      if (matches.length === 0) return fail(404, "Not found");
      const route = matches.find((r) => r.method === method);
      if (!route) {
        return fail(405, "Method not allowed", {
          allow: matches.map((r) => r.method).join(", "),
        });
      }
      const params = route.regex.exec(path).groups || {};
      const redis = getRedis();
      return await route.handler({ redis, request, url, params, ip: clientIp(request) });
    } catch (err) {
      if (err instanceof StorageConfigError) {
        console.error("SlideLink storage is not configured:", err.message);
        return fail(503, "Storage is not configured");
      }
      console.error("SlideLink API error:", err);
      return fail(500, "Internal server error");
    }
  };
}
