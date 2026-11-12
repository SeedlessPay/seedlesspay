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

const { config, pipeline, overLimit } = require("./_lib/redis");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_PER_HOUR = 10;
const CONTACT = "hello@seedlesspay.com";

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

  if (!config()) {
    console.error("waitlist: storage is not configured (missing Upstash env vars)");
    return respond(503, { ok: false, error: `The waitlist is not available right now. Please email ${CONTACT}.` });
  }

  try {
    if (await overLimit(req, "waitlist", MAX_PER_HOUR)) {
      return respond(429, { ok: false, error: "Too many attempts. Please try again in an hour." });
    }

    const [added] = await pipeline([
      ["SADD", "waitlist:emails", email],
      ["HSETNX", "waitlist:joined", email, new Date().toISOString()],
    ]);

    return respond(200, { ok: true, alreadyJoined: added === 0 });
  } catch (err) {
    console.error("waitlist:", err.message);
    return respond(500, { ok: false, error: `Something went wrong. Please try again or email ${CONTACT}.` });
  }
};
