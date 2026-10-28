/** Small, reusable console UI pieces. Pages compose these instead of repeating markup. */
import { html, type Html } from './html'

/** Phosphor regular icon paths, inlined so the console needs no font or extra request. */
const ICON_PATHS = {
  'arrow-left': 'M224,128a8,8,0,0,1-8,8H59.31l58.35,58.34a8,8,0,0,1-11.32,11.32l-72-72a8,8,0,0,1,0-11.32l72-72a8,8,0,0,1,11.32,11.32L59.31,120H216A8,8,0,0,1,224,128Z',
  'caret-double-left': 'M205.66,202.34a8,8,0,0,1-11.32,11.32l-80-80a8,8,0,0,1,0-11.32l80-80a8,8,0,0,1,11.32,11.32L131.31,128ZM51.31,128l74.35-74.34a8,8,0,0,0-11.32-11.32l-80,80a8,8,0,0,0,0,11.32l80,80a8,8,0,0,0,11.32-11.32Z',
  'caret-double-right': 'M141.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L124.69,128,50.34,53.66A8,8,0,0,1,61.66,42.34l80,80A8,8,0,0,1,141.66,133.66Zm80-11.32-80-80a8,8,0,0,0-11.32,11.32L204.69,128l-74.35,74.34a8,8,0,0,0,11.32,11.32l80-80A8,8,0,0,0,221.66,122.34Z',
  'caret-up-down': 'M181.66,170.34a8,8,0,0,1,0,11.32l-48,48a8,8,0,0,1-11.32,0l-48-48a8,8,0,0,1,11.32-11.32L128,212.69l42.34-42.35A8,8,0,0,1,181.66,170.34Zm-96-84.68L128,43.31l42.34,42.35a8,8,0,0,0,11.32-11.32l-48-48a8,8,0,0,0-11.32,0l-48,48A8,8,0,0,0,85.66,85.66Z',
  check: 'M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z',
  'check-circle': 'M173.66,98.34a8,8,0,0,1,0,11.32l-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35A8,8,0,0,1,173.66,98.34ZM232,128A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-16,0a88,88,0,1,0-88,88A88.1,88.1,0,0,0,216,128Z',
  copy: 'M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z',
  'dots-three': 'M140,128a12,12,0,1,1-12-12A12,12,0,0,1,140,128Zm56-12a12,12,0,1,0,12,12A12,12,0,0,0,196,116ZM60,116a12,12,0,1,0,12,12A12,12,0,0,0,60,116Z',
  database: 'M128,24C74.17,24,32,48.6,32,80v96c0,31.4,42.17,56,96,56s96-24.6,96-56V80C224,48.6,181.83,24,128,24Zm80,104c0,9.62-7.88,19.43-21.61,26.92C170.93,163.35,150.19,168,128,168s-42.93-4.65-58.39-13.08C55.88,147.43,48,137.62,48,128V111.36c17.06,15,46.23,24.64,80,24.64s62.94-9.68,80-24.64ZM69.61,53.08C85.07,44.65,105.81,40,128,40s42.93,4.65,58.39,13.08C200.12,60.57,208,70.38,208,80s-7.88,19.43-21.61,26.92C170.93,115.35,150.19,120,128,120s-42.93-4.65-58.39-13.08C55.88,99.43,48,89.62,48,80S55.88,60.57,69.61,53.08ZM186.39,202.92C170.93,211.35,150.19,216,128,216s-42.93-4.65-58.39-13.08C55.88,195.43,48,185.62,48,176V159.36c17.06,15,46.23,24.64,80,24.64s62.94-9.68,80-24.64V176C208,185.62,200.12,195.43,186.39,202.92Z',
  'folder-simple': 'M216,72H130.67L102.93,51.2a16.12,16.12,0,0,0-9.6-3.2H40A16,16,0,0,0,24,64V200a16,16,0,0,0,16,16H216.89A15.13,15.13,0,0,0,232,200.89V88A16,16,0,0,0,216,72Zm0,128H40V64H93.33L123.2,86.4A8,8,0,0,0,128,88h88Z',
  globe: 'M128,24h0A104,104,0,1,0,232,128,104.12,104.12,0,0,0,128,24Zm88,104a87.61,87.61,0,0,1-3.33,24H174.16a157.44,157.44,0,0,0,0-48h38.51A87.61,87.61,0,0,1,216,128ZM102,168H154a115.11,115.11,0,0,1-26,45A115.27,115.27,0,0,1,102,168Zm-3.9-16a140.84,140.84,0,0,1,0-48h59.88a140.84,140.84,0,0,1,0,48ZM40,128a87.61,87.61,0,0,1,3.33-24H81.84a157.44,157.44,0,0,0,0,48H43.33A87.61,87.61,0,0,1,40,128ZM154,88H102a115.11,115.11,0,0,1,26-45A115.27,115.27,0,0,1,154,88Zm52.33,0H170.71a135.28,135.28,0,0,0-22.3-45.6A88.29,88.29,0,0,1,206.37,88ZM107.59,42.4A135.28,135.28,0,0,0,85.29,88H49.63A88.29,88.29,0,0,1,107.59,42.4ZM49.63,168H85.29a135.28,135.28,0,0,0,22.3,45.6A88.29,88.29,0,0,1,49.63,168Zm98.78,45.6a135.28,135.28,0,0,0,22.3-45.6h35.66A88.29,88.29,0,0,1,148.41,213.6Z',
  'gear-six': 'M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Zm109.94-52.79a8,8,0,0,0-3.89-5.4l-29.83-17-.12-33.62a8,8,0,0,0-2.83-6.08,111.91,111.91,0,0,0-36.72-20.67,8,8,0,0,0-6.46.59L128,41.85,97.88,25a8,8,0,0,0-6.47-.6A112.1,112.1,0,0,0,54.73,45.15a8,8,0,0,0-2.83,6.07l-.15,33.65-29.83,17a8,8,0,0,0-3.89,5.4,106.47,106.47,0,0,0,0,41.56,8,8,0,0,0,3.89,5.4l29.83,17,.12,33.62a8,8,0,0,0,2.83,6.08,111.91,111.91,0,0,0,36.72,20.67,8,8,0,0,0,6.46-.59L128,214.15,158.12,231a7.91,7.91,0,0,0,3.9,1,8.09,8.09,0,0,0,2.57-.42,112.1,112.1,0,0,0,36.68-20.73,8,8,0,0,0,2.83-6.07l.15-33.65,29.83-17a8,8,0,0,0,3.89-5.4A106.47,106.47,0,0,0,237.94,107.21Zm-15,34.91-28.57,16.25a8,8,0,0,0-3,3c-.58,1-1.19,2.06-1.81,3.06a7.94,7.94,0,0,0-1.22,4.21l-.15,32.25a95.89,95.89,0,0,1-25.37,14.3L134,199.13a8,8,0,0,0-3.91-1h-.19c-1.21,0-2.43,0-3.64,0a8.08,8.08,0,0,0-4.1,1l-28.84,16.1A96,96,0,0,1,67.88,201l-.11-32.2a8,8,0,0,0-1.22-4.22c-.62-1-1.23-2-1.8-3.06a8.09,8.09,0,0,0-3-3.06l-28.6-16.29a90.49,90.49,0,0,1,0-28.26L61.67,97.63a8,8,0,0,0,3-3c.58-1,1.19-2.06,1.81-3.06a7.94,7.94,0,0,0,1.22-4.21l.15-32.25a95.89,95.89,0,0,1,25.37-14.3L122,56.87a8,8,0,0,0,4.1,1c1.21,0,2.43,0,3.64,0a8.08,8.08,0,0,0,4.1-1l28.84-16.1A96,96,0,0,1,188.12,55l.11,32.2a8,8,0,0,0,1.22,4.22c.62,1,1.23,2,1.8,3.06a8.09,8.09,0,0,0,3,3.06l28.6,16.29A90.49,90.49,0,0,1,222.9,142.12Z',
  house: 'M219.31,108.68l-80-80a16,16,0,0,0-22.62,0l-80,80A15.87,15.87,0,0,0,32,120v96a8,8,0,0,0,8,8h64a8,8,0,0,0,8-8V160h32v56a8,8,0,0,0,8,8h64a8,8,0,0,0,8-8V120A15.87,15.87,0,0,0,219.31,108.68ZM208,208H160V152a8,8,0,0,0-8-8H104a8,8,0,0,0-8,8v56H48V120l80-80,80,80Z',
  info: 'M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm16-40a8,8,0,0,1-8,8,16,16,0,0,1-16-16V128a8,8,0,0,1,0-16,16,16,0,0,1,16,16v40A8,8,0,0,1,144,176ZM112,84a12,12,0,1,1,12,12A12,12,0,0,1,112,84Z',
  key: 'M216.57,39.43A80,80,0,0,0,83.91,120.78L28.69,176A15.86,15.86,0,0,0,24,187.31V216a16,16,0,0,0,16,16H72a8,8,0,0,0,8-8V208H96a8,8,0,0,0,8-8V184h16a8,8,0,0,0,5.66-2.34l9.56-9.57A79.73,79.73,0,0,0,160,176h.1A80,80,0,0,0,216.57,39.43ZM224,98.1c-1.09,34.09-29.75,61.86-63.89,61.9H160a63.7,63.7,0,0,1-23.65-4.51,8,8,0,0,0-8.84,1.68L116.69,168H96a8,8,0,0,0-8,8v16H72a8,8,0,0,0-8,8v16H40V187.31l58.83-58.82a8,8,0,0,0,1.68-8.84A63.72,63.72,0,0,1,96,95.92c0-34.14,27.81-62.8,61.9-63.89A64,64,0,0,1,224,98.1ZM192,76a12,12,0,1,1-12-12A12,12,0,0,1,192,76Z',
  lightning: 'M215.79,118.17a8,8,0,0,0-5-5.66L153.18,90.9l14.66-73.33a8,8,0,0,0-13.69-7l-112,120a8,8,0,0,0,3,13l57.63,21.61L88.16,238.43a8,8,0,0,0,13.69,7l112-120A8,8,0,0,0,215.79,118.17ZM109.37,214l10.47-52.38a8,8,0,0,0-5-9.06L62,132.71l84.62-90.66L136.16,94.43a8,8,0,0,0,5,9.06l52.8,19.8Z',
  list: 'M224,128a8,8,0,0,1-8,8H40a8,8,0,0,1,0-16H216A8,8,0,0,1,224,128ZM40,72H216a8,8,0,0,0,0-16H40a8,8,0,0,0,0,16ZM216,184H40a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16Z',
  'magnifying-glass': 'M229.66,218.34l-50.07-50.06a88.11,88.11,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z',
  plus: 'M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z',
  'squares-four': 'M200,40H152a8,8,0,0,0-8,8V104a8,8,0,0,0,8,8h48a8,8,0,0,0,8-8V48A8,8,0,0,0,200,40Zm-8,56H160V56h32Zm-88,8H56a8,8,0,0,0-8,8v56a8,8,0,0,0,8,8h48a8,8,0,0,0,8-8V112A8,8,0,0,0,104,104Zm-8,56H64V120h32Zm104,0H152a8,8,0,0,0-8,8v48a8,8,0,0,0,8,8h48a8,8,0,0,0,8-8V168A8,8,0,0,0,200,160Zm-8,48H160V176h32ZM104,40H56a8,8,0,0,0-8,8V96a8,8,0,0,0,8,8h48a8,8,0,0,0,8-8V48A8,8,0,0,0,104,40Zm-8,48H64V56h32Z',
  'list-bullets': 'M80,64a8,8,0,0,1,8-8H216a8,8,0,0,1,0,16H88A8,8,0,0,1,80,64Zm136,56H88a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16Zm0,64H88a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16ZM44,52A12,12,0,1,0,56,64,12,12,0,0,0,44,52Zm0,64a12,12,0,1,0,12,12A12,12,0,0,0,44,116Zm0,64a12,12,0,1,0,12,12A12,12,0,0,0,44,180Z',
  'sign-out': 'M120,216a8,8,0,0,1-8,8H48a8,8,0,0,1-8-8V40a8,8,0,0,1,8-8h64a8,8,0,0,1,0,16H56V208h56A8,8,0,0,1,120,216Zm109.66-93.66-40-40a8,8,0,0,0-11.32,11.32L204.69,120H112a8,8,0,0,0,0,16h92.69l-26.35,26.34a8,8,0,0,0,11.32,11.32l40-40A8,8,0,0,0,229.66,122.34Z',
  'tree-structure': 'M160,112h48a16,16,0,0,0,16-16V48a16,16,0,0,0-16-16H160a16,16,0,0,0-16,16V64H128a24,24,0,0,0-24,24v32H72v-8A16,16,0,0,0,56,96H24A16,16,0,0,0,8,112v32a16,16,0,0,0,16,16H56a16,16,0,0,0,16-16v-8h32v32a24,24,0,0,0,24,24h16v16a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V160a16,16,0,0,0-16-16H160a16,16,0,0,0-16,16v16H128a8,8,0,0,1-8-8V88a8,8,0,0,1,8-8h16V96A16,16,0,0,0,160,112ZM56,144H24V112H56v32Zm104,16h48v48H160Zm0-112h48V96H160Z',
  'upload-simple': 'M224,144v64a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8V144a8,8,0,0,1,16,0v56H208V144a8,8,0,0,1,16,0ZM93.66,77.66,120,51.31V144a8,8,0,0,0,16,0V51.31l26.34,26.35a8,8,0,0,0,11.32-11.32l-40-40a8,8,0,0,0-11.32,0l-40,40A8,8,0,0,0,93.66,77.66Z',
  users: 'M117.25,157.92a60,60,0,1,0-66.5,0A95.83,95.83,0,0,0,3.53,195.63a8,8,0,1,0,13.4,8.74,80,80,0,0,1,134.14,0,8,8,0,0,0,13.4-8.74A95.83,95.83,0,0,0,117.25,157.92ZM40,108a44,44,0,1,1,44,44A44.05,44.05,0,0,1,40,108Zm210.14,98.7a8,8,0,0,1-11.07-2.33A79.83,79.83,0,0,0,172,168a8,8,0,0,1,0-16,44,44,0,1,0-16.34-84.87,8,8,0,1,1-5.94-14.85,60,60,0,0,1,55.53,105.64,95.83,95.83,0,0,1,47.22,37.71A8,8,0,0,1,250.14,206.7Z',
  'users-three': 'M244.8,150.4a8,8,0,0,1-11.2-1.6A51.6,51.6,0,0,0,192,128a8,8,0,0,1-7.37-4.89,8,8,0,0,1,0-6.22A8,8,0,0,1,192,112a24,24,0,1,0-23.24-30,8,8,0,1,1-15.5-4A40,40,0,1,1,219,117.51a67.94,67.94,0,0,1,27.43,21.68A8,8,0,0,1,244.8,150.4ZM190.92,212a8,8,0,1,1-13.84,8,57,57,0,0,0-98.16,0,8,8,0,1,1-13.84-8,72.06,72.06,0,0,1,33.74-29.92,48,48,0,1,1,58.36,0A72.06,72.06,0,0,1,190.92,212ZM128,176a32,32,0,1,0-32-32A32,32,0,0,0,128,176ZM72,120a8,8,0,0,0-8-8A24,24,0,1,1,87.24,82a8,8,0,1,0,15.5-4A40,40,0,1,0,37,117.51,67.94,67.94,0,0,0,9.6,139.19a8,8,0,1,0,12.8,9.61A51.6,51.6,0,0,1,64,128,8,8,0,0,0,72,120Z',
  'warning-circle': 'M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm-8-80V80a8,8,0,0,1,16,0v56a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,172Z',
  'webhooks-logo': 'M178.16,176H111.32A48,48,0,1,1,25.6,139.19a8,8,0,0,1,12.8,9.61A31.69,31.69,0,0,0,32,168a32,32,0,0,0,64,0,8,8,0,0,1,8-8h74.16a16,16,0,1,1,0,16ZM64,184a16,16,0,0,0,14.08-23.61l35.77-58.14a8,8,0,0,0-2.62-11,32,32,0,1,1,46.1-40.06A8,8,0,1,0,172,44.79a48,48,0,1,0-75.62,55.33L64.44,152c-.15,0-.29,0-.44,0a16,16,0,0,0,0,32Zm128-64a48.18,48.18,0,0,0-18,3.49L142.08,71.6A16,16,0,1,0,128,80l.44,0,35.78,58.15a8,8,0,0,0,11,2.61A32,32,0,1,1,192,200a8,8,0,0,0,0,16,48,48,0,0,0,0-96Z',
  x: 'M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z',
  'x-circle': 'M165.66,101.66,139.31,128l26.35,26.34a8,8,0,0,1-11.32,11.32L128,139.31l-26.34,26.35a8,8,0,0,1-11.32-11.32L116.69,128,90.34,101.66a8,8,0,0,1,11.32-11.32L128,116.69l26.34-26.35a8,8,0,0,1,11.32,11.32ZM232,128A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-16,0a88,88,0,1,0-88,88A88.1,88.1,0,0,0,216,128Z',
} as const

