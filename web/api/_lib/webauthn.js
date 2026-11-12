// WebAuthn (passkey) sign-in verification for P-256 keys, using Node's built-in crypto.
const crypto = require("crypto");

const b64u = (s) => Buffer.from(String(s), "base64url");

// Accepts 0x04||X||Y (65 bytes) or X||Y (64 bytes) hex. Returns a Node KeyObject or null.
function publicKeyFromHex(hex) {
  const h = String(hex || "").replace(/^0x/, "").toLowerCase();
  let xy;
  if (/^04[0-9a-f]{128}$/.test(h)) xy = h.slice(2);
  else if (/^[0-9a-f]{128}$/.test(h)) xy = h;
  else return null;
  try {
    return crypto.createPublicKey({
      key: { kty: "EC", crv: "P-256", x: Buffer.from(xy.slice(0, 64), "hex").toString("base64url"), y: Buffer.from(xy.slice(64), "hex").toString("base64url") },
      format: "jwk",
    });
  } catch { return null; }
}

function originAllowed(origin, rpId) {
  try {
    const u = new URL(origin);
    const okHost = u.hostname === rpId || u.hostname.endsWith(`.${rpId}`);
    const okProto = u.protocol === "https:" || u.hostname === "localhost";
    return okHost && okProto;
  } catch { return false; }
}

// Returns { ok: true, challenge } or { ok: false, reason }.
function verifyAssertion({ publicKey, authenticatorData, clientDataJSON, signature, rpId }) {
  const key = publicKeyFromHex(publicKey);
  if (!key) return { ok: false, reason: "bad public key" };
  let client;
  const clientBytes = b64u(clientDataJSON);
  try { client = JSON.parse(clientBytes.toString("utf8")); } catch { return { ok: false, reason: "bad client data" }; }
  if (client.type !== "webauthn.get") return { ok: false, reason: "wrong type" };
  if (!originAllowed(client.origin, rpId)) return { ok: false, reason: "wrong origin" };

  const auth = b64u(authenticatorData);
  if (auth.length < 37) return { ok: false, reason: "bad authenticator data" };
  const rpIdHash = crypto.createHash("sha256").update(rpId).digest();
  if (!auth.subarray(0, 32).equals(rpIdHash)) return { ok: false, reason: "wrong rp id" };
  const flags = auth[32];
  if (!(flags & 0x01) || !(flags & 0x04)) return { ok: false, reason: "user not verified" };

  const signed = Buffer.concat([auth, crypto.createHash("sha256").update(clientBytes).digest()]);
  let valid = false;
  try { valid = crypto.verify("sha256", signed, { key, dsaEncoding: "der" }, b64u(signature)); } catch { valid = false; }
  if (!valid) return { ok: false, reason: "bad signature" };
  return { ok: true, challenge: String(client.challenge || "") };
}

module.exports = { verifyAssertion, publicKeyFromHex };
