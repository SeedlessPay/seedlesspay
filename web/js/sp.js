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

// ---- Escrow (milestone) invoices
export const ESCROW = "0x62342f78ca904Aea8690f0F576426DD6E1b5936E";
export const REVIEW_DAYS = 7;
export const DISPUTE_DAYS = 30;

const b32 = { name: "key", type: "bytes32" };
const idx = { name: "index", type: "uint256" };
const fn = (name, inputs, outputs = [], stateMutability = "nonpayable") => ({ type: "function", name, stateMutability, inputs, outputs });
export const ESCROW_ABI = [
  fn("fund", [{ name: "escrowId", type: "bytes32" }, { name: "payee", type: "address" }, { name: "amounts", type: "uint256[]" }, { name: "dueIn", type: "uint64[]" }], [{ type: "bytes32" }]),
  fn("escrowKey", [{ name: "escrowId", type: "bytes32" }, { name: "payee", type: "address" }, { name: "amounts", type: "uint256[]" }, { name: "dueIn", type: "uint64[]" }], [{ type: "bytes32" }], "pure"),
  fn("getEscrow", [b32], [{ name: "client", type: "address" }, { name: "payee", type: "address" }, { name: "fundedAt", type: "uint64" }, { name: "count", type: "uint8" }], "view"),
  fn("getMilestone", [b32, idx], [{ type: "tuple", components: [
    { name: "amount", type: "uint128" }, { name: "dueAt", type: "uint64" }, { name: "deliveredAt", type: "uint64" },
    { name: "disputedAt", type: "uint64" }, { name: "status", type: "uint8" }, { name: "splitProposer", type: "address" },
    { name: "splitToPayee", type: "uint128" },
  ] }], "view"),
  ...["markDelivered", "claim", "returnToClient", "approve", "raiseIssue", "refund"].map((n) => fn(n, [b32, idx])),
  fn("proposeSplit", [b32, idx, { name: "toPayee", type: "uint256" }]),
  fn("acceptSplit", [b32, idx, { name: "toPayee", type: "uint256" }]),
];

// Contract status codes.
export const MS = { Locked: 1, Delivered: 2, Disputed: 3, Released: 4, Refunded: 5, Split: 6 };

// The arguments that identify an escrow invoice on-chain.
export function escrowArgs(v, invoice) {
  const ms = invoice.escrow.milestones;
  return [invoiceKey(v, invoice.id), v.getAddress(invoice.payee), ms.map((m) => BigInt(m.amountUnits)), ms.map((m) => BigInt(m.dueDays) * 86400n)];
}

export async function escrowKeyOf(v, client, invoice) {
  return client.readContract({ address: ESCROW, abi: ESCROW_ABI, functionName: "escrowKey", args: escrowArgs(v, invoice) });
}

// Reads the escrow and every milestone. Returns null if it has not been funded.
export async function readEscrow(v, client, invoice) {
  const key = await escrowKeyOf(v, client, invoice);
  const [who, , fundedAt, count] = await client.readContract({ address: ESCROW, abi: ESCROW_ABI, functionName: "getEscrow", args: [key] });
  if (/^0x0{40}$/i.test(who)) return null;
  const milestones = await Promise.all(Array.from({ length: Number(count) }, (_, i) =>
    client.readContract({ address: ESCROW, abi: ESCROW_ABI, functionName: "getMilestone", args: [key, BigInt(i)] })));
  return { key, client: who, fundedAt: Number(fundedAt), milestones };
}

