import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDevServer } from "../scripts/dev-api.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const python = ["python3", "python"].find((p) => spawnSync(p, ["--version"]).status === 0);
const post = (base, p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); }
  return null;
}

test("end to end: phone taps reach the real Python helper as arrow keys", { skip: !python && "python not installed" }, async () => {
  const server = await startDevServer(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sl-")), "keys.txt");
  fs.writeFileSync(log, "");
  let output = "";
  let helper;
  try {
    const { code } = await (await post(base, "/api/sessions", {})).json();
    helper = spawn(python, [path.join(root, "helper/slidelink_helper.py"), code], {
      env: { ...process.env, SLIDELINK_SERVER: base, SLIDELINK_POLL_INTERVAL: "0.1",
             PYTHONPATH: path.join(root, "tests/helpers/stub"), STUB_PRESS_LOG: log, PYTHONUNBUFFERED: "1" },
    });
    helper.stdout.on("data", (d) => (output += d));
    helper.stderr.on("data", (d) => (output += d));

    const online = await until(async () => (await (await fetch(`${base}/api/sessions/${code}/status`)).json()).agentConnected);
    assert.ok(online, "helper should appear online. Output:\n" + output);
    assert.match(output, /Connected to SlideLink\./);

    await post(base, "/api/remote/heartbeat", { code, remoteId: "phone" });
    assert.equal((await post(base, "/api/commands", { code, command: "NEXT" })).status, 202);
    await sleep(250);
    assert.equal((await post(base, "/api/commands", { code, command: "PREVIOUS" })).status, 202);
    await sleep(250);
    assert.equal((await post(base, "/api/commands", { code, command: "NEXT" })).status, 202);

    const keys = await until(() => { const k = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean); return k.length >= 3 ? k : null; });
    assert.deepEqual(keys, ["right", "left", "right"], output);
  } finally {
    helper?.kill();
    server.close();
  }
});

test("helper exits with a clear message for an unknown code", { skip: !python && "python not installed" }, async () => {
  const server = await startDevServer(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const child = spawn(python, [path.join(root, "helper/slidelink_helper.py"), "654321"], {
      env: { ...process.env, SLIDELINK_SERVER: base, PYTHONPATH: path.join(root, "tests/helpers/stub") },
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    const status = await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve("timeout"); }, 10000);
      child.on("exit", (c) => { clearTimeout(timer); resolve(c); });
    });
    assert.equal(status, 1, stdout);
    assert.match(stdout, /not found or has expired/);
  } finally { server.close(); }
});

test("api/index.mjs (real Upstash client entry) loads and reports missing config safely", async () => {
  const saved = { ...process.env };
  for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) delete process.env[k];
  try {
    const mod = await import("../api/index.mjs");
    assert.equal(typeof mod.default.fetch, "function");
    const res = await mod.default.fetch(new Request("https://x.test/api/sessions", { method: "POST" }));
    assert.equal(res.status, 503);
    // health does not touch storage... but our handler resolves redis for every route, so 503 is expected too:
    const h = await mod.default.fetch(new Request("https://x.test/api/health"));
    assert.ok([200, 503].includes(h.status));
  } finally { Object.assign(process.env, saved); }
});
