// Vercel Function entry point. All /api/* requests are rewritten here (see vercel.json).
// Shared logic lives in ../lib so this file stays tiny; Vercel traces the import.
import { Redis } from "@upstash/redis";
import { createHandler, StorageConfigError } from "../lib/slidelink-core.mjs";

let client;

// Works with the variable names the Vercel + Upstash integration creates (KV_REST_API_*)
// and with Upstash's own names (UPSTASH_REDIS_REST_*). Secrets are never logged.
function getRedis() {
  if (client) return client;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new StorageConfigError(
      "Missing KV_REST_API_URL / KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL / _TOKEN)"
    );
  }
  // Raw strings in, raw strings out: no surprise JSON auto-parsing of stored values.
  client = new Redis({ url, token, automaticDeserialization: false });
  return client;
}

export default { fetch: createHandler(getRedis) };
