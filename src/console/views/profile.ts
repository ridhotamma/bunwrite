/** Markup for the signed-in admin's profile: photo, name and password. */
import type { Admin } from '~/console/auth'
import { avatarUrl } from '~/console/auth'
import { html, raw, type Html } from '~/console/html'
import { avatar, badge, day, icon, initials, settingsSection } from '~/console/ui'
import type { OrganizationMember } from '~/organizations/service'

export const PROFILE = '/console/profile'
/** Largest photo the console accepts before resizing it. */
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024
export const PHOTO_TYPES = 'image/png,image/jpeg,image/webp,image/gif'

/**
 * Shows the picked photo in the preview before it is uploaded, and turns the
 * Save button on. Without JavaScript the form still posts the file.
 */
const PHOTO_SCRIPT = `
(() => {
  const form = document.getElementById('photo-form')
  if (!form || form.dataset.ready) return
  form.dataset.ready = '1'
  const input = form.querySelector('[data-photo-input]')
  const preview = document.querySelector('[data-photo-preview]')
  const save = form.querySelector('[data-photo-save]')
  const cancel = form.querySelector('[data-photo-cancel]')
  const status = form.querySelector('[data-photo-status]')
  const original = preview.innerHTML
  const max = ${PHOTO_MAX_BYTES}
  save.disabled = true
  const reset = () => {
    input.value = ''
    preview.innerHTML = original
    preview.classList.toggle('has-photo', !!preview.querySelector('img'))
    save.disabled = true
    cancel.hidden = true
    status.textContent = ''
    status.classList.remove('error')
  }
  input.addEventListener('change', () => {
    const file = input.files && input.files[0]
    if (!file) return reset()
    if (!/^image\\//.test(file.type)) {
      reset()
      status.textContent = 'Pick a PNG, JPEG, WebP or GIF image.'
      status.classList.add('error')
      return
    }
    if (file.size > max) {
      reset()
      status.textContent = 'That image is larger than 5 MB.'
      status.classList.add('error')
      return
    }
    const img = document.createElement('img')
    img.alt = ''
    img.src = URL.createObjectURL(file)
    preview.replaceChildren(img)
    preview.classList.add('has-photo')
    save.disabled = false
    cancel.hidden = false
    status.classList.remove('error')
    status.textContent = file.name
  })
  cancel.addEventListener('click', reset)
})()
`

export interface ProfileViewOptions {
  admin: Admin & { created_at: string }
  member: OrganizationMember
}

export function profileView({ admin, member }: ProfileViewOptions): Html {
  const name = member.name || admin.email
  const photo = avatarUrl(admin)

  const head = html`<div class="profile-head">
    ${avatar(name, 'xl', photo)}
    <div class="profile-title">
      <h1>${name}</h1>
      <p class="subdued">${admin.email}</p>
      <div class="profile-meta">
        ${badge(member.role === 'owner' ? 'Owner' : 'Developer', member.role === 'owner' ? 'info' : '')}
        <span class="subdued">Joined ${day(member.joinedAt ?? admin.created_at)}</span>
        ${admin.mfa ? html`<span class="subdued">· Email MFA on</span>` : ''}
      </div>
    </div>
  </div>`

  const photoSection = settingsSection(
    'Photo',
    'Shown in the sidebar and on the Members page. PNG, JPEG, WebP or GIF up to 5 MB. It is cropped to a square.',
    html`<div class="photo-row">
        <span class="avatar xl ${photo ? 'has-photo' : ''}" data-photo-preview aria-hidden="true">${photo ? html`<img src="${photo}" alt="">` : initials(name)}</span>
        <form id="photo-form" method="post" action="${PROFILE}/photo" enctype="multipart/form-data" class="photo-form">
          <div class="photo-actions">
            <label class="btn">${icon('upload-simple')}<span>${photo ? 'Change photo' : 'Choose photo'}</span><input class="visually-hidden" type="file" name="photo" accept="${PHOTO_TYPES}" required data-photo-input></label>
            <button class="primary" data-photo-save>Save photo</button>
            <button type="button" data-photo-cancel hidden>Cancel</button>
          </div>
          <small class="photo-status subdued" data-photo-status aria-live="polite"></small>
        </form>
        ${photo
          ? html`<form method="post" action="${PROFILE}/photo/delete" class="photo-remove" data-confirm="Remove your profile photo? Your initials are shown instead." data-confirm-label="Remove photo">
              <button class="critical">Remove</button>
            </form>`
          : ''}
      </div>
      <script>${raw(PHOTO_SCRIPT)}</script>`,
    { id: 'photo' },
  )

  const nameSection = settingsSection(
    'Name',
    'How other members of the organization see you.',
    html`<form method="post" action="${PROFILE}/name">
      <label>Name<input name="name" value="${member.name}" maxlength="128" autocomplete="name" required></label>
      <label>Email<input value="${admin.email}" disabled><small>Your sign-in email. An operator can change it with <code>bunwrite console:admin</code>.</small></label>
      <div class="foot"><button class="primary">Save</button></div>
    </form>`,
    { id: 'name' },
  )

  const passwordSection = settingsSection(
    'Password',
    'Use at least 8 characters. Changing it signs you out everywhere except this browser.',
    html`<form method="post" action="${PROFILE}/password">
      <input type="text" name="username" value="${admin.email}" autocomplete="username" hidden>
      <label>Current password<input type="password" name="current" autocomplete="current-password" required></label>
      <label>New password<input type="password" name="next" autocomplete="new-password" minlength="8" maxlength="256" required></label>
      <label>Confirm new password<input type="password" name="confirm" autocomplete="new-password" minlength="8" maxlength="256" required></label>
      <div class="foot"><button class="primary">Change password</button></div>
    </form>`,
    { id: 'password' },
  )

  return html`${head}${photoSection}${nameSection}${passwordSection}`
}
