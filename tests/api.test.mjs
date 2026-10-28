import test from "node:test";
import assert from "node:assert/strict";
import { createHandler, StorageConfigError } from "../lib/slidelink-core.mjs";
import { createFakeRedis, createClock } from "./helpers/fake-redis.mjs";

function setup(overrides = {}) {
  const clock = createClock();
  const redis = createFakeRedis(clock);
  const handle = createHandler(() => redis, { now: clock.now, ...overrides });
  let ipCounter = 0;
  const call = async (method, path, body, headers = {}) => {
    const init = { method, headers: { "x-forwarded-for": "9.9.9.9", ...headers } };
    if (body !== undefined) {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
      init.headers["content-type"] = "application/json";
    }
    const res = await handle(new Request("https://x.test" + path, init));
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data, res };
  };
  return { clock, redis, handle, call, nextIp: () => `10.0.0.${++ipCounter}` };
}

async function newSession(call) {
  const r = await call("POST", "/api/sessions");
  assert.equal(r.status, 201);
  return r.data.code;
}

test("health, root and addresses", async () => {
  const { call } = setup();
  assert.deepEqual((await call("GET", "/api/health")).data, { ok: true, service: "SlideLink" });
  assert.deepEqual((await call("GET", "/api")).data, { ok: true, service: "SlideLink" });
  assert.deepEqual((await call("GET", "/api/addresses")).data, { addresses: [] });
});

test("create session returns 201, six digits, 180 minutes, no-store", async () => {
  const { call } = setup();
  const r = await call("POST", "/api/sessions");
  assert.equal(r.status, 201);
  assert.match(r.data.code, /^\d{6}$/);
  assert.equal(r.data.expiresInMinutes, 180);
  assert.equal(r.res.headers.get("cache-control"), "no-store");
});

test("routing works with both original paths and the rewrite ?route= form", async () => {
  const { call } = setup();
  const code = await newSession(call);
  const a = await call("GET", `/api/sessions/${code}/status`);
  const b = await call("GET", `/api/index?route=sessions/${code}/status`);
  assert.equal(a.status, 200);
  assert.deepEqual(a.data, b.data);
  const poll = await call("GET", `/api/index?route=agent/poll&code=${code}`);
  assert.equal(poll.status, 200);
});

test("full happy path: connect, heartbeat, command, poll consumes once", async () => {
  const { call, clock } = setup();
  const code = await newSession(call);

  let s = await call("GET", `/api/sessions/${code}/status`);
  assert.deepEqual(s.data, { code, agentConnected: false, remoteCount: 0, commands: 0 });

  assert.deepEqual((await call("POST", "/api/agent/connect", { code })).data, { ok: true });
  assert.deepEqual((await call("POST", "/api/remote/heartbeat", { code, remoteId: "phone-1" })).data, { ok: true });
  s = await call("GET", `/api/sessions/${code}/status`);
  assert.deepEqual(s.data, { code, agentConnected: true, remoteCount: 1, commands: 0 });

  const sent = await call("POST", "/api/commands", { code, command: "NEXT" });
  assert.equal(sent.status, 202);
  assert.deepEqual(sent.data, { ok: true, command: "NEXT" });

  const p1 = await call("GET", `/api/agent/poll?code=${code}`);
  assert.equal(p1.data.ok, true);
  assert.equal(p1.data.command.command, "NEXT");
  assert.equal(typeof p1.data.command.at, "number");
  const p2 = await call("GET", `/api/agent/poll?code=${code}`);
  assert.deepEqual(p2.data, { ok: true, command: null });

  clock.advance(200);
  await call("POST", "/api/commands", { code, command: "PREVIOUS" });
  assert.equal((await call("GET", `/api/agent/poll?code=${code}`)).data.command.command, "PREVIOUS");
  assert.equal((await call("GET", `/api/sessions/${code}/status`)).data.commands, 2);
});

