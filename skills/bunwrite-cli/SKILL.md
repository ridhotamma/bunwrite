---
name: bunwrite-cli
description: "Use when working with the Bunwrite CLI (@bunwrite/cli): linking a folder to a Bunwrite project, pulling and pushing bunwrite.config.json or appwrite.config.json, deploying functions and static sites, managing tables, buckets, teams, webhooks and topics, calling any Bunwrite API from the terminal, or installing Bunwrite agent skills. Triggers: bunwrite CLI, bunwrite init project, bunwrite push, bunwrite pull, bunwrite.config.json, appwrite.config.json."
metadata:
  author: bunwrite
  version: "0.1.0"
---

# Bunwrite CLI

`@bunwrite/cli` manages a Bunwrite project from the terminal and keeps its
resources in a config file. Its commands and config format match Appwrite CLI
22, so a folder set up for `appwrite` usually works with `bunwrite` unchanged.

```bash
npm install -g @bunwrite/cli    # needs Node.js 20+ or Bun
bunwrite help
```

Without a global install, `npx @bunwrite/cli@latest <command>` works too.

## Connect

With an API key (fine for CI and project-scoped work):

```bash
bunwrite client --endpoint https://api.example.com/v1 --project-id my-project --key <api-key>
```

As a console admin (needed for settings and organization operations):

```bash
bunwrite login --endpoint https://api.example.com/v1 --email you@example.com --password '...'
bunwrite init project --project-id my-project
```

`init project` writes `bunwrite.config.json` (or `bunwrite.json`, or updates an
existing `appwrite.config.json`). With `--create --project-name <name>` a
signed-in admin creates the project if it does not exist.

```bash
bunwrite whoami
bunwrite client                  # show endpoint, project, masked key, sign-in
bunwrite client --reset          # forget the settings
bunwrite logout
```

The endpoint and credentials live in `~/.bunwrite/prefs.json` (or
`$BUNWRITE_HOME/prefs.json`), readable only by the current user. The API key is
used for project commands when both a key and a console session exist.

## Agent skills

Bunwrite ships skills for AI coding agents. Install them with the official
Skills CLI:

```bash
npx skills add ridhotamma/bunwrite
```

Or let the Bunwrite CLI call it, forwarding the Skills CLI options:

```bash
bunwrite skills --list
bunwrite skills --skill bunwrite --agent claude-code
bunwrite init skill             # alias
bunwrite skills --print         # show the npx command without running it
```

`bunwrite init project` offers to install the skills after linking the folder.
Use `--skills` to install without asking or `--no-skills` to skip.

## Pull and push

```bash
bunwrite pull all
bunwrite push tables
bunwrite push functions --function-id send-invoice
bunwrite push sites
```

`<what>` is `settings`, `tables`, `collections`, `functions`, `sites`,
`buckets`, `teams`, `webhooks`, `topics` or `all`.

| What | Pull | Push |
| --- | --- | --- |
| `settings` | name, services, protocols, sign-in methods, policies, mock phones | same; renaming needs a console sign-in |
| `tables` / `collections` | databases, tables/collections, columns/attributes, indexes | create and alter; type changes are refused |
| `functions` | settings and the active deployment's source | settings, then build, deploy and activate |
| `sites` | settings and live files | settings, then upload `outputDirectory` and make it live |
| `buckets` | bucket settings | create and update |
| `teams` | `$id` and `name` | create and rename |
| `webhooks` | webhook settings | create and update |
| `topics` | messaging topics | create and update |

Options:

- `--function-id <id>`, `--site-id <id>`, `--table-id <id>`,
  `--collection-id <id>`: only these; repeat or comma-separate.
- `--no-code`: functions and sites without code/files.
- `--activate false`: deploy without making the new version live.
- `--prune`: delete server resources missing from the config; asks first.
- `--force`: skip the prune confirmation.

Push only sends differences. A freshly pulled config pushes back with
"no changes". Fields left out keep the server's value.

## Environments

`bunwrite.config.json` can name targets; each is a server and a project.

```json
"environments": {
  "staging":    { "endpoint": "https://staging.example.com/v1", "projectId": "shop-staging" },
  "production": { "endpoint": "https://api.example.com/v1", "projectId": "shop", "protected": true }
}
```

- Site and function IDs are unique across a server. Environments sharing one
  server use `"idSuffix": "-staging"` (applied to every site and function
  ID) and `"overrides": { "sites": { "<id>": { "domains": [...] } } }`;
  commands still take shared IDs, and pulls map back to them.
- Pick one with `--env <name>` (any command), `BUNWRITE_ENV`, `bunwrite env use
  <name>` (per folder) or `"defaultEnvironment"`, in that order.
- Sign in per server: `bunwrite login --env <name>` or `bunwrite client --env
  <name> --key <key>`. CI: `BUNWRITE_API_KEY` + `BUNWRITE_ENV`.
- Project variables live in `.env` (shared), `.env.<name>`, and
  `.env.<name>.local` (secrets; never commit). No environments: `.env` and
  `.env.local`. `"envDir"` moves them.
- A function's or site's own variables use the same file names inside its
  `path`; the server applies them over the project's.
