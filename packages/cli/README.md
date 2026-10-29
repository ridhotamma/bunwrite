# Bunwrite CLI

Command-line tool for [Bunwrite](../../README.md): sign in, keep a project's
schema, functions, sites, buckets, teams, webhooks, topics and settings in a
config file, deploy functions and static sites, and call any API.

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

## Agent skills

Bunwrite's AI coding agent skills follow the
[Agent Skills](https://agentskills.io) standard. `bunwrite skills` runs the
official installer, forwarding its options:

```bash
bunwrite skills                 # interactive: choose skills and agents
bunwrite skills --list          # show the available skills
bunwrite skills --skill bunwrite --agent claude-code --yes
bunwrite skills --print         # show the npx command only
bunwrite init skill             # alias
```

It runs `npx skills add ridhotamma/bunwrite`, falling back to `bunx` when npx
is not installed. You can run that command directly instead. `init project`
offers the install after linking the folder; `--skills` skips the question and
`--no-skills` skips the install. See [`skills/`](../../skills/README.md).

## Pull and push

The project config is `bunwrite.config.json` or `bunwrite.json` in the
current folder. An existing `appwrite.config.json` is used when neither is
there; the format is the same. A new file is `bunwrite.config.json`.

```bash
bunwrite pull all          # settings, tables, functions (with code), sites (with files), buckets, teams, webhooks, topics
bunwrite push tables       # create and alter databases, tables, columns and indexes
bunwrite push functions --function-id hello
```

| What | Pull | Push |
| --- | --- | --- |
| `settings` | project name, services, protocols, sign-in methods, security policies, mock phone numbers | same; renaming needs `bunwrite login` |
| `tables` / `collections` | databases, tables (collections), columns (attributes), indexes | create and alter; type changes are refused |
| `functions` | settings, and the code of the active deployment into each function's `path` | settings, then pack the folder, deploy, wait for the build and activate |
| `sites` | settings, and the live files into each site's `path` | settings, then pack `outputDirectory` inside `path` (build it first; `.gitignore` is not applied) and make it live |
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
- `--no-code`: functions and sites without their code or files.
- `--site-id <id>`: only these sites.
- `--with-variables`: for `push sites`, reconcile the site's variables from the
  `.env` next to its `path`; credential-looking names are stored as secret and
  `.env` is left out of the upload.
- `--activate false`: deploy without activating the new code.
- `--prune`: also delete what is on the server but not in the config. It lists
  them and asks first; `--force` skips the question.

A function's code is its `path` folder, without `.git` and without what the
function's `ignore` list matches (gitignore patterns), or the folder's
`.gitignore` when there is no `ignore`. A failed build prints its logs and
leaves the active deployment in place.

## Environments

The quickest start is `bunwrite env add`:

```bash
bunwrite env add staging
? Server endpoint (https://api.example.com/v1):
? Project ID (shop-staging):
? Protect staging? Pushes then ask you to type its name. (y/N)
✓ Added staging → shop-staging @ api.example.com
ℹ Created .env.staging and .env.staging.local
```

It checks the server and, when you are signed in to that server's console,
creates the project if it is missing (`--create` without asking). Name the
projects so they are easy to tell apart in the console, such as "Shop
(staging)"; a project it creates gets that kind of name. `production` suggests
this folder's current project and protection. `--endpoint`, `--project-id`, `--protected`
and `--yes` answer the questions up front, for scripts.

Or name your targets (staging, production, or anything else) in
`bunwrite.config.json` yourself. Each is a server and a project; `extends` copies
another environment and changes some of it:

```json
{
    "projectId": "shop",
    "environments": {
        "staging":    { "endpoint": "https://staging.example.com/v1", "projectId": "shop-staging" },
        "production": { "endpoint": "https://api.example.com/v1", "projectId": "shop", "protected": true },
        "preview":    { "extends": "staging", "projectId": "shop-preview" }
    },
    "defaultEnvironment": "staging",
    "envDir": "."
}
```

The active environment is the first of: `--env <name>` on any command,
`BUNWRITE_ENV`, `bunwrite env use <name>` (remembered for this folder), and
`defaultEnvironment`. Commands then print where they go, for example
`→ production (protected) · shop @ api.example.com`. Without environments,
everything works as before.

Sign in once per server: `bunwrite login --env production`, or save an API key
for that environment's project with `bunwrite client --env production --key
<key>`. In CI, set `BUNWRITE_API_KEY` and `BUNWRITE_ENV` instead.

### Several environments on one server

Site and function IDs are addresses (`<id>.<SITES_DOMAIN>`), so they are
unique across every project on a server. When staging and production share a
server, give staging an `idSuffix`, and change what must differ with
`overrides`, keyed by kind and the shared `$id`:

```json
"staging": {
    "projectId": "shop-staging",
    "idSuffix": "-staging",
    "overrides": {
        "sites": { "web": { "domains": ["staging.example.com"] } },
        "functions": { "backup": { "schedule": "" } }
    }
}
```

In staging, every site and function gets the suffix (`web` → `web-staging`,
and `apiFunctionId` follows), and `web` has its own domains. Commands still take
the shared IDs (`--site-id web`). A pull maps the server's IDs back and keeps
the shared values of overridden fields, so `bunwrite.config.json` reads the
same whichever environment it came from. App code that calls a function by ID
needs the suffixed ID in that environment. `overrides` also takes `settings`
and any other list in the config, such as `buckets`.

### Variables in .env files

`bunwrite env` keeps variables in .env files. The project's variables (seen by
every function and site) are in files next to the config, or in `envDir`.
Later files win:

| File | Holds | Commit it? |
| --- | --- | --- |
| `.env` | values shared by every environment | yes |
| `.env.<name>` | this environment's values | yes |
| `.env.<name>.local` | this environment's secrets, stored as secret on the server | no |

Without environments, the files are `.env` and `.env.local`.

Values for one kind of deployment go in `.live` and `.preview` files, like
Vercel's Production and Preview environments. Previews are builds that do not
go live, such as Git branches other than the production one:

| File | Holds |
| --- | --- |
| `.env.<name>.preview` / `.preview.local` | values only previews see |
| `.env.<name>.live` / `.live.local` | values only live deployments see |

They win over the files above for those deployments, so a test key can sit in
`.env.staging.preview.local` next to the live one in `.env.staging.local`.
Without environments they are `.env.preview` and `.env.live`. A context with no
file is left alone on the server. See
[Preview variables](../../docs/GIT.md#preview-variables).

A function or site from the config has the same files in its own `path`, and
they set that function's or site's variables. The server applies them over the
project's, so put shared values in the project files and only overrides here:

```
.env.production                    project: every function and site
functions/billing/.env.production  only the billing function
sites/web/.env.production.local    only the web site, secret
```

`env diff`, `env push` and `env pull` cover the project and every function and
site in the config. `--scope project` (or `functions`, `sites`) narrows that,
as do `--function-id` and `--site-id`. A function or site that is not on the
server yet is skipped until you `bunwrite push` it. `.env.local` and
`.env.*.local` files are never uploaded with a function's code or a site's
files.

```bash
bunwrite env                       # list environments, their targets and files
bunwrite env use staging           # use staging in this folder (--clear forgets it)
bunwrite env diff                  # what a push would change
bunwrite env push                  # shows the changes, asks, applies
bunwrite env pull --env production # writes the server's variables into the files
bunwrite env check                 # variables one environment sets and another misses
```

### Run locally with an environment's variables

```bash
bunwrite run --env staging -- bun run dev
bunwrite run --env staging --function-id billing -- bun functions/billing/src/main.ts
```

`run` starts the command with the same variables the server would use: the
project's files, then (with `--function-id` or `--site-id`) that function's or
site's own, over your shell's environment. It uses live values; `--preview`
uses what a Git preview build would see. A secret pulled as an empty
placeholder stays unset; put a value in the `.local` file to use it locally.
The command's exit code is passed on.

### Checking environments

`env check` compares the files only, so it fits in CI before a deploy: it exits
with 1 when an environment is missing a variable another one sets, and names
it, for example `✗ production is missing SENTRY_DSN, STRIPE_KEY (function
billing)`. With `--env <name>` it checks just that environment.

- **Secrets stay safe.** The server never shows a secret's value, so `pull`
  writes it to the `.local` file as an empty placeholder, and `push` never sends
  an empty `.local` value. Pulling and pushing back changes nothing. A secret
  with a value is sent again on every push, since it cannot be compared.
- **Nothing is deleted unless you ask.** Variables on only one side are listed;
  `--prune` removes them (from the server on push, from your files on pull).
- **Pull keeps your files tidy.** Values are changed in place, so comments and
  order stay. It asks before replacing a local value, and never writes the
  shared `.env`. It adds `.env*.local` to `.gitignore`.
- **Protected environments ask for their name** before `env push` or `push`.
  `--yes` (or `--force`) skips every question, for CI.
- A credential-looking name (`*_KEY`, `*_SECRET`, `*_TOKEN`, ...) in a committed
  file gets a warning to move it to the `.local` file.

If the config's folder already has a `.env` for something else (such as the
Bunwrite server's own settings), set `envDir` to another folder so it is not
pushed as project variables. The same goes for a function folder whose `.env`
is only for local runs: `env diff` shows what would be sent, and
`--scope project` leaves functions and sites alone.

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