test("errors match server.js: wording, status codes and order of checks", async () => {
  const { call } = setup();
  const code = await newSession(call);
  // order: session -> helper online -> command -> rate limit
  let r = await call("POST", "/api/commands", { code, command: "NEXT" });
  assert.deepEqual([r.status, r.data], [409, { error: "Laptop helper is not connected yet." }]);
  r = await call("POST", "/api/commands", { code, command: "EXPLODE" });
  assert.equal(r.status, 409, "helper-offline is checked before the command is validated");
  await call("POST", "/api/agent/connect", { code });
  r = await call("POST", "/api/commands", { code, command: "EXPLODE" });
  assert.deepEqual([r.status, r.data], [400, { error: "Unsupported command" }]);
  r = await call("POST", "/api/commands", { code });
  assert.equal(r.status, 400);
  r = await call("POST", "/api/commands", "{not json");
  assert.deepEqual([r.status, r.data], [400, { error: "Invalid JSON" }]);
  r = await call("POST", "/api/commands", { code: "000000", command: "NEXT" });
  assert.deepEqual([r.status, r.data], [404, { error: "Invalid or expired session" }]);
  r = await call("POST", "/api/commands", { code: "12", command: "NEXT" });
  assert.deepEqual([r.status, r.data], [404, { error: "Invalid or expired session" }]);
  r = await call("POST", "/api/commands", {});
  assert.equal(r.status, 404);
  assert.equal((await call("POST", "/api/commands", "x".repeat(9000))).status, 413);

  r = await call("GET", "/api/sessions/000000/status");
  assert.deepEqual([r.status, r.data], [404, { error: "Session not found or expired" }]);
  r = await call("GET", "/api/sessions/abc/status");
  assert.equal(r.status, 404);
  r = await call("POST", "/api/agent/connect", { code: "000000" });
  assert.equal(r.status, 404);
  r = await call("GET", "/api/agent/poll?code=000000");
  assert.deepEqual([r.status, r.data], [404, { error: "Invalid or expired session" }]);
  r = await call("POST", "/api/remote/heartbeat", { code, remoteId: "" });
  assert.deepEqual([r.status, r.data], [404, { error: "Invalid session or remote ID" }]);
  r = await call("POST", "/api/remote/heartbeat", { code: "000000", remoteId: "x" });
  assert.equal(r.status, 404);
});

test("rate limit is 180 ms with the original wording", async () => {
  const { call, clock } = setup();
  const code = await newSession(call);
  await call("POST", "/api/agent/connect", { code });
  assert.equal((await call("POST", "/api/commands", { code, command: "NEXT" })).status, 202);
  clock.advance(100);
  const r = await call("POST", "/api/commands", { code, command: "NEXT" });
  assert.deepEqual([r.status, r.data], [429, { error: "Please wait a moment between commands." }]);
  clock.advance(100);
  assert.equal((await call("POST", "/api/commands", { code, command: "NEXT" })).status, 202);
});

test("helper counts as online for 15 s after its last ping, and recovers when it polls again", async () => {
  const { call, clock } = setup();
  const code = await newSession(call);
  await call("POST", "/api/agent/connect", { code });
  clock.advance(14_000);
  assert.equal((await call("GET", `/api/sessions/${code}/status`)).data.agentConnected, true);
  clock.advance(2_000);
  assert.equal((await call("GET", `/api/sessions/${code}/status`)).data.agentConnected, false);
  await call("GET", `/api/agent/poll?code=${code}`);
  assert.equal((await call("GET", `/api/sessions/${code}/status`)).data.agentConnected, true);
});

test("phones count for 10 s after their last heartbeat; any id up to 80 chars is accepted", async () => {
  const { call, clock } = setup();
  const code = await newSession(call);
  const fallbackId = "1790000000000-0.123456789"; // remote.js fallback id contains a dot
  await call("POST", "/api/remote/heartbeat", { code, remoteId: "a" });
  await call("POST", "/api/remote/heartbeat", { code, remoteId: fallbackId });
  await call("POST", "/api/remote/heartbeat", { code, remoteId: "a" });
  assert.equal((await call("GET", `/api/sessions/${code}/status`)).data.remoteCount, 2);
  clock.advance(8_000);
  await call("POST", "/api/remote/heartbeat", { code, remoteId: fallbackId });
  clock.advance(3_000);
  assert.equal((await call("GET", `/api/sessions/${code}/status`)).data.remoteCount, 1);
  // ids longer than 80 characters are truncated, not rejected
  const long = "z".repeat(200);
  assert.equal((await call("POST", "/api/remote/heartbeat", { code, remoteId: long })).status, 200);
  assert.equal((await call("GET", `/api/sessions/${code}/status`)).data.remoteCount, 2);
});

test("sessions expire after 180 minutes", async () => {
  const { call, clock } = setup();
  const code = await newSession(call);
  clock.advance(179 * 60_000);
  assert.equal((await call("GET", `/api/sessions/${code}/status`)).status, 200);
  clock.advance(2 * 60_000);
  assert.equal((await call("GET", `/api/sessions/${code}/status`)).status, 404);
});

test("command throttle: concurrent taps let exactly one through", async () => {
  const { call } = setup();
  const code = await newSession(call);
  await call("POST", "/api/agent/connect", { code });
  const results = await Promise.all(
    Array.from({ length: 10 }, () => call("POST", "/api/commands", { code, command: "NEXT" }))
  );
  const statuses = results.map((r) => r.status).sort();
  assert.equal(statuses.filter((s) => s === 202).length, 1);
  assert.equal(statuses.filter((s) => s === 429).length, 9);
  assert.equal((await call("GET", `/api/sessions/${code}/status`)).data.commands, 1);
});

