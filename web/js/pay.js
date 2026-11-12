// Invoice payment page (/pay/<id>): pay a normal invoice, or fund and manage an escrow invoice.
import {
  loadViem, USDC, SEEDLESSPAY, PAY_ABI, ESCROW, ESCROW_ABI, EXPLORER, invoiceKey, isPaid, usd, short, formatDate, api,
  escrowArgs, readEscrow, escrowSummary, renderMilestones,
} from "/js/sp.js";

const $ = (id) => document.getElementById(id);
const say = (text, kind, el = $("pay-msg")) => { el.textContent = text; el.className = "form__msg center" + (kind ? ` form__msg--${kind}` : ""); };

const parts = location.pathname.split("/").filter(Boolean);
const id = new URLSearchParams(location.search).get("i") || (parts[0] === "pay" ? parts[1] : "");

let invoice, v, client, chosen, wallet, from, escrow;

// ---------- Wallets (EIP-6963: every extension, not only window.ethereum)
const providers = [];
window.addEventListener("eip6963:announceProvider", (e) => {
  const d = e.detail;
  if (d && d.info && d.provider && !providers.some((p) => p.info.uuid === d.info.uuid)) providers.push(d);
});
window.dispatchEvent(new Event("eip6963:requestProvider"));

// The wallet's own logo (EIP-6963 icon), or a letter badge if it has none or it fails to load.
function walletIcon(info) {
  const letter = () => { const s = document.createElement("span"); s.className = "wallet-opt__letter"; s.textContent = (info.name || "?").trim().charAt(0).toUpperCase(); return s; };
  const icon = String(info.icon || "").trim();
  if (!/^data:image\//i.test(icon) && !/^https:\/\//i.test(icon)) return letter();
  const img = document.createElement("img");
  img.src = icon; img.alt = ""; img.width = 28; img.height = 28; img.referrerPolicy = "no-referrer";
  img.onerror = () => img.replaceWith(letter());
  return img;
}

// Shows the wallet chooser; resolves with the chosen provider.
function chooseWallet() {
  return new Promise((resolve) => {
    const list = $("wallet-list");
    list.textContent = "";
    for (const p of providers) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "wallet-opt";
      b.append(walletIcon(p.info));
      const name = document.createElement("span"); name.textContent = p.info.name; b.append(name);
      b.onclick = () => { $("wallets").hidden = true; resolve(p.provider); };
      list.append(b);
    }
    $("pay-area").hidden = false; $("pay").hidden = true; $("wallets").hidden = false;
  });
}

function walletError(e) {
  console.error(e);
  const code = e && (e.code ?? (e.cause && e.cause.code));
  const m = String((e && (e.shortMessage || e.message)) || "");
  if (code === 4001 || /reject|denied|cancel/i.test(m)) return "You cancelled in your wallet. No money was sent.";
  if (/insufficient funds|gas/i.test(m)) return "Your wallet needs a little AVAX to pay the network fee.";
  if (/fetch|network|connect/i.test(m)) return "Could not connect. Check your internet and try again.";
  return "That did not go through. No money was sent. Please try again.";
}

async function useFuji(w) {
  try { await w.switchChain({ id: v.chain.id }); }
  catch (e) {
    const code = e && (e.code ?? (e.cause && e.cause.code));
    if (code === 4902 || /4902|not been added|unrecognized chain/i.test(String(e.message))) await w.addChain({ chain: v.chain });
    else throw e;
  }
}

// Connects a wallet on Avalanche. Returns false if there is no wallet in this browser.
async function connect(msg) {
  if (wallet && from) return true;
  if (!chosen) {
    if (providers.length > 1) chosen = await chooseWallet();
    else chosen = providers.length === 1 ? providers[0].provider : window.ethereum;
  }
  if (!chosen) { $("pay-area").hidden = false; $("no-wallet").hidden = false; $("pay").hidden = true; return false; }
  v = v || await loadViem();
  client = client || v.createPublicClient({ chain: v.chain, transport: v.http() });
  const w = v.createWalletClient({ chain: v.chain, transport: v.custom(chosen) });
  msg("Connect your wallet to continue.");
  [from] = await w.requestAddresses();
  msg("Switching your wallet to Avalanche…");
  await useFuji(w);
  wallet = w;
  msg("");
  return true;
}

