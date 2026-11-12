// Accounts and sessions stored in Upstash Redis.
//   acct:<h>            JSON { credentialId, publicKey, wallet, createdAt }   (h = sha256 of credential id)
//   wallet:<address>    h
//   sess:<token>        h, expires after 30 days
const crypto = require("crypto");
const { pipeline } = require("./redis");
const { cookie } = require("./http");

const COOKIE = "sp_session";
const SESSION_TTL = 60 * 60 * 24 * 30;

const credHash = (credentialId) => crypto.createHash("sha256").update(String(credentialId)).digest("hex").slice(0, 40);

async function getAccount(h) {
  const [raw] = await pipeline([["GET", `acct:${h}`]]);
  return raw ? JSON.parse(raw) : null;
}

async function createSession(h) {
  const token = crypto.randomBytes(32).toString("base64url");
  await pipeline([["SET", `sess:${token}`, h, "EX", String(SESSION_TTL)]]);
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`;
}

// Returns { token, h, account } for a valid session, or null.
async function currentSession(req) {
  const token = cookie(req, COOKIE);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [h] = await pipeline([["GET", `sess:${token}`]]);
  if (!h) return null;
  const account = await getAccount(h);
  return account ? { token, h, account } : null;
}

async function endSession(token) {
  if (token) await pipeline([["DEL", `sess:${token}`]]);
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

const publicAccount = (a) => ({ credentialId: a.credentialId, publicKey: a.publicKey, wallet: a.wallet, createdAt: a.createdAt });

module.exports = { credHash, getAccount, createSession, currentSession, endSession, publicAccount };
