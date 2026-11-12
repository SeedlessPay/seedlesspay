// Read-only access to Avalanche Fuji, used to verify payments before recording them.
const { keccak256 } = require("./keccak");

const RPC_URL = () => process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc";
const CONTRACT = "0x6F6b2Fe036c6d4e74f45B4b80E3049Fc8d7CfBB3";
const USDC = "0x5425890298aed601595a70AB815c96711a31Bc65";
const TOPIC_INVOICE_PAID = keccak256("InvoicePaid(bytes32,address,address,uint256)");
const TOPIC_TRANSFER = keccak256("Transfer(address,address,uint256)");
const ESCROW = "0x62342f78ca904Aea8690f0F576426DD6E1b5936E";
const TOPIC_ESCROW_FUNDED = keccak256("EscrowFunded(bytes32,bytes32,address,address,uint256)");
const SEL_GET_ESCROW = keccak256("getEscrow(bytes32)").slice(0, 10);
const SEL_GET_MILESTONE = keccak256("getMilestone(bytes32,uint256)").slice(0, 10);

const invoiceKey = (id) => keccak256(`seedlesspay:invoice:${id}`);
const topicAddress = (a) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const addressFromTopic = (t) => "0x" + String(t).slice(-40);
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

async function rpc(method, params) {
  const res = await fetch(RPC_URL(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (!res.ok) throw new Error(`RPC ${method} responded ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`RPC ${method}: ${j.error.message}`);
  return j.result;
}

const blockNumber = async () => parseInt(await rpc("eth_blockNumber", []), 16);
const receipt = (hash) => rpc("eth_getTransactionReceipt", [hash]);
async function blockTime(numberHex) {
  const b = await rpc("eth_getBlockByNumber", [numberHex, false]);
  return b ? new Date(parseInt(b.timestamp, 16) * 1000).toISOString() : null;
}

// Finds the InvoicePaid log for this invoice (exact id, payee and amount) in a list of logs.
function matchInvoicePaid(logs, invoice) {
  const key = invoiceKey(invoice.id);
  return (logs || []).find((l) => same(l.address, CONTRACT) && l.topics && same(l.topics[0], TOPIC_INVOICE_PAID)
    && same(l.topics[1], key) && same(l.topics[3], topicAddress(invoice.payee)) && BigInt(l.data) === BigInt(invoice.amountUnits)) || null;
}

async function paymentFromLog(log) {
  return {
    txHash: log.transactionHash,
    payer: addressFromTopic(log.topics[2]),
    blockNumber: parseInt(log.blockNumber, 16),
    paidAt: await blockTime(log.blockNumber),
  };
}

// Verifies a given transaction paid this invoice. Returns the payment record or null.
async function verifyInvoiceTx(invoice, txHash) {
  const r = await receipt(txHash);
  if (!r || r.status !== "0x1") return null;
  const log = matchInvoicePaid(r.logs, invoice);
  return log ? paymentFromLog({ ...log, transactionHash: txHash, blockNumber: log.blockNumber || r.blockNumber }) : null;
}

// Searches for the payment when no transaction hash is known. Starts from the newest blocks
// (recent payments are found in the first request) and stops at the invoice's creation block,
// after `maxChunks` requests, or when the time budget runs out (then the caller can retry).
async function findInvoicePayment(invoice, { chunk = 2048, maxChunks = 40, budgetMs = 7000 } = {}) {
  const started = Date.now();
  const latest = await blockNumber();
  const floor = Number.isInteger(invoice.createdBlock) ? invoice.createdBlock : 0;
  let to = latest;
  for (let i = 0; i < maxChunks && to >= floor && Date.now() - started < budgetMs; i++) {
    const from = Math.max(floor, to - chunk + 1);
    const logs = await rpc("eth_getLogs", [{ address: CONTRACT, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), topics: [TOPIC_INVOICE_PAID, invoiceKey(invoice.id)] }]);
    const log = matchInvoicePaid(logs, invoice);
    if (log) return paymentFromLog(log);
    to = from - 1;
  }
  return null;
}

// ---- Escrow invoices
// An escrow is funded by an EscrowFunded log with this invoice's id, payee and total. Because
// anyone can fund the same id with a different milestone plan, the plan is then checked against
// the contract's stored milestones (amount and due time of each), which is what the money follows.
const word = (hex, i) => "0x" + hex.replace(/^0x/, "").slice(i * 64, i * 64 + 64);
const uint32b = (n) => BigInt(n).toString(16).padStart(64, "0");

async function ethCall(data) {
  return rpc("eth_call", [{ to: ESCROW, data }, "latest"]);
}

function escrowCandidates(logs, invoice) {
  const id = invoiceKey(invoice.id);
  return (logs || []).filter((l) => same(l.address, ESCROW) && l.topics && same(l.topics[0], TOPIC_ESCROW_FUNDED)
    && same(l.topics[2], id) && same(word(l.data, 0), topicAddress(invoice.payee)) && BigInt(word(l.data, 1)) === BigInt(invoice.amountUnits));
}

async function planMatches(key, invoice) {
  const ms = invoice.escrow.milestones;
  const e = await ethCall(SEL_GET_ESCROW + key.replace(/^0x/, ""));
  const fundedAt = BigInt(word(e, 2));
  if (Number(BigInt(word(e, 3))) !== ms.length) return false;
  for (let i = 0; i < ms.length; i++) {
    const m = await ethCall(SEL_GET_MILESTONE + key.replace(/^0x/, "") + uint32b(i));
    if (BigInt(word(m, 0)) !== BigInt(ms[i].amountUnits)) return false;
    if (BigInt(word(m, 1)) - fundedAt !== BigInt(ms[i].dueDays) * 86400n) return false;
  }
  return true;
}

async function fundingFrom(logs, invoice) {
  for (const l of escrowCandidates(logs, invoice)) {
    if (!(await planMatches(l.topics[1], invoice))) continue;
    return {
      txHash: l.transactionHash,
      key: l.topics[1],
      client: addressFromTopic(l.topics[3]),
      blockNumber: parseInt(l.blockNumber, 16),
      fundedAt: await blockTime(l.blockNumber),
    };
  }
  return null;
}

async function verifyEscrowTx(invoice, txHash) {
  const r = await receipt(txHash);
  if (!r || r.status !== "0x1") return null;
  return fundingFrom((r.logs || []).map((l) => ({ ...l, transactionHash: txHash, blockNumber: l.blockNumber || r.blockNumber })), invoice);
}

async function findEscrowFunding(invoice, { chunk = 2048, maxChunks = 40, budgetMs = 7000 } = {}) {
  const started = Date.now();
  const latest = await blockNumber();
  const floor = Number.isInteger(invoice.createdBlock) ? invoice.createdBlock : 0;
  let to = latest;
  for (let i = 0; i < maxChunks && to >= floor && Date.now() - started < budgetMs; i++) {
    const from = Math.max(floor, to - chunk + 1);
    const logs = await rpc("eth_getLogs", [{ address: ESCROW, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), topics: [TOPIC_ESCROW_FUNDED, null, invoiceKey(invoice.id)] }]);
    const f = await fundingFrom(logs, invoice);
    if (f) return f;
    to = from - 1;
  }
  return null;
}

// Verifies a USDC transfer sent by `wallet` in this transaction. Returns { to, amountUnits, ... } or null.
async function verifyWithdrawal(wallet, txHash) {
  const r = await receipt(txHash);
  if (!r || r.status !== "0x1") return null;
  const log = (r.logs || []).find((l) => same(l.address, USDC) && l.topics && same(l.topics[0], TOPIC_TRANSFER) && same(l.topics[1], topicAddress(wallet)));
  if (!log) return null;
  return { txHash, to: addressFromTopic(log.topics[2]), amountUnits: BigInt(log.data).toString(), blockNumber: parseInt(r.blockNumber, 16), sentAt: await blockTime(r.blockNumber) };
}

module.exports = { CONTRACT, ESCROW, USDC, verifyEscrowTx, findEscrowFunding, TOPIC_ESCROW_FUNDED, invoiceKey, blockNumber, verifyInvoiceTx, findInvoicePayment, verifyWithdrawal, TOPIC_INVOICE_PAID, TOPIC_TRANSFER, topicAddress };