// Checks gas and USDC, then approves `spender` for `units` if needed.
async function prepareUsdc(units, spender) {
  const gas = await client.getBalance({ address: from });
  if (gas === 0n) { say("Your wallet has no AVAX to pay the small network fee. Add a little AVAX on the Avalanche test network and try again.", "error"); return null; }
  const balance = await client.readContract({ address: USDC, abi: v.erc20Abi, functionName: "balanceOf", args: [from] });
  if (balance < units) { say(`This wallet has ${usd(balance)} USDC. You need ${usd(units)} to pay this invoice.`, "error"); return null; }
  const allowance = await client.readContract({ address: USDC, abi: v.erc20Abi, functionName: "allowance", args: [from, spender] });
  const twoSteps = allowance < units;
  if (twoSteps) {
    say("Step 1 of 2: allow SeedlessPay to send this amount of USDC. Confirm in your wallet.");
    const h = await wallet.writeContract({ account: from, address: USDC, abi: v.erc20Abi, functionName: "approve", args: [spender, units] });
    say("Step 1 of 2: waiting for confirmation…");
    const r = await client.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") { say("The approval did not go through. No money was sent.", "error"); return null; }
  }
  return { twoSteps };
}

// Asks the server to verify the payment on-chain and save the receipt.
async function record(txHash) {
  try {
    const r = await api("/api/invoices?action=confirm", { method: "POST", body: JSON.stringify(txHash ? { id: invoice.id, txHash } : { id: invoice.id }) });
    if (r.invoice) invoice = r.invoice;
    if (invoice.paid) showPaid(invoice.paid);
  } catch (e) { console.warn("could not record payment", e); }
}

// ---------- Normal invoices
function showPaid(paid) {
  $("status").textContent = "Paid"; $("status").className = "pill pill--paid";
  $("pay-area").hidden = true; $("paid-box").hidden = false;
  if (paid && paid.paidAt) $("paid-text").textContent = `Paid in full on ${formatDate(paid.paidAt)} from ${short(paid.payer)}.`;
  if (paid && paid.txHash) { $("receipt").href = `${EXPLORER}/tx/${paid.txHash}`; $("receipt").hidden = false; }
}

async function payInvoice() {
  const units = BigInt(invoice.amountUnits);
  if (await isPaid(v, client, invoice)) { showPaid(invoice.paid); return record(); }
  const prep = await prepareUsdc(units, SEEDLESSPAY);
  if (!prep) return;
  say(prep.twoSteps ? "Step 2 of 2: confirm the payment in your wallet." : "Confirm the payment in your wallet.");
  const hash = await wallet.writeContract({ account: from, address: SEEDLESSPAY, abi: PAY_ABI, functionName: "payInvoice", args: [invoiceKey(v, invoice.id), v.getAddress(invoice.payee), units] });
  say("Sending your payment…");
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") return say("The payment did not go through. No money was sent.", "error");
  say("");
  showPaid({ txHash: hash });
  record(hash);
}

// ---------- Escrow invoices
async function fundEscrow() {
  if (await refreshEscrow()) return;
  const units = BigInt(invoice.amountUnits);
  const prep = await prepareUsdc(units, ESCROW);
  if (!prep) return;
  say(prep.twoSteps ? "Step 2 of 2: confirm the payment into escrow in your wallet." : "Confirm the payment into escrow in your wallet.");
  const hash = await wallet.writeContract({ account: from, address: ESCROW, abi: ESCROW_ABI, functionName: "fund", args: escrowArgs(v, invoice) });
  say("Locking your payment in escrow…");
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") return say("The payment did not go through. No money was sent.", "error");
  say("");
  await record(hash);
  await refreshEscrow();
}

// Reads the escrow from the chain and redraws. Returns true if it is funded.
async function refreshEscrow() {
  escrow = await readEscrow(v, client, invoice);
  drawEscrow();
  if (escrow && !invoice.funded) record();
  return !!escrow;
}