test("stale queued commands are dropped instead of firing late", async () => {
  const { call, clock } = setup();
  const code = await newSession(call);
  await call("POST", "/api/agent/connect", { code });
  await call("POST", "/api/commands", { code, command: "NEXT" });
  clock.advance(11_000);
  assert.deepEqual((await call("GET", `/api/agent/poll?code=${code}`)).data, { ok: true, command: null });
});

test("reconnecting helper discards old queued commands", async () => {
  const { call, clock } = setup();
  const code = await newSession(call);
  await call("POST", "/api/agent/connect", { code });
  await call("POST", "/api/commands", { code, command: "NEXT" });
  clock.advance(500);
  await call("POST", "/api/agent/connect", { code });
  assert.equal((await call("GET", `/api/agent/poll?code=${code}`)).data.command, null);
});

test("CONCURRENCY: heartbeats, status reads, polls and commands never lose updates", async () => {
  const { call, clock } = setup();
  const code = await newSession(call);
  await call("POST", "/api/agent/connect", { code });
  const N = 60;
  const received = [];
  let done = false;

  const poller = (async () => {
    while (!done || received.length < N) {
      const r = await call("GET", `/api/agent/poll?code=${code}`);
      if (r.data.command) received.push(r.data.command.command);
      else await new Promise((res) => setImmediate(res));
      if (done && received.length >= N) break;
    }
  })();
  const noise = (async () => {
    while (!done) {
      await Promise.all([
        call("POST", "/api/remote/heartbeat", { code, remoteId: "p1" }),
        call("POST", "/api/remote/heartbeat", { code, remoteId: "p2" }),
        call("GET", `/api/sessions/${code}/status`),
      ]);
    }
  })();

  const expected = [];
  for (let i = 0; i < N; i++) {
    clock.advance(200); // past the throttle interval, still well inside presence TTLs
    const cmd = i % 3 === 0 ? "PREVIOUS" : "NEXT";
    const r = await call("POST", "/api/commands", { code, command: cmd });
    assert.equal(r.status, 202, `command ${i}`);
    expected.push(cmd);
  }
  done = true;
  await Promise.all([poller, noise]);

  assert.deepEqual(received, expected, "every command delivered exactly once, in order");
  const s = await call("GET", `/api/sessions/${code}/status`);
  assert.equal(s.data.commands, N);
  assert.equal(s.data.remoteCount, 2);
  assert.equal(s.data.agentConnected, true);
});

test("brute-force protection: many distinct wrong codes block the IP", async () => {
  const { call } = setup({ maxBadCodesPerIp: 5 });
  const code = await newSession(call);
  for (let i = 0; i < 5; i++) {
    assert.equal((await call("GET", `/api/sessions/${String(100000 + i)}/status`)).status, 404);
  }
  // blocked now, even for a valid code (no oracle)
  assert.equal((await call("GET", `/api/sessions/${code}/status`)).status, 429);
  // a different client is unaffected
  assert.equal((await call("GET", `/api/sessions/${code}/status`, undefined, { "x-forwarded-for": "8.8.8.8" })).status, 200);
});

test("a stale browser tab polling one dead code does not block anyone", async () => {
  const { call } = setup({ maxBadCodesPerIp: 5 });
  const code = await newSession(call);
  for (let i = 0; i < 40; i++) await call("GET", "/api/sessions/123456/status");
  assert.equal((await call("GET", `/api/sessions/${code}/status`)).status, 200);
});

test("session creation is rate limited per IP", async () => {
  const { call } = setup({ maxSessionsPerMinutePerIp: 3 });
  for (let i = 0; i < 3; i++) assert.equal((await call("POST", "/api/sessions")).status, 201);
  assert.equal((await call("POST", "/api/sessions")).status, 429);
});

test("wrong method gives 405 with Allow; unknown route 404", async () => {
  const { call } = setup();
  const r = await call("GET", "/api/commands");
  assert.equal(r.status, 405);
  assert.equal(r.res.headers.get("allow"), "POST");
  assert.equal((await call("GET", "/api/nope")).status, 404);
});

test("missing storage configuration returns 503 and never leaks details", async () => {
  const handle = createHandler(() => { throw new StorageConfigError("secret-ish detail"); });
  const res = await handle(new Request("https://x.test/api/sessions", { method: "POST" }));
  assert.equal(res.status, 503);
  assert.doesNotMatch(await res.text(), /secret-ish/);
});