// Plain-language state of one milestone at time `now` (seconds), with the dates that matter.
export function milestoneState(m, now = Math.floor(Date.now() / 1000)) {
  const s = Number(m.status);
  const dueAt = Number(m.dueAt), deliveredAt = Number(m.deliveredAt), disputedAt = Number(m.disputedAt);
  const reviewEnds = deliveredAt + REVIEW_DAYS * 86400;
  const disputeEnds = disputedAt + DISPUTE_DAYS * 86400;
  const when = (t) => formatDate(new Date(t * 1000).toISOString());
  const st = { status: s, dueAt, reviewEnds, disputeEnds, open: s >= 1 && s <= 3 };
  if (s === MS.Locked) return { ...st, label: "Locked", tone: "wait", overdue: now >= dueAt,
    text: now >= dueAt ? `Not delivered by ${when(dueAt)}` : `Due ${when(dueAt)}` };
  if (s === MS.Delivered) return { ...st, label: "Delivered", tone: "wait", reviewOver: now >= reviewEnds,
    text: now >= reviewEnds ? "Review time is over" : `Pays automatically after ${when(reviewEnds)}` };
  if (s === MS.Disputed) return { ...st, label: "Issue raised", tone: "warn", deadlocked: now >= disputeEnds,
    text: now >= disputeEnds ? "Unresolved for 30 days" : `Returns to the client on ${when(disputeEnds)} if not resolved` };
  if (s === MS.Released) return { ...st, label: "Paid", tone: "paid", text: "Paid to the freelancer" };
  if (s === MS.Refunded) return { ...st, label: "Returned", tone: "muted", text: "Returned to the client" };
  if (s === MS.Split) return { ...st, label: "Split", tone: "paid", text: "Divided by agreement" };
  return { ...st, label: "—", tone: "muted", text: "" };
}

// Overall state of an escrow for list views.
export function escrowSummary(escrow) {
  if (!escrow) return { label: "Not funded", tone: "wait", released: 0n };
  let released = 0n, open = 0;
  for (const m of escrow.milestones) {
    const s = Number(m.status);
    if (s === MS.Released) released += BigInt(m.amount);
    if (s === MS.Split) released += BigInt(m.splitToPayee);
    if (s >= 1 && s <= 3) open++;
  }
  return open ? { label: "In escrow", tone: "wait", released } : { label: "Completed", tone: "paid", released };
}