export type IconName = keyof typeof ICON_PATHS

export function icon(name: IconName, size = 16, className = ''): Html {
  return html`<svg class="icon ${className}" viewBox="0 0 256 256" width="${size}" height="${size}" fill="currentColor" aria-hidden="true"><path d="${ICON_PATHS[name]}"/></svg>`
}

/** Polaris page header: back link, title (with optional context line), status badges, then actions with at most one primary. */
/** Every page header is the same: an optional back arrow, the page name, and optional actions. */
export function header(title: string, opts: { back?: string; actions?: Html } = {}): Html {
  return html`<div class="header">
    ${opts.back ? html`<a class="back" href="${opts.back}" aria-label="Back">${icon('arrow-left')}</a>` : ''}
    <div class="header-main">
      <div class="header-title"><h1>${title}</h1></div>
    </div>
    ${opts.actions ? html`<div class="actions">${opts.actions}</div>` : ''}
  </div>`
}

/** A monospace ID or URL with a small copy button, for detail lists and list rows. */
export function copyableId(id: string, domId: string, label = 'Copy ID'): Html {
  return html`<span class="id-copy" title="${id}"><span class="mono" id="${domId}">${id}</span><button type="button" class="icon-btn id-copy-btn" data-copy-target="#${domId}" aria-label="${label}" title="${label}">${icon('copy', 14)}<span data-copy-label aria-live="polite"></span></button></span>`
}

