# Bunwrite agent skills

Skills that teach AI coding agents how to build on
[Bunwrite](../README.md) correctly. They follow the
[Agent Skills](https://agentskills.io) open standard, so Claude Code, Cursor,
Codex, OpenCode, GitHub Copilot and other compatible tools discover them
automatically.

## Install

With the [Skills CLI](https://github.com/vercel-labs/skills):

```bash
npx skills add ridhotamma/bunwrite
```

Pick the skills and agents interactively, or pass choices as flags:

```bash
npx skills add ridhotamma/bunwrite --skill bunwrite --skill bunwrite-cli --agent claude-code --yes
npx skills add ridhotamma/bunwrite --list
```

The Bunwrite CLI wraps the same installer:

```bash
bunwrite skills
bunwrite skills --list
bunwrite init skill
```

Skills are installed into the project by default (`.agents/skills/` plus the
chosen agent directories) and can be committed with the app. Add `--global` to
make them available in every project. Update them with `npx skills update`.

`bunwrite init project` offers to install the skills after linking a folder;
`--skills` skips the question and `--no-skills` skips the install.

## Available skills

| Skill | Use it for |
| --- | --- |
| [`bunwrite`](bunwrite/SKILL.md) | Core: endpoint setup, SDK, account sessions, databases/documents, queries, permissions, storage, realtime, webhooks, SQLite/Postgres, multi-worker deployments and Appwrite compatibility |
| [`bunwrite-observability`](bunwrite-observability/SKILL.md) | Request logs, traces, metrics, product analytics, feature flags, OTLP/Datadog/PostHog, the console Observability pages, and what the frontend must send itself |
| [`bunwrite-mcp`](bunwrite-mcp/SKILL.md) | Connect Claude Code, Cursor, Codex, OpenCode and other MCP clients to a project; operator tools, writes, read-only mode and HTTP transport |
| [`bunwrite-cli`](bunwrite-cli/SKILL.md) | `@bunwrite/cli`: project linking, `pull`/`push`, config files, function and site deploys, service commands |
| [`bunwrite-functions`](bunwrite-functions/SKILL.md) | Function handlers, `context.req`/`res`, builds, environment variables, executions, cron and debugging |
| [`bunwrite-sites`](bunwrite-sites/SKILL.md) | Static sites, output folders, fallbacks, custom domains and `/api/*` functions |

## Prompt examples

```text
Use the bunwrite skill. Add email/password sign-up and sign-in to this React app,
keep the session in the browser, and store a profile document owned by the user.
Use the @bunwrite/sdk and environment variables for the endpoint and project ID.
```

```text
Use the bunwrite-cli skill. Pull the functions in this project, add a Node
function that creates an order document, and deploy it.
```

```text
Use the bunwrite-sites skill. Deploy the Vite dist folder as a site and route
/api/* to the existing api function.
```

```text
Use the bunwrite-observability skill. Send request traces and metrics to
Datadog, document events to PostHog, and read feature flags from GET /v1/flags.
Tell me which product events the frontend still has to send itself.
```

```text
Use the bunwrite-mcp skill. Connect Claude Code to my Bunwrite project, list the
bookings collection, and show me the five most recent documents. Ask before any
write.
```

## Adding a skill

Add a directory under `skills/<name>/` with a `SKILL.md` that starts with:

```yaml
---
name: <name>
description: "What it does and when to use it. Include trigger words."
---
```

Keep names lowercase and hyphenated, keep the description one line, and link to
the repository with absolute URLs. `bun test test/skills.test.ts` checks the
frontmatter and that every skill is listed in this file.
