// Invoices API (Vercel Function). Stores invoice details in Upstash Redis.
// Payment status is NOT stored here: it is read from the SeedlessPay contract on-chain.
//
//   POST /api/invoices        create  { payee, amount, description, clientName?, fromName?, dueDate? }
//   GET  /api/invoices?id=... read one invoice
//
// Data: invoice:<id>  STRING  JSON, no expiry

const crypto = require("crypto");
const { config, pipeline, overLimit } = require("./_lib/redis");

const CHAIN_ID = 43113; // Avalanche Fuji
const CONTRACT = "0x6F6b2Fe036c6d4e74f45B4b80E3049Fc8d7CfBB3";
const TOKEN = "0x5425890298aed601595a70AB815c96711a31Bc65"; // USDC on Fuji
const MAX_AMOUNT_UNITS = 1000000n * 1000000n; // 1,000,000 USDC
const ID_RE = /^[A-Za-z0-9_-]{12}$/;

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  return {};
}

// Plain text only: trim, collapse whitespace, drop control characters, cap length.
function clean(value, max) {
  return String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

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

module.exports = async function handler(req, res) {
  if (!config()) {
    console.error("invoices: storage is not configured");
    return send(res, 503, { ok: false, error: "Invoices are not available right now. Please try again later." });
  }

  try {
    if (req.method === "GET") {
      const id = String((req.query && req.query.id) || new URL(req.url, "http://x").searchParams.get("id") || "");
      if (!ID_RE.test(id)) return send(res, 400, { ok: false, error: "This invoice link is not valid." });
      if (await overLimit(req, "invoices-read", 600)) return send(res, 429, { ok: false, error: "Too many requests. Please try again later." });
      const [raw] = await pipeline([["GET", `invoice:${id}`]]);
      if (!raw) return send(res, 404, { ok: false, error: "We could not find this invoice." });
      return send(res, 200, { ok: true, invoice: JSON.parse(raw) });
    }

    if (req.method === "POST") {
      const body = readBody(req);

      const payee = String(body.payee || "").trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(payee) || /^0x0{40}$/.test(payee)) {
        return send(res, 400, { ok: false, error: "The wallet address is not valid." });
      }
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

      const id = crypto.randomBytes(9).toString("base64url");
      const invoice = {
        id,
        payee,
        amountUnits: units.toString(),
        description,
        clientName,
        fromName,
        dueDate,
        createdAt: new Date().toISOString(),
        chainId: CHAIN_ID,
        contract: CONTRACT,
        token: TOKEN,
      };
      const [created] = await pipeline([["SET", `invoice:${id}`, JSON.stringify(invoice), "NX"]]);
      if (created !== "OK") return send(res, 500, { ok: false, error: "Something went wrong. Please try again." });
      return send(res, 201, { ok: true, invoice });
    }

    res.setHeader("Allow", "GET, POST");
    return send(res, 405, { ok: false, error: "Method not allowed." });
  } catch (err) {
    console.error("invoices:", err.message);
    return send(res, 500, { ok: false, error: "Something went wrong. Please try again." });
  }
};

module.exports.toUnits = toUnits; // exported for tests
