# Bunwrite CLI

Command-line tool for [Bunwrite](../../README.md): sign in, keep a project's
schema, functions, buckets, teams, webhooks, topics and settings in a config
file, deploy functions, and call any API.

Its commands and config format match the Appwrite CLI's, so a folder set up
for the Appwrite CLI works as is. It is built on the [Bunwrite SDK](../sdk) and
has no dependencies: the SDK is bundled into `dist/cli.js`.

```bash
npm install -g @bunwrite/cli     # needs Node.js 20+ or Bun
bunwrite help
```

Or build a standalone executable that needs neither: `bun run build:binary`
gives `dist/bunwrite`.

## Connect

With an API key:

```bash
bunwrite client --endpoint https://api.example.com/v1 --project-id my-project --key <api-key>
```

Or as a console admin (`bun run console:admin you@example.com` on the
server), then link the folder to a project:

```bash
bunwrite login --endpoint https://api.example.com/v1 --email you@example.com --password '...'
bunwrite init project --project-id my-project
```

`init project` works with an API key too. With `--create --project-name
<name>`, a signed-in admin creates the project when it does not exist.

`bunwrite whoami`, `bunwrite logout` and `bunwrite client` (shows the
settings; `--reset` forgets them) do what they say. The sign-in and key live
in `~/.bunwrite/prefs.json` (or `$BUNWRITE_HOME/prefs.json`), readable only by
you. When both are set, the API key is used for project commands.

## Pull and push

The project config is `bunwrite.config.json` or `bunwrite.json` in the
current folder. An existing `appwrite.config.json` is used when neither is
there; the format is the same. A new file is `bunwrite.config.json`.

```bash
bunwrite pull all          # settings, tables, functions (with code), buckets, teams, webhooks, topics
bunwrite push tables       # create and alter databases, tables, columns and indexes
bunwrite push functions --function-id hello
```

| What | Pull | Push |
| --- | --- | --- |
| `settings` | project name, services, protocols, sign-in methods, security policies, mock phone numbers | same; renaming needs `bunwrite login` |
| `tables` / `collections` | databases, tables (collections), columns (attributes), indexes | create and alter; type changes are refused |
| `functions` | settings, and the code of the active deployment into each function's `path` | settings, then pack the folder, deploy, wait for the build and activate |
| `buckets` | bucket settings | create and update |
| `teams` | `$id` and `name` | create and rename |
| `webhooks` | webhooks | create and update |
| `topics` | messaging topics | create and update |
| `all` | all of the above | every section the config has |

Push only changes what differs; a config just pulled pushes back with "no
changes". Fields left out of an entry keep the server's value.

Options:

- `--function-id <id>`, `--table-id <id>`, `--collection-id <id>`: only these
  (repeat the flag, or separate with commas).
- `--no-code`: functions without their code.
- `--activate false`: deploy without activating the new code.
- `--prune`: also delete what is on the server but not in the config. It lists
  them and asks first; `--force` skips the question.

A function's code is its `path` folder, without `.git` and without what the
function's `ignore` list matches (gitignore patterns), or the folder's
`.gitignore` when there is no `ignore`. A failed build prints its logs and
leaves the active deployment in place.

## Service commands

Every SDK method is a command: the service, then the method in kebab-case,
then its parameters as flags.

```bash
bunwrite databases list-documents --database-id main --collection-id orders --queries '{"method":"limit","values":[5]}'
bunwrite databases create-document --database-id main --collection-id orders --document-id 'unique()' --data '{"total": 12}'
bunwrite storage create-file --bucket-id photos --file-id 'unique()' --file ./cat.png
bunwrite storage get-file-download-bytes --bucket-id photos --file-id cat --output cat.png
bunwrite functions create-execution --function-id hello --body '{"name":"Ada"}'
bunwrite users --help
```

Values are JSON when they parse (numbers, booleans, arrays, objects) and
strings otherwise; repeat a flag for a list. `--file` and `--code` upload the
named file. `--json` prints compact JSON; `--output` saves a download.
`organization` commands use the console sign-in.

## Build and test

```bash
bun run build          # dist/cli.js
bun run build:binary   # dist/bunwrite for this machine (--target=bun-linux-x64 etc. for others)
bun run typecheck
```

From the repository root, `bun test test/bunwrite-cli.test.ts` runs the CLI
against a real server.

## License

MIT; the bundled SDK includes code under Appwrite's BSD 3-Clause License. See
[LICENSE](LICENSE). Bunwrite is not affiliated with Appwrite.
