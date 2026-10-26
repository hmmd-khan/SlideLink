const test = require("node:test");
const assert = require("node:assert/strict");
const { createAppServer } = require("../server");

async function startApp(t) {
  const app = createAppServer();
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  return `http://127.0.0.1:${app.server.address().port}`;
}
async function request(base, route, method = "GET", body) {
  const response = await fetch(base + route, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  let data;
  try { data = await response.json(); } catch { data = await response.text(); }
  return { status: response.status, data };
}

test("health endpoint returns ok", async t => {
  const base = await startApp(t);
  const result = await request(base, "/api/health");
  assert.equal(result.status, 200);
  assert.equal(result.data.ok, true);
});

test("creates six-digit session and serves web app", async t => {
  const base = await startApp(t);
  const created = await request(base, "/api/sessions", "POST", {});
  assert.equal(created.status, 201);
  assert.match(created.data.code, /^\d{6}$/);
  const page = await fetch(base + "/remote.html");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /SlideLink Remote/);
});

test("rejects commands when helper is offline and unsupported commands", async t => {
  const base = await startApp(t);
  const created = await request(base, "/api/sessions", "POST", {});
  const code = created.data.code;
  const offline = await request(base, "/api/commands", "POST", { code, command: "NEXT" });
  assert.equal(offline.status, 409);
  const badConnect = await request(base, "/api/agent/connect", "POST", { code: "000000" });
  assert.equal(badConnect.status, 404);
});

test("accepts a command and returns it to the laptop helper poll", async t => {
  const base = await startApp(t);
  const created = await request(base, "/api/sessions", "POST", {});
  const code = created.data.code;
  assert.equal((await request(base, "/api/agent/connect", "POST", { code })).status, 200);
  const queued = await request(base, "/api/commands", "POST", { code, command: "NEXT" });
  assert.equal(queued.status, 202);
  assert.equal(queued.data.command, "NEXT");
  const poll = await request(base, `/api/agent/poll?code=${code}`);
  assert.equal(poll.status, 200);
  assert.equal(poll.data.command.command, "NEXT");
  const emptyPoll = await request(base, `/api/agent/poll?code=${code}`);
  assert.equal(emptyPoll.data.command, null);
});
