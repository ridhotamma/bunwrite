/**
 * Frameworks the console and `appwrite init sites` offer.
 *
 * `static` frameworks are built by the user and uploaded as they should be
 * served. `ssr` frameworks upload the source: this server runs the install and
 * build commands, then starts the app and proxies requests to it.
 */
export type SiteAdapter = 'static' | 'ssr'

export interface SiteFramework {
  key: string
  name: string
  outputDirectory: string
  fallbackFile: string
  /**
   * `static`: serve the uploaded folder. `ssr`: build the upload and run
   * `startCommand` for requests (or forward them to `apiFunctionId`).
   */
  adapter: SiteAdapter
  installCommand: string
  buildCommand: string
  startCommand: string
}

export const FRAMEWORKS: SiteFramework[] = [
  // Static output, uploaded after the user's own build.
  { key: 'other', name: 'Plain HTML / htmx', outputDirectory: '', fallbackFile: '', adapter: 'static', installCommand: '', buildCommand: '', startCommand: '' },
  { key: 'vite', name: 'Vite', outputDirectory: 'dist', fallbackFile: 'index.html', adapter: 'static', installCommand: '', buildCommand: '', startCommand: '' },
  { key: 'react', name: 'React', outputDirectory: 'dist', fallbackFile: 'index.html', adapter: 'static', installCommand: '', buildCommand: '', startCommand: '' },
  { key: 'vue', name: 'Vue', outputDirectory: 'dist', fallbackFile: 'index.html', adapter: 'static', installCommand: '', buildCommand: '', startCommand: '' },
  { key: 'svelte', name: 'Svelte', outputDirectory: 'dist', fallbackFile: 'index.html', adapter: 'static', installCommand: '', buildCommand: '', startCommand: '' },
  { key: 'astro', name: 'Astro (static)', outputDirectory: 'dist', fallbackFile: '', adapter: 'static', installCommand: '', buildCommand: '', startCommand: '' },
  { key: 'angular', name: 'Angular', outputDirectory: 'dist/browser', fallbackFile: 'index.html', adapter: 'static', installCommand: '', buildCommand: '', startCommand: '' },
  // Server-side rendering: the source is uploaded and built here.
  { key: 'nextjs', name: 'Next.js', outputDirectory: '', fallbackFile: '', adapter: 'ssr', installCommand: 'npm install', buildCommand: 'npm run build', startCommand: 'node .next/standalone/server.js' },
  { key: 'nuxt', name: 'Nuxt', outputDirectory: '', fallbackFile: '', adapter: 'ssr', installCommand: 'npm install', buildCommand: 'npm run build', startCommand: 'node .output/server/index.mjs' },
  { key: 'sveltekit', name: 'SvelteKit', outputDirectory: '', fallbackFile: '', adapter: 'ssr', installCommand: 'npm install', buildCommand: 'npm run build', startCommand: 'node build' },
  { key: 'astro-ssr', name: 'Astro (SSR)', outputDirectory: '', fallbackFile: '', adapter: 'ssr', installCommand: 'npm install', buildCommand: 'npm run build', startCommand: 'node ./dist/server/entry.mjs' },
  { key: 'remix', name: 'Remix', outputDirectory: '', fallbackFile: '', adapter: 'ssr', installCommand: 'npm install', buildCommand: 'npm run build', startCommand: 'npx remix-serve ./build/server/index.js' },
  { key: 'hono', name: 'Hono / Bun', outputDirectory: '', fallbackFile: '', adapter: 'ssr', installCommand: 'npm install', buildCommand: '', startCommand: 'bun run start' },
]

export const frameworkOf = (key: string | undefined | null): SiteFramework =>
  FRAMEWORKS.find((f) => f.key === key) ?? FRAMEWORKS[0]!

/** The adapter keys the API accepts. */
export const SITE_ADAPTERS: SiteAdapter[] = ['static', 'ssr']
