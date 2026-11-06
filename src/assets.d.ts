declare module '*.ico' {
  const path: string
  export default path
}

declare module '*.min.js' {
  const path: string
  export default path
}

declare module '*.py' {
  const path: string
  export default path
}

declare module '*.otf' {
  const path: string
  export default path
}

declare module '*.png' {
  const path: string
  export default path
}

declare module '*.svg' {
  const path: string
  export default path
}

/**
 * Files the installer embeds at build time. Bun's `type: "text"` imports keep
 * the exact contents beside the code, so the Docker image needs no extra asset
 * directory and a source checkout works without a build step.
 */
declare module '*.yml' {
  const text: string
  export default text
}

declare module '*.example' {
  const text: string
  export default text
}

declare module '*.sh' {
  const text: string
  export default text
}

declare module '*/Caddyfile' {
  const text: string
  export default text
}

declare module '*/Caddyfile.external' {
  const text: string
  export default text
}

declare module '*/Caddyfile.off' {
  const text: string
  export default text
}
