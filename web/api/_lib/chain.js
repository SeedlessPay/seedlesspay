// Read-only access to Avalanche Fuji, used to verify payments before recording them.
const { keccak256 } = require("./keccak");

const RPC_URL = () => process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc";
const CONTRACT = "0x6F6b2Fe036c6d4e74f45B4b80E3049Fc8d7CfBB3";
const USDC = "0x5425890298aed601595a70AB815c96711a31Bc65";
const TOPIC_INVOICE_PAID = keccak256("InvoicePaid(bytes32,address,address,uint256)");
const TOPIC_TRANSFER = keccak256("Transfer(address,address,uint256)");

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

// Searches recent blocks for the payment when no transaction hash is known.
async function findInvoicePayment(invoice, { chunk = 2048, maxChunks = 40 } = {}) {
  const latest = await blockNumber();
  let from = Number.isInteger(invoice.createdBlock) ? invoice.createdBlock : Math.max(0, latest - chunk * maxChunks);
  for (let i = 0; i < maxChunks && from <= latest; i++) {
    const to = Math.min(latest, from + chunk - 1);
    const logs = await rpc("eth_getLogs", [{ address: CONTRACT, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), topics: [TOPIC_INVOICE_PAID, invoiceKey(invoice.id)] }]);
    const log = matchInvoicePaid(logs, invoice);
    if (log) return paymentFromLog(log);
    from = to + 1;
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

module.exports = { CONTRACT, USDC, invoiceKey, blockNumber, verifyInvoiceTx, findInvoicePayment, verifyWithdrawal, TOPIC_INVOICE_PAID, TOPIC_TRANSFER, topicAddress };