- Deploy contexts (Vercel-style): `.env.<name>.preview[.local]` holds values
  only Git previews see, `.env.<name>.live[.local]` values only live
  deployments see; they win over the plain files. Variables carry `context`
  (`''`, `live`, `preview`) in the API; function variable IDs gain `.live` /
  `.preview`. `bunwrite run --preview` uses preview values.
- `bunwrite env diff`, `env push`, `env pull` cover the project and every
  function and site in the config (`--scope project|functions|sites`,
  `--function-id`, `--site-id` narrow it); `--prune` removes what the other
  side lacks; `--yes` skips questions. Protected environments ask for their
  name before `env push` and `push`.
- `bunwrite env check` (files only, CI-friendly) exits 1 when one environment
  is missing a variable another sets.
- `.env.local` and `.env.*.local` are never uploaded with function code or
  site files.
- `bunwrite env add <name>` writes the environment, creates its files, and
  (with a console sign-in) creates the project if missing; `--endpoint`,
  `--project-id`, `--protected`, `--create`, `--yes` skip questions.
- `bunwrite run --env <name> [--function-id <id>] -- <command>` runs a local
  command with the merged variables; empty secret placeholders stay unset.
- Pulled secrets are empty placeholders in the `.local` file; push never sends
  an empty `.local` value, so pull then push leaves secrets unchanged.

## Functions

```json
{
  "projectId": "my-project",
  "functions": [
    {
      "$id": "send-invoice",
      "name": "Send invoice",
      "runtime": "node-22",
      "path": "functions/send-invoice",
      "entrypoint": "src/main.js",
      "commands": "npm install",
      "execute": ["users"],
      "timeout": 30,
      "enabled": true,
      "logging": true,
      "domains": ["api.example.com"]
    }
  ]
}
```

```bash
bunwrite push functions --function-id send-invoice
```

The folder at `path` is packed without `.git` and without what `ignore` (or the
folder's `.gitignore`) matches. `commands` runs during the build; `npm install`,
`bun install` and `pip install -r requirements.txt` work without a system
Node/Python in the Docker image. A failed build prints its logs and leaves the
active deployment in place.

## Sites

```json
{
  "sites": [
    {
      "$id": "landing",
      "name": "Landing",
      "framework": "vite",
      "path": "web",
      "outputDirectory": "dist",
      "fallbackFile": "index.html",
      "apiFunctionId": "api",
      "domains": ["www.example.com", "shop.example.com"]
    }
  ]
}
```

```bash
npm run build --prefix web
bunwrite push sites
```

Bunwrite never builds a site. Build locally, then push the contents of
`outputDirectory` inside `path`. `.gitignore` is not applied to build output; use
`ignore` to exclude files. `bunwrite pull sites` writes the live files back.

## Service commands

Every SDK method is available as `<service> <method-in-kebab-case>`:

```bash
bunwrite databases list-documents --database-id main --collection-id orders --queries '{"method":"limit","values":[5]}'
bunwrite databases create-document --database-id main --collection-id orders --document-id 'unique()' --data '{"total":12}'
bunwrite storage create-file --bucket-id photos --file-id 'unique()' --file ./cat.png
bunwrite storage get-file-download-bytes --bucket-id photos --file-id cat --output cat.png
bunwrite functions create-execution --function-id send-invoice --body '{"name":"Ada"}'
bunwrite databases --help
```

Values are JSON when they parse (numbers, booleans, arrays, objects) and strings
otherwise. Repeat a flag for a list. `--file` and `--code` upload a file;
`--json` prints compact JSON; `--output` saves a download. `organization`
commands use the console sign-in.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `No project` | Run `bunwrite init project --project-id <id>` or `bunwrite client --project-id <id>`. |
| `Not signed in` | `bunwrite login`, or set an API key with `bunwrite client --key`. |
| `Not signed in to ... for <env>` | Each environment's server needs its own sign-in: `bunwrite login --env <env>` or `bunwrite client --env <env> --key <key>`. |
| `Unknown environment` | Check `"environments"` in the config, `BUNWRITE_ENV`, and `bunwrite env use --clear`. |
| `Invalid endpoint` | Use the API address ending in `/v1`; check `GET /v1/health/version`. |
| Pull writes the wrong file | `bunwrite.config.json` wins, then `bunwrite.json`, then `appwrite.config.json`. |
| Function archive mixes files | Push functions one at a time with `--function-id` if the CLI bundles several in the same millisecond. |
| A pulled team is rejected on push | Keep only `$id` and `name` for each team in the config. |

## Security

- The key in `~/.bunwrite/prefs.json` has project access. Do not commit it or
  mount it into a public environment.
- In CI, pass the key through the environment or a secret; avoid `--key` on a
  shared shell history if possible.
- Use a console sign-in only on a trusted machine. `bunwrite logout` ends the
  session on the server too.
- `--prune` deletes resources. Review the list, or use `--force` only in
  deliberate automation.

## Reference

- [Bunwrite CLI README](https://github.com/ridhotamma/bunwrite/blob/main/packages/cli/README.md)
- [Bunwrite README](https://github.com/ridhotamma/bunwrite/blob/main/README.md)
- [Appwrite CLI docs](https://appwrite.io/docs/tooling/command-line/installation)
