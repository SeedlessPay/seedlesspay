// Waitlist signup endpoint (Vercel Function, Node.js runtime).
// Stores emails in Upstash Redis via its REST API. No npm dependencies.
//
// Env vars (set automatically by the Upstash integration on Vercel):
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//   or KV_REST_API_URL / KV_REST_API_TOKEN
//
// Data:
//   waitlist:emails         SET   of normalised email addresses
//   waitlist:joined         HASH  email -> ISO timestamp of first signup
//   waitlist:rate:<iphash>  INT   signups from one IP hash, expires after 1 hour

const crypto = require("crypto");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_PER_HOUR = 10;
const CONTACT = "hello@seedlesspay.com";

async function redis(url, token, commands) {
  const res = await fetch(`${url.replace(/\/$/, "")}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`Upstash responded ${res.status}`);
  const data = await res.json();
  for (const item of data) if (item && item.error) throw new Error(`Upstash error: ${item.error}`);
  return data.map((item) => item.result);
}

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return Object.fromEntries(new URLSearchParams(req.body)); }
  }
  return {};
}

module.exports = async function handler(req, res) {
  const isForm = String(req.headers["content-type"] || "").includes("application/x-www-form-urlencoded");

  const respond = (status, payload) => {
    if (isForm) {
      // No-JavaScript fallback: send the visitor back to the page with a result flag.
      res.statusCode = 303;
      res.setHeader("Location", payload.ok ? "/?joined=1#join" : "/?joined=0#join");
      return res.end();
    }
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    return res.end(JSON.stringify(payload));
  };

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return respond(405, { ok: false, error: "Method not allowed." });
  }

  const body = readBody(req);

  // Honeypot: real people never fill this hidden field. Pretend success for bots.
  if (body.company) return respond(200, { ok: true });

  const email = String(body.email || "").trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return respond(400, { ok: false, error: "Please enter a valid email address." });
  }

  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    console.error("waitlist: storage is not configured (missing Upstash env vars)");
    return respond(503, { ok: false, error: `The waitlist is not available right now. Please email ${CONTACT}.` });
  }

  try {
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
    const ipHash = crypto.createHash("sha256").update(ip).digest("hex").slice(0, 32);
    const rateKey = `waitlist:rate:${ipHash}`;

    const [count] = await redis(url, token, [["INCR", rateKey]]);
    if (count === 1) await redis(url, token, [["EXPIRE", rateKey, "3600"]]);
    if (count > MAX_PER_HOUR) {
      return respond(429, { ok: false, error: "Too many attempts. Please try again in an hour." });
    }

    const [added] = await redis(url, token, [
      ["SADD", "waitlist:emails", email],
      ["HSETNX", "waitlist:joined", email, new Date().toISOString()],
    ]);

    return respond(200, { ok: true, alreadyJoined: added === 0 });
  } catch (err) {
    console.error("waitlist:", err.message);
    return respond(500, { ok: false, error: `Something went wrong. Please try again or email ${CONTACT}.` });
  }
};
