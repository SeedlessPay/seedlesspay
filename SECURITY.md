# Security Policy

SeedlessPay helps people get paid, so the safety of their money comes first. Thank you for helping keep SeedlessPay and its users safe.

## Current status

- SeedlessPay is in **beta on the Avalanche Fuji test network**. Test USDC has no real value.
- The smart contracts are **not audited yet**. An independent security review is planned before the mainnet launch.
- The contracts have no owner, no admin key and no upgrade path. Once deployed, nobody can change or pause them, which also means a bug cannot be patched in place. Fixes ship as new contract deployments.

## Reporting a vulnerability

Please do **not** report security issues in public GitHub issues, pull requests, X, Telegram or any other public channel.

Report privately in one of these ways:

1. **GitHub private vulnerability reporting:** open the [Security tab](https://github.com/SeedlessPay/seedlesspay/security) of this repository and click **Report a vulnerability**.
2. **Email:** [hello@seedlesspay.com](mailto:hello@seedlesspay.com) with the subject line `Security report`.

Please include:

- What the issue is and what an attacker could do with it
- Steps to reproduce, or a proof of concept (a Foundry test is ideal for contract issues)
- The affected contract, file, page or API route
- Any transaction hashes or addresses involved

## What to expect

SeedlessPay is currently run by a small team, so these are targets, not guarantees:

- We aim to acknowledge your report within **3 working days**.
- We aim to share a first assessment within **10 working days**.
- We will keep you updated while we work on a fix and tell you when it is released.
- With your permission, we will credit you when the issue is disclosed.

We do not run a paid bug bounty yet. We plan to add one before handling real funds on mainnet.

## Scope

**In scope**

- Contracts in [`contracts/src`](contracts/src): `SeedlessEscrow.sol`, `SeedlessPay.sol`
- The deployed contracts listed in the [README](README.md#deployments)
- The web app and API at `seedlesspay.com` (`/app`, `/pay`, `/api/*`)
- Passkey sign-in, sessions and on-chain payment verification

**Out of scope**

- Third-party services and contracts we use but do not control, such as USDC, the ERC-4337 EntryPoint, the Coinbase Smart Wallet, Pimlico, Vercel and Upstash. Please report those to their owners.
- Attacks that need a compromised device, browser or passkey provider
- Social engineering, phishing of users, or physical attacks
- Denial of service through traffic volume, and rate limits on public endpoints
- Missing best-practice headers or settings with no demonstrated impact
- Reports generated only by automated scanners without a working impact

## Safe harbor

We will not take legal action against people who research and report in good faith, which means you:

- Only test on the **Fuji test network** or with your own accounts and funds
- Do not access, change or delete other people's data
- Do not disrupt the service for other users
- Give us reasonable time to fix the issue before sharing it publicly

## Security design

- **No custody.** Escrow funds are held by a public contract with no owner. Direct invoice payments move straight from client to freelancer.
- **Rules in code.** Release, refund and split rules are enforced by the contract, including time limits that stop either side from stalling forever.
- **Verified records.** The server records a payment or escrow funding only after checking the matching on-chain event.
- **Passkeys.** Wallets are owned by a WebAuthn passkey. Private keys never leave the user's device and SeedlessPay never sees them.
- **Server keys.** API keys stay on the server. The bundler proxy forwards only an allowlist of methods.
- **Sessions.** HttpOnly cookies, one-time challenges and same-origin checks on every state-changing request.

Never share a seed phrase, private key or passkey with anyone. SeedlessPay will never ask for them.
