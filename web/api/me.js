// Signed-in user's data (Vercel Function).
//   GET    /api/me?r=invoices              your invoices (newest first)
//   POST   /api/me?r=import    { ids }     attach invoices created before accounts existed
//   GET    /api/me?r=addresses             saved withdrawal addresses
//   POST   /api/me?r=addresses { label, address }
//   DELETE /api/me?r=addresses&address=0x…
//   GET    /api/me?r=withdrawals           money you sent, verified on-chain
//   POST   /api/me?r=withdrawals { txHash } record a withdrawal after verifying it on-chain
//
// Data:
//   acct:<h>:inv     ZSET  invoice ids
//   acct:<h>:book    STRING JSON [{ label, address }], max 20
//   acct:<h>:wd      LIST  JSON withdrawal records, newest first, max 500
//   acct:<h>:wdtx    SET   recorded transaction hashes (no duplicates)

const { pipeline, overLimit, config } = require("./_lib/redis");
const { send, readBody, query, sameOrigin, clean, isAddress, isTxHash } = require("./_lib/http");
const { currentSession } = require("./_lib/session");
const chain = require("./_lib/chain");
const { publicView } = require("./invoices");

const ID_RE = /^[A-Za-z0-9_-]{12}$/;

module.exports = async function handler(req, res) {
  if (!config()) return send(res, 503, { ok: false, error: "This is not available right now. Please try again later." });
  try {
    const session = await currentSession(req);
    if (!session) return send(res, 401, { ok: false, error: "Please sign in again." });
    if (req.method !== "GET" && !sameOrigin(req)) return send(res, 403, { ok: false, error: "Request blocked." });
    const { h, account } = session;
    const r = query(req, "r");
    const body = readBody(req);

    // ---- Invoices
    if (r === "invoices" && req.method === "GET") {
      const [ids] = await pipeline([["ZREVRANGE", `acct:${h}:inv`, "0", "499"]]);
      if (!ids || ids.length === 0) return send(res, 200, { ok: true, invoices: [] });
      const [raws] = await pipeline([["MGET", ...ids.map((id) => `invoice:${id}`)]]);
      const invoices = [];
      const gone = [];
      raws.forEach((raw, i) => { if (raw) invoices.push(publicView(JSON.parse(raw))); else gone.push(ids[i]); });
      if (gone.length) await pipeline([["ZREM", `acct:${h}:inv`, ...gone]]); // expired after 2 years
      return send(res, 200, { ok: true, invoices });
    }

    if (r === "import" && req.method === "POST") {
      const ids = Array.isArray(body.ids) ? body.ids.filter((id) => ID_RE.test(String(id))).slice(0, 200) : [];
      let imported = 0;
      for (const id of ids) {
        const [raw] = await pipeline([["GET", `invoice:${id}`]]);
        if (!raw) continue;
        const inv = JSON.parse(raw);
        if (inv.owner || String(inv.payee).toLowerCase() !== account.wallet.toLowerCase()) continue;
        inv.owner = h;
        await pipeline([
          ["SET", `invoice:${id}`, JSON.stringify(inv), "KEEPTTL"],
          ["ZADD", `acct:${h}:inv`, String(Date.parse(inv.createdAt) || Date.now()), id],
        ]);
        imported++;
      }
      return send(res, 200, { ok: true, imported });
    }

    // ---- Saved addresses
    if (r === "addresses") {
      const [raw] = await pipeline([["GET", `acct:${h}:book`]]);
      let book = raw ? JSON.parse(raw) : [];
      if (req.method === "GET") return send(res, 200, { ok: true, addresses: book });

      if (req.method === "POST") {
        const address = String(body.address || "").trim();
        const label = clean(body.label, 40);
        if (!isAddress(address)) return send(res, 400, { ok: false, error: "Please enter a valid wallet address." });
        if (!label) return send(res, 400, { ok: false, error: "Please give this address a name, for example \"My exchange\"." });
        if (address.toLowerCase() === account.wallet.toLowerCase()) return send(res, 400, { ok: false, error: "This is your own SeedlessPay wallet." });
        book = book.filter((b) => b.address.toLowerCase() !== address.toLowerCase());
        if (book.length >= 20) return send(res, 400, { ok: false, error: "You can save up to 20 addresses. Remove one first." });
        book.unshift({ label, address, addedAt: new Date().toISOString() });
        await pipeline([["SET", `acct:${h}:book`, JSON.stringify(book)]]);
        return send(res, 200, { ok: true, addresses: book });
      }

      if (req.method === "DELETE") {
        const address = query(req, "address").toLowerCase();
        book = book.filter((b) => b.address.toLowerCase() !== address);
        await pipeline([["SET", `acct:${h}:book`, JSON.stringify(book)]]);
        return send(res, 200, { ok: true, addresses: book });
      }
    }

    // ---- Withdrawals
    if (r === "withdrawals" && req.method === "GET") {
      const [items] = await pipeline([["LRANGE", `acct:${h}:wd`, "0", "499"]]);
      return send(res, 200, { ok: true, withdrawals: (items || []).map((s) => JSON.parse(s)) });
    }

    if (r === "withdrawals" && req.method === "POST") {
      const txHash = String(body.txHash || "");
      if (!isTxHash(txHash)) return send(res, 400, { ok: false, error: "Invalid transaction." });
      if (await overLimit(req, "withdrawals-record", 120)) return send(res, 429, { ok: false, error: "Too many requests. Please try again later." });
      const record = await chain.verifyWithdrawal(account.wallet, txHash);
      if (!record) return send(res, 202, { ok: true, pending: true });
      const [isNew] = await pipeline([["SADD", `acct:${h}:wdtx`, txHash.toLowerCase()]]);
      if (isNew === 1) {
        const [raw] = await pipeline([["GET", `acct:${h}:book`]]);
        const saved = (raw ? JSON.parse(raw) : []).find((b) => b.address.toLowerCase() === record.to.toLowerCase());
        if (saved) record.label = saved.label;
        await pipeline([["LPUSH", `acct:${h}:wd`, JSON.stringify(record)], ["LTRIM", `acct:${h}:wd`, "0", "499"]]);
      }
      return send(res, 200, { ok: true, withdrawal: record });
    }

    return send(res, 404, { ok: false, error: "Not found." });
  } catch (err) {
    console.error("me:", err.message);
    return send(res, 500, { ok: false, error: "Something went wrong. Please try again." });
  }
};