/** A card heading with a place for a secondary action. */
export function cardHead(title: Html | string, action?: Html): Html {
  return html`<div class="card-head"><h2>${title}</h2>${action ? html`<div class="card-head-actions">${action}</div>` : ''}</div>`
}

export interface TabItem {
  key: string
  label: string
  href: string
}

export function tabs(items: readonly TabItem[], active: string): Html {
  return html`<nav class="tabs" aria-label="Sections">
    ${items.map((item) => html`<a href="${item.href}" class="${item.key === active ? 'on' : ''}" ${item.key === active ? html`aria-current="page"` : ''}>${item.label}</a>`)}
  </nav>`
}

/** A settings block: title and explanation on the left, its card on the right (stacked on phones). */
export function settingsSection(
  title: string,
  hint: Html | string,
  body: Html,
  options: { id?: string; badge?: Html; flush?: boolean } = {},
): Html {
  return html`<section class="settings-section" ${options.id ? html`id="${options.id}"` : ''}>
    <div class="settings-aside">
      <div class="settings-heading"><h2>${title}</h2>${options.badge ? html`<span class="settings-badge">${options.badge}</span>` : ''}</div>
      <p class="subdued">${hint}</p>
    </div>
    <div class="card ${options.flush ? 'flush' : ''}">${body}</div>
  </section>`
}

