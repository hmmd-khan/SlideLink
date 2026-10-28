// Minimal in-memory stand-in for the parts of the Upstash client SlideLink uses.
// Every command is atomic (like real Redis) but yields to the event loop first, so
// concurrent requests genuinely interleave in tests.
export function createFakeRedis(clock) {
  const store = new Map(); // key -> { type, value, expiresAt|null }
  const tick = () => new Promise((r) => setImmediate(r));
  const now = () => clock.now();

  function live(key) {
    const e = store.get(key);
    if (!e) return null;
    if (e.expiresAt !== null && e.expiresAt <= now()) {
      store.delete(key);
      return null;
    }
    return e;
  }
  const put = (key, type, value, expiresAt = null) =>
    store.set(key, { type, value, expiresAt });
  const bound = (v) => (v === "+inf" ? Infinity : v === "-inf" ? -Infinity : Number(v));

  const impl = {
    get: (k) => { const e = live(k); return e ? e.value : null; },
    mget: (...keys) => keys.flat().map((k) => { const e = live(k); return e ? e.value : null; }),
    set(k, v, o = {}) {
      if (o.nx && live(k)) return null;
      const ms = o.px ?? (o.ex !== undefined ? o.ex * 1000 : null);
      put(k, "string", String(v), ms === null ? null : now() + ms);
      return "OK";
    },
    del: (...ks) => ks.filter((k) => live(k) && store.delete(k)).length,
    exists: (k) => (live(k) ? 1 : 0),
    incr(k) {
      const e = live(k);
      const n = (e ? Number(e.value) : 0) + 1;
      put(k, "string", String(n), e ? e.expiresAt : null);
      return n;
    },
    expire(k, sec, opt) {
      const e = live(k);
      if (!e) return 0;
      if (opt === "NX" && e.expiresAt !== null) return 0;
      e.expiresAt = now() + sec * 1000;
      return 1;
    },
    ttl(k) { const e = live(k); return !e ? -2 : e.expiresAt === null ? -1 : Math.ceil((e.expiresAt - now()) / 1000); },
    sadd(k, ...ms) {
      let e = live(k);
      if (!e) { put(k, "set", new Set()); e = store.get(k); }
      let added = 0;
      for (const m of ms) if (!e.value.has(String(m))) { e.value.add(String(m)); added++; }
      return added;
    },
    scard: (k) => { const e = live(k); return e ? e.value.size : 0; },
    rpush(k, ...vs) {
      let e = live(k);
      if (!e) { put(k, "list", []); e = store.get(k); }
      e.value.push(...vs.map(String));
      return e.value.length;
    },
    lpop(k) { const e = live(k); if (!e || e.value.length === 0) return null; return e.value.shift(); },
    llen: (k) => { const e = live(k); return e ? e.value.length : 0; },
    ltrim(k, start, stop) {
      const e = live(k);
      if (!e) return "OK";
      const n = e.value.length;
      const s = start < 0 ? Math.max(n + start, 0) : start;
      const t = stop < 0 ? n + stop : Math.min(stop, n - 1);
      e.value = e.value.slice(s, t + 1);
      return "OK";
    },
    zadd(k, { score, member }) {
      let e = live(k);
      if (!e) { put(k, "zset", new Map()); e = store.get(k); }
      const had = e.value.has(String(member));
      e.value.set(String(member), Number(score));
      return had ? 0 : 1;
    },
    zcount(k, min, max) {
      const e = live(k);
      if (!e) return 0;
      return [...e.value.values()].filter((s) => s >= bound(min) && s <= bound(max)).length;
    },
    zremrangebyscore(k, min, max) {
      const e = live(k);
      if (!e) return 0;
      let n = 0;
      for (const [m, s] of e.value) if (s >= bound(min) && s <= bound(max)) { e.value.delete(m); n++; }
      return n;
    },
  };

  const names = Object.keys(impl);
  const client = {};
  for (const name of names) {
    client[name] = async (...args) => { await tick(); return impl[name](...args); };
  }

  function makePipeline() {
    const ops = [];
    const pipe = {};
    for (const name of names) {
      pipe[name] = (...args) => { ops.push([name, args]); return pipe; };
    }
    // MULTI/pipeline: all queued commands run back-to-back with no interleaving.
    pipe.exec = async () => { await tick(); return ops.map(([n, a]) => impl[n](...a)); };
    return pipe;
  }
  client.pipeline = makePipeline;
  client.multi = makePipeline;
  client._store = store;
  return client;
}

export function createClock(start = 1_700_000_000_000) {
  const c = { t: start, now: () => c.t, advance: (ms) => { c.t += ms; } };
  return c;
}
