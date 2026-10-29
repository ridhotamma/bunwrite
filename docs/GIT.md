# Git deployments

Connect a GitHub repository to a site or function, and the server builds it
on every push, the way Appwrite's Git integration does:

- A push to the **production branch** builds and goes live.
- A push to **any other branch** builds a preview. Sites get a preview address;
  functions get a build that is not made active.
- Each build sets a **commit status** on GitHub, and every pull request gets
  **one comment** that lists each connected site and function, updated as
  builds finish.
- A **pull request from a fork** builds nothing until a project admin
  approves it, because builds run the repository's commands on this server.

Commits whose message contains `[skip ci]` or `[ci skip]` are not built.

## 1. Set up the GitHub App (once per server)

GitHub must reach the server, so set `PUBLIC_ENDPOINT` (or `DOMAIN`) to its
public address first. For local testing, use a tunnel such as `cloudflared`
or `ngrok` and point `PUBLIC_ENDPOINT` at it.

**One click:** in the console, open **Organization → Settings → GitHub App**,
choose your personal account or an organization, and click **Create GitHub
App**. GitHub asks you to confirm the name, creates the app with the right
permissions and webhook, then takes you straight to installing it. The app's
keys are stored in the database.

**By hand**, as on Appwrite: register a GitHub App and set:

| Variable | Value |
| --- | --- |
| `VCS_GITHUB_APP_ID` | The app's ID |
| `VCS_GITHUB_APP_NAME` | The app's URL slug (`github.com/apps/<slug>`) |
| `VCS_GITHUB_PRIVATE_KEY` | The private key: the PEM, with `\n` for newlines, or base64 of it |
| `VCS_GITHUB_CLIENT_ID` / `VCS_GITHUB_CLIENT_SECRET` | The app's OAuth client |
| `VCS_GITHUB_WEBHOOK_SECRET` | The webhook secret |

Appwrite's `_APP_VCS_GITHUB_*` names work too. Variables win over an app made
in the console. The app needs:

- **Webhook URL:** `<public origin>/v1/vcs/github/events`
- **Callback URL:** `<public origin>/v1/vcs/github/callback`, with
  "Request user authorization (OAuth) during installation" on
- **Permissions:** contents (read), metadata (read), pull requests (write),
  commit statuses (write)
- **Events:** push, pull request, delete

For GitHub Enterprise Server, set `VCS_GITHUB_URL` (for example
`https://github.example.com`) and `VCS_GITHUB_API_URL`
(`https://github.example.com/api/v3`).

## 2. Install it once for the server

In any project, open **Settings → Git → Add installation** (or the **Connect
GitHub** button on a create page) and pick the accounts and repositories the
app may see. Installations belong to the server, not to one project: once an
account is installed, every project on the server can deploy from its
repositories without another GitHub round trip.

After GitHub sends you back, the server checks that your GitHub account can
access that installation before adding it, so nobody can connect someone
else's installation. Removing it in **Settings → Git** disconnects every site
and function on the server that deployed from it; the app stays installed on
GitHub.

## 3. Connect a site or function

- **New:** in **Create site** or **Create function**, choose **GitHub
  repository**, then pick the account, repository, branch and (for monorepos)
  root directory. If no account is installed yet, the same choice shows
  **Connect GitHub** and returns to the create page afterwards. For a site, picking the repository fills in the framework, runtime and
  commands from its `package.json`, lockfile, `.nvmrc` or `engines.node`; change
  anything before creating it. For a function, "Detect" reads its runtime,
  entry file and build command the same way (or from `requirements.txt`).
- **Existing:** the **Git repository** card on its Settings page.
- **API:** send `installationId`, `providerRepositoryId`, `providerBranch`,
  `providerRootDirectory` and `providerSilentMode` to create or update a site
  or function. Send an empty `providerRepositoryId` to disconnect. Leaving the
  fields out keeps the connection as it is.

