// Live smoke test. Run it against ANY running SlideLink backend:
//   node scripts/smoke.mjs https://slidelink-gamma.vercel.app
//   node scripts/smoke.mjs http://127.0.0.1:3000        (your local server.js, for comparison)
// It creates one throw-away session (expires on its own) and exercises every endpoint.
const base = (process.argv[2] || process.env.SLIDELINK_SERVER || "").replace(/\/+$/, "");
if (!/^https?:\/\//.test(base)) {
  console.error("Usage: node scripts/smoke.mjs <base-url>");
  process.exit(2);
}
let passed = 0, failed = 0;
const req = async (method, path, body, raw) => {
  const res = await fetch(base + path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, data, text };
};
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? "\n        " + detail : ""}`); }
}
const show = (r) => `status ${r.status}, body ${r.text.slice(0, 160)}`;

const h = await req("GET", "/api/health");
if (h.data === null) {
  console.log(`FAIL  /api/health did not return JSON (${show(h)})`);
  console.log("      If this is an HTML page, Vercel Deployment Protection or a routing problem is intercepting /api.");
  process.exit(1);
}
check("GET /api/health", h.status === 200 && h.data.ok === true && h.data.service === "SlideLink", show(h));
const a = await req("GET", "/api/addresses");
check("GET /api/addresses returns an addresses array", a.status === 200 && Array.isArray(a.data?.addresses), show(a));

const s = await req("POST", "/api/sessions");
check("POST /api/sessions -> 201 with 6-digit code", s.status === 201 && /^\d{6}$/.test(s.data?.code ?? ""), show(s));
if (s.status !== 201) { console.log(`\n${passed} passed, ${failed} failed`); process.exit(1); }
const code = s.data.code;
console.log(`      (using throw-away code ${code})`);

let st = await req("GET", `/api/sessions/${code}/status`);
check("status before helper connects", st.status === 200 && st.data.agentConnected === false && st.data.remoteCount === 0 && st.data.commands === 0, show(st));

const off = await req("POST", "/api/commands", { code, command: "NEXT" });
check("command rejected while helper offline (409)", off.status === 409, show(off));

const c = await req("POST", "/api/agent/connect", { code });
check("POST /api/agent/connect", c.status === 200 && c.data?.ok === true, show(c));
const hb = await req("POST", "/api/remote/heartbeat", { code, remoteId: "smoke-test" });
check("POST /api/remote/heartbeat", hb.status === 200 && hb.data?.ok === true, show(hb));
st = await req("GET", `/api/sessions/${code}/status`);
check("status shows helper + 1 phone", st.data?.agentConnected === true && st.data?.remoteCount === 1, show(st));

const p0 = await req("GET", `/api/agent/poll?code=${code}`);
check("poll with empty queue", p0.status === 200 && p0.data?.ok === true && p0.data.command === null, show(p0));

const bad = await req("POST", "/api/commands", { code, command: "EXPLODE" });
check("unsupported command rejected (400)", bad.status === 400, show(bad));
const mal = await req("POST", "/api/commands", "{oops", true);
check("malformed JSON rejected (400)", mal.status === 400, show(mal));

// Two taps at the same instant: the atomic throttle must let exactly one through.
const [t1, t2] = await Promise.all([
  req("POST", "/api/commands", { code, command: "NEXT" }),
  req("POST", "/api/commands", { code, command: "NEXT" }),
]);
const codes = [t1.status, t2.status].sort();
check("simultaneous taps: one accepted (202), one rate-limited (429)", codes[0] === 202 && codes[1] === 429, `got ${codes}`);
const p1 = await req("GET", `/api/agent/poll?code=${code}`);
check("poll returns the NEXT command", p1.data?.command?.command === "NEXT", show(p1));
const p2 = await req("GET", `/api/agent/poll?code=${code}`);
check("command is consumed only once", p2.data?.command === null, show(p2));
st = await req("GET", `/api/sessions/${code}/status`);
check("status counts exactly 1 command", st.data?.commands === 1, show(st));

const gone = await req("GET", "/api/sessions/000000/status");
check("unknown session -> 404", gone.status === 404, show(gone));
const root = await req("GET", "/remote.html");
check("static page /remote.html is served", root.status === 200 && /<html/i.test(root.text), `status ${root.status}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
