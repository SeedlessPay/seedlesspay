// Passkey accounts (Vercel Function).
//   POST /api/auth?action=challenge   one-time challenge for passkey sign-in (5 minutes)
//   POST /api/auth?action=register    save a new wallet's passkey public key + address, start a session
//   POST /api/auth?action=login       verify a passkey signature, start a session
//   GET  /api/auth?action=me          current account
//   POST /api/auth?action=logout      end the session
//
// The passkey's private key never leaves the user's device. We only store its public key,
// which lets the user restore the same wallet on any device where their passkey is synced.

const crypto = require("crypto");
const { config, pipeline, overLimit } = require("./_lib/redis");
const { send, readBody, query, sameOrigin, rpIdFor, isAddress } = require("./_lib/http");
const { credHash, getAccount, createSession, currentSession, endSession, publicAccount } = require("./_lib/session");
const { verifyAssertion, publicKeyFromHex } = require("./_lib/webauthn");

const CRED_RE = /^[A-Za-z0-9_-]{16,1024}$/;

module.exports = async function handler(req, res) {
  if (!config()) return send(res, 503, { ok: false, error: "Accounts are not available right now. Please try again later." });
  const action = query(req, "action");

  try {
    if (req.method === "GET" && action === "me") {
      const s = await currentSession(req);
      return s ? send(res, 200, { ok: true, account: publicAccount(s.account) }) : send(res, 401, { ok: false, error: "Not signed in." });
    }

    if (req.method !== "POST") return send(res, 405, { ok: false, error: "Method not allowed." }, { Allow: "GET, POST" });
    if (!sameOrigin(req)) return send(res, 403, { ok: false, error: "Request blocked." });
    const body = readBody(req);

    if (action === "challenge") {
      if (await overLimit(req, "auth-challenge", 60)) return send(res, 429, { ok: false, error: "Too many attempts. Please try again later." });
      const challenge = crypto.randomBytes(32).toString("base64url");
      await pipeline([["SET", `chal:${challenge}`, "1", "EX", "300"]]);
      return send(res, 200, { ok: true, challenge, rpId: rpIdFor(req) });
    }

    if (action === "register") {
      if (await overLimit(req, "auth-register", 10)) return send(res, 429, { ok: false, error: "Too many attempts. Please try again later." });
      const credentialId = String(body.credentialId || "");
      const publicKey = String(body.publicKey || "");
      const wallet = String(body.wallet || "");
      if (!CRED_RE.test(credentialId) || !publicKeyFromHex(publicKey) || !isAddress(wallet)) {
        return send(res, 400, { ok: false, error: "We could not set up this wallet. Please try again." });
      }
      const h = credHash(credentialId);
      const account = { credentialId, publicKey, wallet, createdAt: new Date().toISOString() };
      const [created, linked] = await pipeline([
        ["SET", `acct:${h}`, JSON.stringify(account), "NX"],
        ["SET", `wallet:${wallet.toLowerCase()}`, h, "NX"],
      ]);
      if (created !== "OK") {
        // Already registered: the user must prove it with their passkey (login), not just by knowing the id.
        return send(res, 409, { ok: false, error: "This wallet already has an account. Please sign in with Face ID." });
      }
      if (linked !== "OK") {
        await pipeline([["DEL", `acct:${h}`]]);
        return send(res, 409, { ok: false, error: "This wallet already has an account. Please sign in with Face ID." });
      }
      return send(res, 201, { ok: true, account: publicAccount(account) }, { "Set-Cookie": await createSession(h) });
    }

    if (action === "login") {
      if (await overLimit(req, "auth-login", 30)) return send(res, 429, { ok: false, error: "Too many attempts. Please try again later." });
      const credentialId = String(body.credentialId || "");
      if (!CRED_RE.test(credentialId)) return send(res, 400, { ok: false, error: "Sign-in failed. Please try again." });
      const h = credHash(credentialId);
      const account = await getAccount(h);
      if (!account) return send(res, 404, { ok: false, error: "We could not find a wallet for this passkey. If this is a new device, make sure your passkey is synced, or create a new wallet." });

      const result = verifyAssertion({
        publicKey: account.publicKey,
        authenticatorData: body.authenticatorData,
        clientDataJSON: body.clientDataJSON,
        signature: body.signature,
        rpId: rpIdFor(req),
      });
      if (!result.ok) {
        console.warn("auth: login rejected:", result.reason);
        return send(res, 401, { ok: false, error: "Sign-in failed. Please try again." });
      }
      // Each challenge works once and only if we issued it recently.
      const [used] = await pipeline([["GETDEL", `chal:${result.challenge}`]]);
      if (!used) return send(res, 401, { ok: false, error: "Sign-in expired. Please try again." });

      return send(res, 200, { ok: true, account: publicAccount(account) }, { "Set-Cookie": await createSession(h) });
    }

    if (action === "logout") {
      const s = await currentSession(req);
      return send(res, 200, { ok: true }, { "Set-Cookie": await endSession(s && s.token) });
    }

    return send(res, 404, { ok: false, error: "Not found." });
  } catch (err) {
    console.error("auth:", err.message);
    return send(res, 500, { ok: false, error: "Something went wrong. Please try again." });
  }
};