function drawEscrow() {
  const isClient = !!(escrow && from && escrow.client.toLowerCase() === from.toLowerCase());
  renderMilestones($("milestones"), invoice, escrow, isClient ? "client" : null, escrowAct);
  if (!escrow) return;
  const sum = escrowSummary(escrow);
  $("status").textContent = sum.label; $("status").className = `pill pill--${sum.tone}`;
  $("pay-area").hidden = true;
  $("escrow-intro").textContent = isClient
    ? "You paid into escrow. Approve each milestone when you are happy with the work. If you say nothing for 7 days after a delivery, it is paid automatically."
    : `Paid into escrow from ${short(escrow.client)}. To approve milestones, connect the wallet that paid.`;
  $("connect-manage").hidden = isClient || sum.label === "Completed";
  if (from && !isClient) say("The connected wallet did not pay this invoice. Switch to the wallet that paid and try again.", "error", $("manage-msg"));
  else say("", "", $("manage-msg"));
}

async function escrowAct(name, index, arg) {
  const args = arg == null ? [escrow.key, BigInt(index)] : [escrow.key, BigInt(index), arg];
  try {
    const hash = await wallet.writeContract({ account: from, address: ESCROW, abi: ESCROW_ABI, functionName: name, args });
    const r = await client.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error("reverted");
  } catch (e) {
    throw Object.assign(new Error("failed"), { userMessage: walletError(e).replace("No money was sent.", "Nothing changed.") });
  }
  await refreshEscrow();
}

$("connect-manage").onclick = async () => {
  try { if (await connect((t) => say(t, "", $("manage-msg")))) drawEscrow(); }
  catch (e) { say(walletError(e).replace("No money was sent. ", ""), "error", $("manage-msg")); }
};

// ---------- Page
$("pay").onclick = async () => {
  const btn = $("pay");
  btn.disabled = true;
  try {
    if (!(await connect((t) => say(t)))) return;
    $("pay").hidden = false;
    await (invoice.escrow ? fundEscrow() : payInvoice());
  } catch (e) { say(walletError(e), "error"); }
  finally { btn.disabled = false; }
};
$("open-metamask").href = `https://metamask.app.link/dapp/${location.host}${location.pathname}${location.search}`;

function render() {
  $("from").textContent = invoice.fromName || short(invoice.payee);
  $("amount").textContent = usd(invoice.amountUnits);
  $("description").textContent = invoice.description;
  if (invoice.clientName) { $("client").textContent = invoice.clientName; $("row-client").hidden = false; }
  if (invoice.dueDate) { $("due").textContent = formatDate(invoice.dueDate); $("row-due").hidden = false; }
  $("payee").textContent = invoice.payee;
  if (invoice.escrow) {
    $("escrow-box").hidden = false;
    $("payee-label").textContent = "Freelancer's wallet";
    $("pay").textContent = `Pay ${usd(invoice.amountUnits)} into escrow`;
    $("footnote").innerHTML = 'Escrow money is held by a public contract with no owner. Not even SeedlessPay can move it. <a href="/terms">Terms</a>';
    renderMilestones($("milestones"), invoice, null, null, escrowAct);
  } else {
    $("pay").textContent = `Pay ${usd(invoice.amountUnits)}`;
  }
  document.title = `Pay ${usd(invoice.amountUnits)} · SeedlessPay`;
  $("loading").hidden = true; $("card").hidden = false;
}

(async () => {
  if (!/^[A-Za-z0-9_-]{12}$/.test(id || "")) { $("loading").hidden = true; $("missing").hidden = false; return; }
  try {
    ({ invoice } = await api(`/api/invoices?id=${encodeURIComponent(id)}`));
  } catch (e) {
    $("loading").hidden = true; $("missing").hidden = false;
    if (!/find/i.test(e.message)) $("missing-text").textContent = e.message;
    return;
  }
  render();
  if (invoice.paid) return showPaid(invoice.paid);
  try {
    v = await loadViem();
    client = v.createPublicClient({ chain: v.chain, transport: v.http() });
    if (invoice.escrow) { if (!(await refreshEscrow())) $("status").textContent = "Unpaid"; return; }
    if (await isPaid(v, client, invoice)) { showPaid(); record(); }
    else { $("status").textContent = "Unpaid"; }
  } catch (e) {
    console.error(e);
    $("status").textContent = "Status unavailable";
  }
})();
