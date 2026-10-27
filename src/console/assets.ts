/** Static files embedded into compiled executables. */
import faviconPath from '../../public/favicon.ico' with { type: 'file' }
import logoDarkPath from '../../public/logo-dark.png' with { type: 'file' }
import logoLightPath from '../../public/logo-light.png' with { type: 'file' }
import logoSvgPath from '../../public/logo.svg' with { type: 'file' }
import htmxPath from '../../node_modules/htmx.org/dist/htmx.min.js' with { type: 'file' }

export { faviconPath, htmxPath }

/**
 * Brand files served at the site root, outside the console, so the public 404
 * page has them even when the console is off. logo-dark is for light
 * backgrounds, logo-light for dark ones, and logo.svg (the tab icon) switches
 * between them with the system colour scheme.
 */
export const BRAND_FILES: Record<string, { path: string; type: string }> = {
  '/favicon.ico': { path: faviconPath, type: 'image/x-icon' },
  '/logo.svg': { path: logoSvgPath, type: 'image/svg+xml' },
  '/logo-dark.png': { path: logoDarkPath, type: 'image/png' },
  '/logo-light.png': { path: logoLightPath, type: 'image/png' },
}
