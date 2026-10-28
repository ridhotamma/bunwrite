/**
 * After-build cleanup for SSR sites. A build leaves the full development
 * install in node_modules (compilers, bundlers, linters), which the running
 * app does not need. This step removes it so each kept deployment holds only
 * what the start command uses.
 *
 * - `standalone`: the build output carries its own dependencies (Next.js
 *   `output: 'standalone'`, Nuxt/Nitro `.output`), so node_modules is deleted.
 *   For Next.js, `public` and `.next/static` are copied into the standalone
 *   folder first, since its server does not serve them from the project root.
 * - `production`: dev dependencies are removed and runtime ones are kept. Works
 *   for any framework whose dependencies are listed correctly.
 * - `auto` (default): `standalone` when the start command runs such an output
 *   and it exists, otherwise `production`.
 * - `none`: keep everything.
 *
 * Build caches (`.next/cache`, `node_modules/.cache`) are removed by every mode
 * except `none`. The script runs as a shell command because, with the sandbox
 * on, only the site's own user can read its deployment folder.
 */
export const PRUNE_MODES = ['auto', 'standalone', 'production', 'none'] as const
export type PruneMode = (typeof PRUNE_MODES)[number]

export const isPruneMode = (value: string): value is PruneMode => (PRUNE_MODES as readonly string[]).includes(value)

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

/** The package manager the install command calls, if it names one. */
export function packageManagerOf(installCommand: string): PackageManager | null {
  const match = /(?:^|[\s;&|(])(npm|pnpm|yarn|bun)(?=\s|$)/.exec(installCommand.trim())
  return (match?.[1] as PackageManager | undefined) ?? null
}

/** Which standalone output a start command runs, if any. */
function standaloneKind(startCommand: string): 'next' | 'nitro' | null {
  if (/(?:^|[\s/])\.next\/standalone\//.test(startCommand)) return 'next'
  if (/(?:^|[\s/])\.output\/server\//.test(startCommand)) return 'nitro'
  return null
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/** The last line of the script's output: the deployment's size before and after, in KB. */
export const SIZE_MARKER = '@@prune-size'

export interface PruneOptions {
  mode: PruneMode
  /** The deployment's start command, which `auto` looks at. */
  startCommand: string
  installCommand: string
  /** The app folder (the site's output directory) relative to the deployment root; '' for the root. */
  appDir: string
}

/** Remove dev dependencies with the project's package manager, keeping runtime ones. */
function productionBody(installCommand: string): string {
  const pm = packageManagerOf(installCommand) ?? ''
  return `
if [ ! -f package.json ] || [ ! -d node_modules ]; then
  echo "No node_modules to prune."
else
  pm=${quote(pm)}
  if [ -z "$pm" ]; then
    if [ -f pnpm-lock.yaml ]; then pm=pnpm
    elif [ -f bun.lock ] || [ -f bun.lockb ]; then pm=bun
    elif [ -f yarn.lock ]; then pm=yarn
    else pm=npm
    fi
  fi
  case "$pm" in
    pnpm) echo "$ pnpm prune --prod"; pnpm prune --prod ;;
    yarn)
      if [ -f .yarnrc.yml ]; then echo "$ yarn workspaces focus --all --production"; yarn workspaces focus --all --production
      else echo "$ yarn install --production --prefer-offline"; yarn install --production --prefer-offline
      fi ;;
    bun)
      # bun has no prune; reinstall without dev dependencies, and put the old
      # install back if that fails so the app still starts.
      echo "$ bun install --production"
      rm -rf .node_modules.prune && mv node_modules .node_modules.prune
      if bun install --production; then rm -rf .node_modules.prune
      else rm -rf node_modules; mv .node_modules.prune node_modules; exit 1
      fi ;;
    *) echo "$ npm prune --omit=dev"; npm prune --omit=dev ;;
  esac
fi`
}

/** Delete node_modules; for Next.js, first copy the assets its standalone server expects. */
function standaloneBody(): string {
  return `
s="$app/.next/standalone"
if [ -f "$s/server.js" ]; then
  if [ -d "$app/public" ]; then rm -rf "$s/public"; cp -R "$app/public" "$s/public"; fi
  if [ -d "$app/.next/static" ]; then mkdir -p "$s/.next"; rm -rf "$s/.next/static"; cp -R "$app/.next/static" "$s/.next/static"; fi
  echo "Copied public and .next/static into .next/standalone."
fi
echo "Removing node_modules: the build output carries its own dependencies."
rm -rf node_modules "$app/node_modules"`
}

/** The cleanup shell script, run in the deployment root; null for `none`. */
export function pruneScript(options: PruneOptions): string | null {
  if (options.mode === 'none') return null
  const app = options.appDir ? `./${options.appDir}` : '.'
  let body: string
  if (options.mode === 'standalone') body = standaloneBody()
  else if (options.mode === 'production') body = productionBody(options.installCommand)
  else {
    const kind = standaloneKind(options.startCommand)
    const marker = kind === 'next' ? '"$app/.next/standalone/server.js"' : '"$app/.output/server"'
    body = kind
      ? `
if [ -e ${marker} ]; then${standaloneBody()}
else
  echo "No standalone build output found; removing dev dependencies instead."${productionBody(options.installCommand)}
fi`
      : productionBody(options.installCommand)
  }
  return `set -e
app=${quote(app)}
before=$(du -sk . | cut -f1)
${body.trim()}
rm -rf "$app/.next/cache" node_modules/.cache "$app/node_modules/.cache"
echo "${SIZE_MARKER} $before $(du -sk . | cut -f1)"`
}
