// Minimal Upstash Redis REST client (no dependencies). Files under api/_lib are not routes.
const crypto = require("crypto");

function config() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

async function pipeline(commands) {
  const cfg = config();
  if (!cfg) throw Object.assign(new Error("storage not configured"), { code: "NO_STORAGE" });
  const res = await fetch(`${cfg.url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`Upstash responded ${res.status}`);
  const data = await res.json();
  for (const item of data) if (item && item.error) throw new Error(`Upstash error: ${item.error}`);
  return data.map((item) => item.result);
}

// Returns true if the caller is over `max` requests in the last hour for this bucket.
async function overLimit(req, bucket, max) {
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  const key = `${bucket}:rate:${crypto.createHash("sha256").update(ip).digest("hex").slice(0, 32)}`;
  const [count] = await pipeline([["INCR", key]]);
  if (count === 1) await pipeline([["EXPIRE", key, "3600"]]);
  return count > max;
}

module.exports = { config, pipeline, overLimit };
