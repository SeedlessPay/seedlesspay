# Contributing to SeedlessPay

Thanks for your interest in SeedlessPay. Feedback from freelancers and clients is the most useful thing you can give us right now, and code contributions are welcome too.

Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first.

## Ways to help

- **Try the beta** at [seedlesspay.com/app](https://seedlesspay.com/app) on the Avalanche test network and tell us what was confusing.
- **Report a bug** with the bug report form in [Issues](https://github.com/SeedlessPay/seedlesspay/issues).
- **Suggest a feature** with the feature request form.
- **Join the community** on [Telegram](https://t.me/seedlesspay).

Found a security issue? Do not open a public issue. Follow [SECURITY.md](SECURITY.md) instead.

## Development setup

### Contracts

Requires [Foundry](https://book.getfoundry.sh/). The contracts have no external dependencies.

```sh
cd contracts
forge build
forge test -vvv
```

### Website and app

The site in `web/` is plain HTML, CSS and JavaScript with no build step. The API routes in `web/api/` are Vercel functions with no dependencies.

```sh
npm i -g vercel
cd web
vercel dev
```

The API needs Upstash Redis and a Pimlico key. See the environment variables in the [README](README.md#web-app). Never commit keys or `.env` files.

## Pull requests

1. Open an issue first for anything larger than a small fix, so we can agree on the approach.
2. Keep each pull request focused on one change.
3. For contract changes, add or update tests and make sure `forge test` passes.
4. For app changes, test on mobile and desktop, in light and dark mode.
5. Describe what changed and how you tested it.

## Style

- **Contracts:** Solidity 0.8.24, custom errors, checks before effects before interactions, clear NatSpec comments.
- **Web:** no frameworks or build tools, shared helpers in `web/js/sp.js`, plain language in everything users read.
- **Writing:** simple words and short paragraphs, so that people who read English as a second language can follow.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
