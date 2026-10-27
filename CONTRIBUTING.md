# Contributing to Bunwrite

Thanks for helping improve Bunwrite.

## Development

```bash
bun install
bun run typecheck
bun test
bun run dev
```

The console is at `/console`. On a fresh database, create an admin with:

```bash
bun run console:admin you@example.com
```

## Pull requests

- Keep changes focused and explain the behaviour they add or fix.
- Add or update a test for behaviour changes. The test suite talks to the server through the real Appwrite SDKs.
- Run `bun run typecheck` and `bun test` before opening a pull request.
- Do not commit real credentials, production data, or `.env` files.

## Security

Please do not report security issues in a public issue. Contact the maintainers privately instead.
