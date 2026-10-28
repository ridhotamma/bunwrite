/**
 * Frameworks the console and `appwrite init sites` offer, in two groups:
 *
 * - `static`: the build makes files to serve. An upload is served as it is
 *   (build first); a GitHub repository is installed and built here.
 * - `server`: an app that renders on request. It is installed, built and
 *   started here, and requests are proxied to it.
 *
 * The adapter (`static` or `ssr`, Appwrite's names) follows from the group.
 * Keys match Appwrite's where Appwrite has the framework.
 */
export type SiteAdapter = 'static' | 'ssr'
export type FrameworkGroup = 'static' | 'server'

export interface SiteFramework {
  key: string
  name: string
  group: FrameworkGroup
  outputDirectory: string
  fallbackFile: string
  /**
   * `static`: serve the output folder. `ssr`: build the upload and run
   * `startCommand` for requests (or forward them to `apiFunctionId`).
   */
  adapter: SiteAdapter
  installCommand: string
  buildCommand: string
  startCommand: string
}

const NPM_INSTALL = 'npm install'
const NPM_BUILD = 'npm run build'

const staticSite = (key: string, name: string, outputDirectory: string, fallbackFile = '', build = NPM_BUILD): SiteFramework => ({
  key,
  name,
  group: 'static',
  adapter: 'static',
  outputDirectory,
  fallbackFile,
  installCommand: build ? NPM_INSTALL : '',
  buildCommand: build,
  startCommand: '',
})

const server = (key: string, name: string, startCommand: string, build = NPM_BUILD): SiteFramework => ({
  key,
  name,
  group: 'server',
  adapter: 'ssr',
  outputDirectory: '',
  fallbackFile: '',
  installCommand: NPM_INSTALL,
  buildCommand: build,
  startCommand,
})

export const FRAMEWORKS: SiteFramework[] = [
  // Static output.
  staticSite('other', 'Plain HTML / htmx', '', '', ''),
  staticSite('vite', 'Vite', 'dist', 'index.html'),
  staticSite('react', 'React (Vite)', 'dist', 'index.html'),
  staticSite('vue', 'Vue (Vite)', 'dist', 'index.html'),
  staticSite('svelte', 'Svelte (Vite)', 'dist', 'index.html'),
  staticSite('solid', 'Solid (Vite)', 'dist', 'index.html'),
  staticSite('angular', 'Angular', 'dist/browser', 'index.html'),
  staticSite('astro', 'Astro (static)', 'dist'),
  staticSite('next-static', 'Next.js (static export)', 'out'),
  staticSite('nuxt-static', 'Nuxt (static, nuxt generate)', '.output/public', '', 'npm run generate'),
  staticSite('sveltekit-static', 'SvelteKit (static adapter)', 'build'),
  staticSite('docusaurus', 'Docusaurus', 'build'),
  staticSite('vitepress', 'VitePress', 'docs/.vitepress/dist', '', 'npm run docs:build'),
  staticSite('gatsby', 'Gatsby', 'public'),
  staticSite('eleventy', 'Eleventy', '_site'),
  staticSite('static-other', 'Other static build', 'dist'),
  // Server-side rendering: built and run here.
  server('nextjs', 'Next.js', 'node .next/standalone/server.js'),
  server('nuxt', 'Nuxt', 'node .output/server/index.mjs'),
  server('sveltekit', 'SvelteKit (Node adapter)', 'node build'),
  server('astro-ssr', 'Astro (SSR, Node adapter)', 'node ./dist/server/entry.mjs'),
  server('tanstack-start', 'TanStack Start', 'node .output/server/index.mjs'),
  server('react-router', 'React Router 7 (framework mode)', 'npx react-router-serve ./build/server/index.js'),
  server('remix', 'Remix', 'npx remix-serve ./build/server/index.js'),
  server('solidstart', 'SolidStart', 'node .output/server/index.mjs'),
  server('analog', 'Analog', 'node dist/analog/server/index.mjs'),
  server('hono', 'Hono', 'npm start', ''),
  server('node', 'Node.js server (Express, Fastify, Koa…)', 'npm start', ''),
  server('ssr-other', 'Other server', 'npm start'),
]

export const frameworkOf = (key: string | undefined | null): SiteFramework =>
  FRAMEWORKS.find((f) => f.key === key) ?? FRAMEWORKS[0]!

/**
 * The framework to show for a site. A site made through the API with a
 * framework of the other group (such as `other` with `adapter: ssr`) shows
 * as that group's "Other".
 */
export function frameworkForSite(framework: string, adapter: string): SiteFramework {
  const preset = frameworkOf(framework)
  const group: FrameworkGroup = adapter === 'ssr' ? 'server' : 'static'
  if (preset.group === group && (preset.key === framework || !framework)) return preset
  return frameworkOf(group === 'server' ? 'ssr-other' : 'static-other')
}

/** The adapter keys the API accepts. */
export const SITE_ADAPTERS: SiteAdapter[] = ['static', 'ssr']