export type AlertTone = 'success' | 'critical' | 'warning' | 'info'

const ALERT_ICONS: Record<AlertTone, IconName> = {
  success: 'check-circle',
  critical: 'x-circle',
  warning: 'warning-circle',
  info: 'info',
}

export function alert(tone: AlertTone, body: Html, options: { style?: string } = {}): Html {
  return html`<div class="banner ${tone}" role="${tone === 'critical' ? 'alert' : 'status'}" data-alert ${options.style ? html`style="${options.style}"` : ''}>
    <span class="banner-icon">${icon(ALERT_ICONS[tone], 20)}</span>
    <div class="banner-content">${body}</div>
    <button type="button" class="banner-close" data-dismiss-alert aria-label="Dismiss" title="Dismiss">${icon('x')}</button>
  </div>`
}

export const badge = (text: string, tone = '') => html`<span class="badge ${tone}">${text}</span>`

export function statusBadge(status: string): Html {
  const tone = status === 'completed' ? 'success' : status === 'failed' ? 'critical' : status === 'processing' ? 'info' : 'attention'
  return html`<span class="badge ${tone}">${status[0]!.toUpperCase() + status.slice(1)}</span>`
}

export function emptyState(heading: string, text: string, action?: Html): Html {
  return html`<div class="empty"><h3>${heading}</h3><p>${text}</p>${action ?? ''}</div>`
}

