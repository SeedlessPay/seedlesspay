# SeedlessPay

**Get paid in dollars. No bank. No seed phrase.**

SeedlessPay lets freelancers send an invoice link and get paid in USDC on Avalanche, into a wallet secured by Face ID or a fingerprint (a passkey) instead of a seed phrase.

[seedlesspay.com](https://seedlesspay.com) · [@seedlesspay](https://x.com/seedlesspay)

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
| Passkey smart account + gas sponsorship | ⏳ |
| Invoice app (Next.js) | ⏳ |

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

## Builder

Built by [Sithu Nyein](https://sithunyein.com), a freelancer who has had this problem for years.
