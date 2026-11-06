/** Static files embedded into compiled executables. */
import faviconPath from '../../public/images/favicon.ico' with { type: 'file' }
import logoDarkPath from '../../public/images/logo-dark.png' with { type: 'file' }
import logoLightPath from '../../public/images/logo-light.png' with { type: 'file' }
import logoSvgPath from '../../public/images/logo.svg' with { type: 'file' }
import fontBoldPath from '../../public/fonts/NeueMontreal-Bold.otf' with { type: 'file' }
import fontBoldItalicPath from '../../public/fonts/NeueMontreal-BoldItalic.otf' with { type: 'file' }
import fontItalicPath from '../../public/fonts/NeueMontreal-Italic.otf' with { type: 'file' }
import fontLightPath from '../../public/fonts/NeueMontreal-Light.otf' with { type: 'file' }
import fontLightItalicPath from '../../public/fonts/NeueMontreal-LightItalic.otf' with { type: 'file' }
import fontMediumPath from '../../public/fonts/NeueMontreal-Medium.otf' with { type: 'file' }
import fontMediumItalicPath from '../../public/fonts/NeueMontreal-MediumItalic.otf' with { type: 'file' }
import fontRegularPath from '../../public/fonts/NeueMontreal-Regular.otf' with { type: 'file' }
import htmxPath from '../../node_modules/htmx.org/dist/htmx.min.js' with { type: 'file' }

export { htmxPath }

/**
 * Files served at the site root, outside the console, so the public 404 page
 * has them even when the console is off. Images live under /images and the
 * Neue Montreal faces under /fonts. The old image URLs stay as aliases for
 * browsers and pages that cached them before the folders were split.
 */
export const PUBLIC_FILES: Record<string, { path: string; type: string }> = {
  '/images/favicon.ico': { path: faviconPath, type: 'image/x-icon' },
  '/images/logo.svg': { path: logoSvgPath, type: 'image/svg+xml' },
  '/images/logo-dark.png': { path: logoDarkPath, type: 'image/png' },
  '/images/logo-light.png': { path: logoLightPath, type: 'image/png' },
  '/fonts/NeueMontreal-Light.otf': { path: fontLightPath, type: 'font/otf' },
  '/fonts/NeueMontreal-LightItalic.otf': { path: fontLightItalicPath, type: 'font/otf' },
  '/fonts/NeueMontreal-Regular.otf': { path: fontRegularPath, type: 'font/otf' },
  '/fonts/NeueMontreal-Italic.otf': { path: fontItalicPath, type: 'font/otf' },
  '/fonts/NeueMontreal-Medium.otf': { path: fontMediumPath, type: 'font/otf' },
  '/fonts/NeueMontreal-MediumItalic.otf': { path: fontMediumItalicPath, type: 'font/otf' },
  '/fonts/NeueMontreal-Bold.otf': { path: fontBoldPath, type: 'font/otf' },
  '/fonts/NeueMontreal-BoldItalic.otf': { path: fontBoldItalicPath, type: 'font/otf' },
  // Keep the old root URLs working for cached pages.
  '/favicon.ico': { path: faviconPath, type: 'image/x-icon' },
  '/logo.svg': { path: logoSvgPath, type: 'image/svg+xml' },
  '/logo-dark.png': { path: logoDarkPath, type: 'image/png' },
  '/logo-light.png': { path: logoLightPath, type: 'image/png' },
}
