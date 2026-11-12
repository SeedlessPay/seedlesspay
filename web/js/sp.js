// Shared helpers for the SeedlessPay app (/app) and invoice payment page (/pay/<id>).

export const VIEM = "https://esm.sh/viem@2";
export const CHAIN_ID = 43113; // Avalanche Fuji
export const USDC = "0x5425890298aed601595a70AB815c96711a31Bc65";
export const SEEDLESSPAY = "0x6F6b2Fe036c6d4e74f45B4b80E3049Fc8d7CfBB3";
export const EXPLORER = "https://testnet.snowtrace.io";

export const PAY_ABI = [
  { type: "function", name: "payInvoice", stateMutability: "nonpayable",
    inputs: [{ name: "invoiceId", type: "bytes32" }, { name: "payee", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "isPaid", stateMutability: "view",
    inputs: [{ name: "invoiceId", type: "bytes32" }, { name: "payee", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
];

let viemPromise;
// Loads viem only when needed, so pages can render invoice details without it.
export function loadViem() {
  viemPromise ??= Promise.all([import(VIEM), import(`${VIEM}/chains`), import(`${VIEM}/account-abstraction`)])
    .then(([v, chains, aa]) => ({ ...v, chain: chains.avalancheFuji, aa }));
  return viemPromise;
}

// The on-chain invoice id (bytes32) for an invoice link id.
export function invoiceKey(v, id) {
  return v.keccak256(v.toHex(`seedlesspay:invoice:${id}`));
}

export async function isPaid(v, client, invoice) {
  return client.readContract({
    address: SEEDLESSPAY, abi: PAY_ABI, functionName: "isPaid",
    args: [invoiceKey(v, invoice.id), v.getAddress(invoice.payee), BigInt(invoice.amountUnits)],
  });
}

// 12500000 -> "$12.50", 1234567890000 -> "$1,234,567.89"
export function usd(units) {
  const n = BigInt(units);
  const whole = (n / 1000000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let frac = (n % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `$${whole}.${frac}`;
}

export const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  } catch {
    throw new Error("Could not connect. Check your internet and try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
}

export function payLink(id) {
  return `${location.origin}/pay/${id}`;
}
