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

## Releasing the SDK and CLI

`@bunwrite/sdk` (`packages/sdk`) and `@bunwrite/cli` (`packages/cli`) are
published to npm separately, each with its own version. The CLI bundles the SDK
as it is in the same commit.

They are published by hand with `npm publish`; no token is stored anywhere.

One-time setup: on npmjs.com, create the `bunwrite` organization (the
`@bunwrite` scope), turn on two-factor authentication for your account, and
sign in from the terminal with `npm login`.

To release, from a clean checkout of main with `bun install` done:

1. Set the new version in the package's `package.json`, for example
   `cd packages/sdk && npm version 0.2.0 --no-git-tag-version`.
2. Check what will be published: `npm pack --dry-run`.
3. Publish: `npm publish`. Before uploading, it runs the package's typecheck,
   the SDK and CLI tests against a real server, and the build; any failure
   stops the publish. npm then asks for your two-factor code.
4. Commit the version change, tag it and push:
   `git tag sdk-v0.2.0 && git push origin main sdk-v0.2.0` (or `cli-v...`).

For a pre-release, publish with `npm publish --tag next`, so that
`npm install @bunwrite/sdk` keeps getting the latest stable version.

Publishing a CLI release bundles the SDK as it is in the same checkout, so
release the SDK first when the CLI depends on an SDK change.

## Security

Please do not report security issues in a public issue. Contact the maintainers privately instead.
