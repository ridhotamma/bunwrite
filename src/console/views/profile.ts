/** Markup for the signed-in admin's profile: photo, name and password. */
import type { Admin } from '~/console/auth'
import { avatarUrl } from '~/console/auth'
import { html, raw, type Html } from '~/console/html'
import { badge, day, icon, initials, settingsSection } from '~/console/ui'
import type { OrganizationMember } from '~/organizations/service'

export const PROFILE = '/console/profile'
/** Largest photo the console accepts before resizing it. */
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024
export const PHOTO_TYPES = 'image/png,image/jpeg,image/webp,image/gif'

/**
 * Photo: everything happens on the header avatar. With no photo, clicking it
 * opens the file picker; with one, it opens a menu to upload a new photo or
 * remove it. A picked file shows in the avatar and uploads at once.
 * Password: the form stays folded until asked for, or when an error sends the
 * page back to #password; the confirm field says when it does not match.
 */
const PROFILE_SCRIPT = `
(() => {
  const form = document.getElementById('photo-form')
  if (!form || form.dataset.ready) return
  form.dataset.ready = '1'
  const head = form.closest('.profile-head')
  const input = form.querySelector('[data-photo-input]')
  const preview = head.querySelector('[data-photo-preview]')
  const status = head.querySelector('[data-photo-status]')
  const max = ${PHOTO_MAX_BYTES}
  const fail = (text) => {
    input.value = ''
    status.textContent = text
    status.hidden = false
  }
  input.addEventListener('change', () => {
    const file = input.files && input.files[0]
    if (!file) return
    if (!/^image\\//.test(file.type)) return fail('Pick a PNG, JPEG, WebP or GIF image.')
    if (file.size > max) return fail('That image is larger than 5 MB.')
    status.hidden = true
    const img = document.createElement('img')
    img.alt = ''
    img.src = URL.createObjectURL(file)
    preview.replaceChildren(img)
    preview.classList.add('has-photo')
    head.classList.add('uploading')
    form.submit()
  })
  for (const pick of head.querySelectorAll('[data-photo-pick]')) pick.addEventListener('click', () => input.click())

  const pw = document.querySelector('[data-password]')
  if (pw) {
    const open = () => { pw.open = true; pw.querySelector('input[name=current]').focus() }
    if (location.hash === '#password') pw.open = true
    window.addEventListener('hashchange', () => { if (location.hash === '#password') open() })
    pw.querySelector('[data-password-cancel]').addEventListener('click', () => {
      pw.querySelector('form').reset()
      pw.open = false
    })
    pw.addEventListener('toggle', () => { if (pw.open) pw.querySelector('input[name=current]').focus() })
    const next = pw.querySelector('input[name=next]')
    const confirm = pw.querySelector('input[name=confirm]')
    const check = () => confirm.setCustomValidity(confirm.value && confirm.value !== next.value ? 'The passwords do not match.' : '')
    next.addEventListener('input', check)
    confirm.addEventListener('input', check)
  }
})()
`

export interface ProfileViewOptions {
  admin: Admin & { created_at: string }
  member: OrganizationMember
}

export function profileView({ admin, member }: ProfileViewOptions): Html {
  const name = member.name || admin.email
  const photo = avatarUrl(admin)
  const owner = member.role === 'owner'

  const face = html`<span class="avatar xl ${photo ? 'has-photo' : ''}" data-photo-preview>${photo ? html`<img src="${photo}" alt="">` : initials(name)}</span>
    <span class="profile-avatar-edit" aria-hidden="true">${icon('upload-simple', 20)}</span>`

  // The avatar is the only photo control: a picker when empty, a menu when set.
  const picker = photo
    ? html`<details class="menu-root profile-avatar-menu" data-align="start">
        <summary class="profile-avatar" aria-label="Photo options">${face}</summary>
        <div class="menu" role="menu">
          <button type="button" class="menu-item" data-photo-pick>${icon('upload-simple')}<span class="menu-item-text">Upload new photo</span></button>
          <form method="post" action="${PROFILE}/photo/delete" data-confirm="Remove your profile photo? Your initials are shown instead." data-confirm-label="Remove photo">
            <button class="critical">${icon('x')}<span class="menu-item-text">Remove photo</span></button>
          </form>
        </div>
      </details>`
    : html`<button type="button" class="profile-avatar" aria-label="Add a photo" data-photo-pick>${face}</button>`

  const head = html`<div class="profile-head">
    <div class="profile-photo">
      ${picker}
      <form id="photo-form" method="post" action="${PROFILE}/photo" enctype="multipart/form-data" hidden>
        <input type="file" name="photo" accept="${PHOTO_TYPES}" required data-photo-input>
      </form>
      <noscript>
        <form method="post" action="${PROFILE}/photo" enctype="multipart/form-data" class="profile-photo-noscript">
          <input type="file" name="photo" accept="${PHOTO_TYPES}" required><button class="small">Save photo</button>
        </form>
      </noscript>
    </div>
    <div class="profile-title">
      <h1>${name}</h1>
      <p class="subdued">${admin.email}</p>
      <div class="profile-meta">
        ${badge(owner ? 'Owner' : 'Developer', owner ? 'info' : '')}
        <span class="subdued">Joined ${day(member.joinedAt ?? admin.created_at)}</span>
        ${admin.mfa ? html`<span class="subdued">· Email MFA on</span>` : ''}
      </div>
      <small class="photo-status" data-photo-status role="alert" hidden></small>
    </div>
  </div>`

  const detailsSection = settingsSection(
    'Details',
    'How other members of the organization see you. Photos are cropped to a square, up to 5 MB.',
    html`<form method="post" action="${PROFILE}/name">
      <label>Name<input name="name" value="${member.name}" maxlength="128" autocomplete="name" required></label>
      <label>Email<input value="${admin.email}" readonly tabindex="-1"><small>Used to sign in. An operator can change it with <code>bunwrite console:admin</code>.</small></label>
      <div class="foot"><button class="primary">Save</button></div>
    </form>`,
    { id: 'name' },
  )

  const passwordSection = settingsSection(
    'Password',
    'Changing it signs you out everywhere except this browser.',
    html`<details class="password-box" data-password>
      <summary>
        <span class="password-row">${icon('key')}<span class="password-dots" aria-hidden="true">••••••••••</span></span>
        <span class="btn">Change password</span>
      </summary>
      <form method="post" action="${PROFILE}/password">
        <input type="text" name="username" value="${admin.email}" autocomplete="username" hidden>
        <label>Current password<input type="password" name="current" autocomplete="current-password" required></label>
        <label>New password<input type="password" name="next" autocomplete="new-password" minlength="8" maxlength="256" required><small>At least 8 characters.</small></label>
        <label>Confirm new password<input type="password" name="confirm" autocomplete="new-password" minlength="8" maxlength="256" required></label>
        <div class="foot"><button type="button" data-password-cancel>Cancel</button><button class="primary">Change password</button></div>
      </form>
    </details>`,
    { id: 'password' },
  )

  return html`${head}${detailsSection}${passwordSection}<script>${raw(PROFILE_SCRIPT)}</script>`
}