Connecting, or changing the repository or production branch, deploys that
branch right away. The **Deploy** button on a connected site or function then
opens a Git deploy form instead of the upload form: pick a branch and either
its newest commit or one of its recent commits. The branch list and commit list
come from GitHub; a branch can still be typed if GitHub cannot be read. This is
the same flow as Netlify, Vercel and Cloudflare Pages: the production branch
deploys live on every push, while this page can rebuild any branch or commit
on demand, live or as a preview.

`createVcsDeployment` builds any branch, tag or commit:

```js
await sites.createVcsDeployment({ siteId: 'web', type: 'branch', reference: 'main', activate: true })
```

Static sites from Git are built here too: the repository holds the source,
so the install and build commands run and the output directory is served.
Uploads of static sites are still served exactly as uploaded.

## Previews

A branch's newest build of a site answers on
`<siteId>--git-<branch>.<SITES_DOMAIN>`, for example
`web--git-feature-login.sites.example.com`. A fork's pull request uses
`<siteId>--git-pr-<number>`. Each build also has its own address,
`<siteId>--<deploymentId>`, while it is kept. They need the same wildcard DNS
and TLS as `<siteId>.<SITES_DOMAIN>`. Caddy's on-demand TLS check already
answers for them.

- Only the newest build of each branch is kept. Deleting the branch, or
  closing a fork's pull request, removes its preview.
- SSR previews start their own app process on the first request, within
  `SITES_SSR_MAX_PROCESSES`, and stop when idle like the live app.
- Previews are public, like the live site. Branch addresses are easy to
  guess, so do not rely on them staying private.

### Preview variables

Previews live in the same project as the live site, with the same database,
so give them their own values where it matters, like Vercel's Preview
environment. Each project, site and function variable applies to:

| Deployments | Seen by |
| --- | --- |
| All deployments (default) | everything |
| Live only | the active deployment and builds that go live: the production branch, `bunwrite push`, the console |
| Previews only | builds that do not go live (other branches, fork pull requests, `--activate false`) and their SSR apps |

A live-only or preview-only value wins over an all-deployments one with the
same name, so `STRIPE_KEY` can be the live key for all deployments and a test
key for previews only. Use **Live only** for anything previews must never
see. Pick it when adding a variable in the console (the **Deployments**
field), with `context` (`live` or `preview`) on the variable APIs, or with
`.live` / `.preview` files and `bunwrite env push` (see the CLI README).

Scopes keep their order on top of this: a site's or function's own value wins
over a project value, whatever their deployments. A static site keeps the
values it was built with; an SSR app restarts with live values when its build
is made live.

## Pull requests from forks

The PR comment shows **Approve builds** for each connected resource. It opens
the console, where a project admin sees the pull request and its author and
clicks **Approve and build**. Later pushes to that pull request build on
their own. From the API this is Appwrite's `updateExternalDeployments`:
`PATCH /v1/vcs/github/installations/{installationId}/repositories/{repositoryId}`
with `providerPullRequestId`.

## Silent mode

`providerSilentMode` (the "Silent mode" checkbox) stops commit statuses and
PR comments for that site or function. Builds still run.

## API

Appwrite's VCS routes, with an API key:

| Route | Does |
| --- | --- |
| `GET /v1/vcs/installations`, `GET`/`DELETE /v1/vcs/installations/{id}` | List, read or remove server-wide installations (GitHub keeps the app installed) |
| `GET /v1/vcs/github/installations/{id}/providerRepositories` | Repositories, newest push first; `search`, and `type=framework` or `runtime` to add detection |
| `GET …/providerRepositories/{repositoryId}`, `…/branches`, `…/contents` | One repository, its branches, a folder's contents |
| `POST /v1/vcs/github/installations/{id}/detections` | Detect a folder's framework (`type: framework`) or runtime (`type: runtime`) |
| `POST /v1/sites/{id}/deployments/vcs`, `POST /v1/functions/{id}/deployments/vcs` | `createVcsDeployment` |

## Limits

- GitHub only. GitLab and Bitbucket are not supported.
- Creating repositories from templates (Appwrite's `createRepository`) is not
  supported.
- Builds of one repository run one after another; other repositories build
  at the same time.
- `bunwrite pull` and `push` do not copy Git connections, because an
  installation ID only exists in the project it was added to.
