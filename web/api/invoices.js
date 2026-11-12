// Invoices API (Vercel Function).
//   POST /api/invoices                    create (signed in): { amount, description, clientName?, fromName?, dueDate? }
//   GET  /api/invoices?id=...             read one invoice (public, for the pay page)
//   POST /api/invoices?action=confirm     { id, txHash? } record a payment after verifying it on-chain
//
// Data:
//   invoice:<id>      STRING JSON, expires after 2 years
//   acct:<h>:inv      ZSET   invoice ids by creation time
// Payments are only recorded after the InvoicePaid event is found on-chain with the exact
// invoice id, payee and amount.

const crypto = require("crypto");
const { config, pipeline, overLimit } = require("./_lib/redis");
const { send, readBody, query, sameOrigin, clean, isTxHash } = require("./_lib/http");
const { currentSession } = require("./_lib/session");
const chain = require("./_lib/chain");

const CHAIN_ID = 43113; // Avalanche Fuji
const TTL = 60 * 60 * 24 * 365 * 2; // 2 years
const MAX_AMOUNT_UNITS = 1000000n * 1000000n; // 1,000,000 USDC
const ID_RE = /^[A-Za-z0-9_-]{12}$/;

// "12.5" -> 12500000n (USDC has 6 decimals). Returns null if invalid.
function toUnits(amount) {
  const s = String(amount == null ? "" : amount).trim();
  const m = /^(\d{1,7})(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) return null;
  return BigInt(m[1]) * 1000000n + BigInt((m[2] || "").padEnd(6, "0") || "0");
}

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// What anyone with the link may see.
function publicView(inv) {
  const { owner, createdBlock, ...rest } = inv;
  return rest;
}

async function load(id) {
  const [raw] = await pipeline([["GET", `invoice:${id}`]]);
  return raw ? JSON.parse(raw) : null;
}

async function save(inv) {
  await pipeline([["SET", `invoice:${inv.id}`, JSON.stringify(inv), "KEEPTTL"]]);
}

module.exports = async function handler(req, res) {
  if (!config()) return send(res, 503, { ok: false, error: "Invoices are not available right now. Please try again later." });

  try {
    if (req.method === "GET") {
      const id = query(req, "id");
      if (!ID_RE.test(id)) return send(res, 400, { ok: false, error: "This invoice link is not valid." });
      if (await overLimit(req, "invoices-read", 600)) return send(res, 429, { ok: false, error: "Too many requests. Please try again later." });
      const inv = await load(id);
      if (!inv) return send(res, 404, { ok: false, error: "We could not find this invoice." });
      return send(res, 200, { ok: true, invoice: publicView(inv) });
    }

    if (req.method !== "POST") return send(res, 405, { ok: false, error: "Method not allowed." }, { Allow: "GET, POST" });
    if (!sameOrigin(req)) return send(res, 403, { ok: false, error: "Request blocked." });
    const body = readBody(req);

    // ---- Record a payment (anyone may ask; we only record what the blockchain proves)
    if (query(req, "action") === "confirm") {
      const id = String(body.id || "");
      if (!ID_RE.test(id)) return send(res, 400, { ok: false, error: "This invoice link is not valid." });
      if (body.txHash != null && !isTxHash(body.txHash)) return send(res, 400, { ok: false, error: "Invalid transaction." });
      if (await overLimit(req, "invoices-confirm", 120)) return send(res, 429, { ok: false, error: "Too many requests. Please try again later." });
      const inv = await load(id);
      if (!inv) return send(res, 404, { ok: false, error: "We could not find this invoice." });
      if (inv.paid) return send(res, 200, { ok: true, invoice: publicView(inv) });

      const payment = body.txHash ? await chain.verifyInvoiceTx(inv, body.txHash) : await chain.findInvoicePayment(inv);
      if (!payment) return send(res, 202, { ok: true, pending: true, invoice: publicView(inv) });
      inv.paid = payment;
      await save(inv);
      return send(res, 200, { ok: true, invoice: publicView(inv) });
    }

    // ---- Create (signed in only; the invoice always pays the signed-in user's wallet)
    const session = await currentSession(req);
    if (!session) return send(res, 401, { ok: false, error: "Please sign in to create an invoice." });

    const units = toUnits(body.amount);
    if (units === null || units <= 0n || units > MAX_AMOUNT_UNITS) {
      return send(res, 400, { ok: false, error: "Please enter an amount between 0.01 and 1,000,000." });
    }
    if (units < 10000n) return send(res, 400, { ok: false, error: "The smallest invoice is $0.01." });

    const description = clean(body.description, 280);
    if (!description) return send(res, 400, { ok: false, error: "Please say what this invoice is for." });
    const clientName = clean(body.clientName, 80);
    const fromName = clean(body.fromName, 80);
    const dueDate = clean(body.dueDate, 10);
    if (dueDate && !validDate(dueDate)) return send(res, 400, { ok: false, error: "The due date is not valid." });

    if (await overLimit(req, "invoices-create", 30)) {
      return send(res, 429, { ok: false, error: "You have created a lot of invoices. Please try again in an hour." });
    }

    let createdBlock = null;
    try { createdBlock = await chain.blockNumber(); } catch (e) { console.warn("invoices: block number unavailable:", e.message); }

    const now = new Date();
    const inv = {
      id: crypto.randomBytes(9).toString("base64url"),
      payee: session.account.wallet,
      amountUnits: units.toString(),
      description, clientName, fromName, dueDate,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + TTL * 1000).toISOString(),
      chainId: CHAIN_ID,
      contract: chain.CONTRACT,
      token: chain.USDC,
      owner: session.h,
      createdBlock,
    };
    const [created] = await pipeline([
      ["SET", `invoice:${inv.id}`, JSON.stringify(inv), "EX", String(TTL), "NX"],
      ["ZADD", `acct:${session.h}:inv`, String(now.getTime()), inv.id],
    ]);
    if (created !== "OK") return send(res, 500, { ok: false, error: "Something went wrong. Please try again." });
    return send(res, 201, { ok: true, invoice: publicView(inv) });
  } catch (err) {
    console.error("invoices:", err.message);
    return send(res, 500, { ok: false, error: "Something went wrong. Please try again." });
  }
};

module.exports.toUnits = toUnits; // exported for tests
module.exports.publicView = publicView;