// Renders the milestone list. `role` is "client", "freelancer" or null (read only).
// `act(name, index, toPayee?)` performs a contract call and resolves when it is done.
export function renderMilestones(ul, invoice, escrow, role, act) {
  ul.textContent = "";
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  invoice.escrow.milestones.forEach((plan, i) => {
    const m = escrow && escrow.milestones[i];
    const st = m ? milestoneState(m) : null;
    const amount = BigInt(plan.amountUnits);
    const li = el("li", "ms");
    const head = el("div", "ms__head");
    const left = el("div");
    left.append(el("p", "ms__title", `${i + 1}. ${plan.title}`),
      el("p", "muted small", st ? st.text : `Due ${plan.dueDays} day${plan.dueDays === 1 ? "" : "s"} after payment`));
    const right = el("div", "ms__side");
    right.append(el("p", "ms__amount", usd(amount)));
    if (st) right.append(el("span", `pill pill--${st.tone}`, st.label));
    head.append(left, right); li.append(head);

    if (m && st.status === MS.Split) li.append(el("p", "muted small", `${usd(m.splitToPayee)} to the freelancer, ${usd(amount - BigInt(m.splitToPayee))} back to the client.`));

    if (m && st.open && role) {
      const me = role === "client" ? escrow.client : invoice.payee;
      const proposer = String(m.splitProposer);
      const theirProposal = !/^0x0{40}$/i.test(proposer) && proposer.toLowerCase() !== String(me).toLowerCase();
      const mine = !/^0x0{40}$/i.test(proposer) && !theirProposal;
      const bar = el("div", "ms__actions");
      const msg = el("p", "form__msg small");
      const button = (text, cls, name, arg, confirmText) => {
        const b = el("button", cls, text); b.type = "button";
        b.onclick = async () => {
          if (confirmText && !confirm(confirmText)) return;
          bar.querySelectorAll("button").forEach((x) => (x.disabled = true));
          msg.className = "form__msg small"; msg.textContent = "Confirm in your wallet…";
          try { await act(name, i, arg); msg.textContent = ""; }
          catch (e) { msg.className = "form__msg small form__msg--error"; msg.textContent = (e && e.userMessage) || "That did not go through. Nothing changed. Please try again."; }
          finally { bar.querySelectorAll("button").forEach((x) => (x.disabled = false)); }
        };
        bar.append(b);
      };
      const toPayee = BigInt(m.splitToPayee);
      if (theirProposal) {
        const other = role === "client" ? "The freelancer" : "The client";
        li.append(el("p", "ms__note", `${other} proposes: ${usd(toPayee)} to the freelancer and ${usd(amount - toPayee)} back to the client.`));
        button("Accept split", "btn btn--small", "acceptSplit", toPayee, `Accept the split? ${usd(toPayee)} goes to the freelancer and ${usd(amount - toPayee)} goes back to the client. This cannot be undone.`);
      } else if (mine) {
        li.append(el("p", "ms__note", `You proposed ${usd(toPayee)} to the freelancer and ${usd(amount - toPayee)} back to the client. Waiting for the other side.`));
      }

      if (role === "client") {
        button(`Approve and pay ${usd(amount)}`, "btn btn--small", "approve", null, `Pay ${usd(amount)} to the freelancer for "${plan.title}"? This cannot be undone.`);
        if (st.status === MS.Delivered && !st.reviewOver) button("Raise an issue", "btn btn--small btn--ghost", "raiseIssue", null,
          "Raise an issue? The money stays locked while you sort it out with the freelancer. If it is not resolved within 30 days, you can take it back.");
        if ((st.status === MS.Locked && st.overdue) || (st.status === MS.Disputed && st.deadlocked)) button(`Take back ${usd(amount)}`, "btn btn--small btn--ghost", "refund", null, `Return ${usd(amount)} to your wallet?`);
      } else {
        if (st.status === MS.Locked) button("Mark as delivered", "btn btn--small", "markDelivered", null, `Mark "${plan.title}" as delivered? The client then has 7 days to approve it or raise an issue. If they do neither, you can claim the money.`);
        if (st.status === MS.Disputed) button("Deliver again", "btn btn--small", "markDelivered", null, "Mark it as delivered again? The client gets a new 7-day review.");
        if (st.status === MS.Delivered && st.reviewOver) button(`Claim ${usd(amount)}`, "btn btn--small", "claim");
        button("Return to client", "btn btn--small btn--ghost", "returnToClient", null, `Return ${usd(amount)} to the client? This cannot be undone.`);
      }

      // Propose a split
      const toggle = el("button", "link small", "Propose a split"); toggle.type = "button";
      const form = el("div", "ms__split"); form.hidden = true;
      const input = el("input"); input.inputMode = "decimal"; input.placeholder = "Amount to the freelancer"; input.setAttribute("aria-label", "Amount to the freelancer");
      const send = el("button", "btn btn--small", "Propose"); send.type = "button";
      send.onclick = async () => {
        const s = input.value.trim().replace(/[$,\s]/g, "");
        const mm = /^(\d{1,7})(?:\.(\d{1,6}))?$/.exec(s);
        const units = mm ? BigInt(mm[1]) * 1000000n + BigInt((mm[2] || "").padEnd(6, "0") || "0") : null;
        if (units === null || units > amount) { msg.className = "form__msg small form__msg--error"; msg.textContent = `Enter an amount from 0 to ${usd(amount)}.`; return; }
        send.disabled = true; msg.className = "form__msg small"; msg.textContent = "Confirm in your wallet…";
        try { await act("proposeSplit", i, units); msg.textContent = ""; }
        catch (e) { msg.className = "form__msg small form__msg--error"; msg.textContent = (e && e.userMessage) || "That did not go through. Nothing changed. Please try again."; }
        finally { send.disabled = false; }
      };
      form.append(input, send);
      toggle.onclick = () => { form.hidden = !form.hidden; if (!form.hidden) input.focus(); };
      bar.append(toggle);
      li.append(bar, form, msg);
    }
    ul.append(li);
  });
}
