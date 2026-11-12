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
  if (!res.ok || !data.ok) throw Object.assign(new Error(data.error || "Something went wrong. Please try again."), { status: res.status });
  return { ...data, status: res.status };
}

export function payLink(id) {
  return `${location.origin}/pay/${id}`;
}

// ---- Passkey helpers
export const b64u = {
  encode: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  decode: (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)),
};

export function rpIdForHost(host = location.hostname) {
  return host === "seedlesspay.com" || host.endsWith(".seedlesspay.com") ? "seedlesspay.com" : host;
}

// Asks the device for a passkey signature over a server challenge and signs in.
export async function signInWithPasskey(knownCredentialId) {
  const { challenge, rpId } = await api("/api/auth?action=challenge", { method: "POST", body: "{}" });
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: b64u.decode(challenge),
      rpId,
      userVerification: "required",
      timeout: 60000,
      allowCredentials: knownCredentialId ? [{ type: "public-key", id: b64u.decode(knownCredentialId) }] : [],
    },
  });
  if (!cred) throw Object.assign(new Error("cancelled"), { name: "NotAllowedError" });
  const r = cred.response;
  return api("/api/auth?action=login", {
    method: "POST",
    body: JSON.stringify({
      credentialId: b64u.encode(cred.rawId),
      authenticatorData: b64u.encode(r.authenticatorData),
      clientDataJSON: b64u.encode(r.clientDataJSON),
      signature: b64u.encode(r.signature),
    }),
  });
}

// ---- CSV (safe against spreadsheet formula injection)
export function toCsv(rows) {
  const cell = (v) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\r\n");
}

export function download(filename, text, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob(["﻿" + text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const units = (n) => (Number(BigInt(n)) / 1e6).toFixed(2);
