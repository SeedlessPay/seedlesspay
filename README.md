<p align="center">
  <img src="web/assets/logo-mark-256.png" alt="SeedlessPay logo" width="120">
</p>

<h1 align="center">SeedlessPay</h1>

<p align="center"><strong>Get paid in dollars without a bank or a seed phrase.</strong></p>

<p align="center">
  <a href="https://seedlesspay.com">seedlesspay.com</a> ·
  <a href="https://x.com/seedlesspay">@seedlesspay</a> ·
  <a href="https://testnet.snowtrace.io/address/0x6F6b2Fe036c6d4e74f45B4b80E3049Fc8d7CfBB3">Contract on Fuji</a>
</p>

SeedlessPay lets freelancers send a payment link and get paid in USDC on Avalanche, straight into a wallet they open with Face ID or a fingerprint (a passkey) instead of a seed phrase.

## The problem

Freelancers in countries that global payment platforms don't serve well struggle to get paid by overseas clients. The workarounds are slow and expensive. Stablecoins solve the money part, but seed phrases, gas tokens and wrong-network mistakes keep non-technical people out.

## How it works

```
Freelancer (passkey)            Client (any wallet)
  │ creates invoice               │ opens invoice link
  │                               │ pays USDC (approve + pay, or one-signature permit)
  ▼                               ▼
  ERC-4337 smart account  ◀────  SeedlessPay contract  ──▶ emits InvoicePaid
  (gas sponsored)                 (never holds funds)
```

- **Passkey wallet:** Avalanche's C-Chain verifies secp256r1 (P-256) signatures natively through the ACP-204 precompile, which makes WebAuthn wallets cheap.
- **USDC:** Circle's native USDC on C-Chain.
- **SeedlessPay.sol:** moves USDC straight from client to freelancer and records the invoice as paid.

## Status

| Part | Status |
|---|---|
| `SeedlessPay.sol` contract + tests | ✅ in this repo |
| Fuji testnet deployment | ✅ [`0x6F6b…fBB3`](https://testnet.snowtrace.io/address/0x6F6b2Fe036c6d4e74f45B4b80E3049Fc8d7CfBB3) |
| Passkey smart account + gas sponsorship | ✅ working on Fuji: [first passkey payment](https://testnet.snowtrace.io/tx/0xa19ccabe4e9ed9ff1330d7ded4a33edeada2de23575a6389beb435ac8780f167) (test page at `/spike`) |
| Landing page ([`web/`](web/)) | ✅ static, zero dependencies |
| Invoice app | ⏳ |

## Deployments

| Network | SeedlessPay |
|---|---|
| Fuji testnet (43113) | [`0x6F6b2Fe036c6d4e74f45B4b80E3049Fc8d7CfBB3`](https://testnet.snowtrace.io/address/0x6F6b2Fe036c6d4e74f45B4b80E3049Fc8d7CfBB3) |

## Contract

[`contracts/src/SeedlessPay.sol`](contracts/src/SeedlessPay.sol)

- `payInvoice(invoiceId, payee, amount)`: pays an invoice after the client approves USDC.
- `payInvoiceWithPermit(...)`: approve and pay in one transaction with an EIP-2612 signature.
- `isPaid(invoiceId, payee, amount)`: whether an invoice with exactly these terms is paid.

Design choices:

- **Never holds funds.** USDC goes from the client directly to the freelancer in one `transferFrom`.
- **No owner, no upgrades, no fees.** Nothing can be paused, redirected or changed after deployment.
- **Paid once.** Paying the same invoice terms twice reverts.
- **Can't be blocked.** An invoice is keyed by the hash of `(invoiceId, payee, amount)`, so someone paying the same id with different terms doesn't affect the real invoice.
- **Front-run-safe permit.** If someone submits the client's permit signature first, the payment still goes through.

### Run the tests

Requires [Foundry](https://book.getfoundry.sh/). The contracts have no external dependencies.

```sh
cd contracts
forge build
forge test -vvv
```

### Deploy

```sh
cd contracts
# Import a deployer key into Foundry's encrypted keystore (never commit keys)
cast wallet import deployer --interactive

# Fuji testnet
forge script script/Deploy.s.sol --rpc-url fuji --account deployer --broadcast
```

USDC addresses used by the deploy script:

| Network | Chain ID | USDC |
|---|---|---|
| Fuji testnet | 43113 | `0x5425890298aed601595a70AB815c96711a31Bc65` |
| Avalanche C-Chain | 43114 | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` |

## Website

The landing page in [`web/`](web/) is plain HTML and CSS with no build step. To host it on Vercel, import this repo and set **Root Directory** to `web` (Framework preset: Other).

### Waitlist

The early-access form posts to [`web/api/waitlist.js`](web/api/waitlist.js), a Vercel Function with no dependencies that stores emails in Upstash Redis (`waitlist:emails` set, `waitlist:joined` hash). Connect a database from **Vercel → Storage → Upstash for Redis**; the function reads `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` or `KV_REST_API_URL`/`KV_REST_API_TOKEN`. Signups are rate limited per hashed IP, and a honeypot field filters bots.

### Passkey wallet test (`/spike`)

[`web/spike.html`](web/spike.html) is an unlisted test page for the core flow: create a passkey (WebAuthn), derive a [Coinbase Smart Wallet](https://github.com/coinbase/smart-wallet) owned by it (via viem's `toCoinbaseSmartAccount`), and pay an invoice through `SeedlessPay.sol` with USDC approve + `payInvoice` batched in one gas-sponsored user operation.

Bundler and paymaster calls go through [`web/api/bundler.js`](web/api/bundler.js), which keeps the Pimlico API key on the server and only forwards the JSON-RPC methods the wallet needs. Set `PIMLICO_API_KEY` (and optionally `PIMLICO_SPONSORSHIP_POLICY_ID`) in Vercel.

## Builder

Built by [Sithu Nyein](https://sithunyein.com), a freelancer who has had this problem for years.
