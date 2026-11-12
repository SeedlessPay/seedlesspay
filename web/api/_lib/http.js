// Small HTTP helpers shared by the API functions.

function send(res, status, payload, headers = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  return {};
}

function query(req, name) {
  if (req.query && req.query[name] != null) return String(req.query[name]);
  return new URL(req.url || "/", "http://x").searchParams.get(name) || "";
}

// Blocks cross-site form posts: the browser's Origin must match the host it is talking to.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function cookie(req, name) {
  const raw = String(req.headers.cookie || "");
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

// The WebAuthn relying party for this request: seedlesspay.com (covers www) or the plain host for previews/tests.
function rpIdFor(req) {
  const host = String(req.headers.host || "").split(":")[0].toLowerCase();
  return host === "seedlesspay.com" || host.endsWith(".seedlesspay.com") ? "seedlesspay.com" : host;
}

// Plain text only: drop control characters, collapse spaces, cap length.
function clean(value, max) {
  return String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/.test(a);
const isTxHash = (h) => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);

module.exports = { send, readBody, query, sameOrigin, cookie, rpIdFor, clean, isAddress, isTxHash };