export const hidden = (fields: Record<string, string>) =>
  Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)

/** A destructive action: a plain red button that POSTs after the confirm dialog. */
export const destroy = (action: string, label: string, confirm: string, fields: Record<string, string> = {}) =>
  html`<form method="post" action="${action}" class="inline" data-confirm="${confirm}" data-confirm-label="${label}" data-confirm-tone="critical">${hidden(fields)}<button class="critical plain">${label}</button></form>`

export function formFooter(cancel: string | null, submit: string): Html {
  return html`<div class="foot">${cancel ? html`<a class="btn" href="${cancel}">Cancel</a>` : ''}<button class="primary">${submit}</button></div>`
}

/** Actions at the end of a page-level form, outside the section cards. */
export function pageFooter(cancel: string | null, submit: string): Html {
  return html`<div class="page-foot">${cancel ? html`<a class="btn" href="${cancel}">Cancel</a>` : ''}<button class="primary">${submit}</button></div>`
}

export const formatBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`

export const when = (iso: string | null | undefined) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—')

export function stat(label: string, value: string | number, href?: string): Html {
  return html`<div class="stat"><span>${label}</span><b>${href ? html`<a href="${href}" style="color:inherit">${value}</a>` : value}</b></div>`
}

export interface SearchOptions {
  action: string
  /** ID of the card the response should swap into. */
  target: string
  placeholder: string
  name?: string
  value?: string
  /** Debounce in milliseconds. */
  delay?: number
  submit?: string
  mono?: boolean
  title?: string
  /** Extra controls, such as a status select, included in the same htmx request. */
  extra?: Html
}

/**
 * A filter form that works without JavaScript and turns into a live,
 * URL-pushing htmx search when JavaScript is available.
 */
export function searchForm(options: SearchOptions): Html {
  const { action, target, placeholder, name = 'search', value = '', delay = 300, submit, mono, title, extra } = options
  return html`<form class="toolbar" method="get" action="${action}" hx-get="${action}" hx-target="#${target}" hx-select="#${target}" hx-swap="outerHTML" hx-push-url="true" hx-trigger="submit, input changed delay:${delay}ms from:find input, change from:find select">
    <input type="search" name="${name}" value="${value}" placeholder="${placeholder}" autocomplete="off" ${mono ? html`class="mono"` : ''} ${title ? html`title="${title}"` : ''}>
    ${extra ?? ''}
    ${submit ? html`<button>${submit}</button>` : ''}
  </form>`
}

export interface PagerOptions {
  page: number
  pages: number
  /** Query parameters to keep across page links. */
  params?: Record<string, string>
  label?: Html | string
  /** Show the page label even when there is only one page. */
  always?: boolean
}

export function pager({ page, pages, params = {}, label, always = false }: PagerOptions): Html {
  if (pages <= 1 && !always) return html``
  const href = (n: number) => {
    const search = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== '') search.set(k, v)
    search.set('page', String(n))
    return `?${search.toString()}`
  }
  return html`<div class="pager">
    ${page > 1 ? html`<a class="btn" href="${href(page - 1)}">Previous</a>` : ''}
    <span class="subdued">${label ?? `Page ${page} of ${pages}`}</span>
    ${page < pages ? html`<a class="btn" href="${href(page + 1)}">Next</a>` : ''}
  </div>`
}

export interface ListCardParts {
  toolbar?: Html
  body: Html
  footer?: Html
}

/** The standard list surface: a flush card with toolbar, table and pager. */
export function listCard(id: string, parts: ListCardParts): Html {
  return html`<div class="card flush" id="${id}">${parts.toolbar ?? ''}${parts.body}${parts.footer ?? ''}</div>`
}

/** Attributes that make an element refresh itself on an interval. */
export function poll(url: string, target: string, seconds: number): Html {
  return html`hx-get="${url}" hx-select="#${target}" hx-target="#${target}" hx-swap="outerHTML" hx-trigger="every ${seconds}s"`
}

const TILE_TONES = ['blue', 'green', 'orange', 'purple', 'pink', 'teal'] as const

/** A square initial tile that gives each project a stable, recognisable colour. */
export function tile(name: string, key: string, size: 'sm' | 'md' | 'lg' = 'md'): Html {
  let hash = 0
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  const tone = TILE_TONES[hash % TILE_TONES.length]
  return html`<span class="tile ${size} ${tone}" aria-hidden="true">${(name.trim()[0] ?? '?').toUpperCase()}</span>`
}

/** Up to two initials from a name or email address. */
export function initials(source: string): string {
  return (
    source
      .split(/[\s@._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]!.toUpperCase())
      .join('') || '?'
  )
}

export const avatar = (source: string, size: 'sm' | 'md' = 'sm') =>
  html`<span class="avatar ${size}" aria-hidden="true">${initials(source)}</span>`

/** A calendar date such as "27 Oct 2026". */
export const day = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—'

export interface MenuOptions {
  label: string
  /** Custom trigger content; defaults to a "⋯" icon button. */
  trigger?: Html
  triggerClass?: string
  align?: 'start' | 'end'
  className?: string
}

/**
 * A dropdown built on <details>. MENU_SCRIPT positions it against the
 * viewport so tables and the sidebar never clip it; without JavaScript it
 * still opens in place.
 */
export function menu(items: Html, options: MenuOptions): Html {
  return html`<details class="menu-root ${options.className ?? ''}" data-align="${options.align ?? 'end'}">
    <summary class="${options.triggerClass ?? 'icon-btn'}" aria-label="${options.label}" title="${options.label}">${options.trigger ?? icon('dots-three', 18)}</summary>
    <div class="menu" role="menu">${items}</div>
  </details>`
}
