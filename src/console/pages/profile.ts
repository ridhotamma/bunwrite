/** The signed-in admin's profile: photo, display name and password. */
import type { ConsoleContext, ConsoleRouter } from '~/console/context'
import { value } from '~/console/forms'
import { PHOTO_MAX_BYTES, PROFILE, profileView } from '~/console/views/profile'
import { err } from '~/lib/errors'
import { loadSharp } from '~/storage/sharp'

/** Photos are stored as a 256px square, enough for a retina avatar. */
const PHOTO_SIZE = 256

async function resizePhoto(ctx: ConsoleContext, file: File): Promise<Buffer> {
  const sharp = await loadSharp(ctx.projects.control.config)
  try {
    // First frame only, turned upright from EXIF, cropped to the busiest part of the picture.
    return await sharp(Buffer.from(await file.arrayBuffer()), { limitInputPixels: 50_000_000, animated: false })
      .rotate()
      .resize(PHOTO_SIZE, PHOTO_SIZE, { fit: 'cover', position: 'attention' })
      .webp({ quality: 82 })
      .toBuffer()
  } catch {
    throw err('general_argument_invalid', 'That file is not an image we can read. Try a PNG, JPEG or WebP.')
  }
}

export function profilePages(router: ConsoleRouter): void {
  router.get(PROFILE, async ({ ctx }) => {
    const admin = (await ctx.auth.find(ctx.admin.email))!
    return ctx.render('Profile', 'profile', profileView({ admin, member: ctx.member }))
  })

  router.post(`${PROFILE}/photo`, async ({ ctx }) => {
    const file = ctx.form.photo
    if (!(file instanceof File) || file.size === 0) throw err('general_argument_invalid', 'Choose a photo to upload.')
    if (file.size > PHOTO_MAX_BYTES) throw err('general_argument_invalid', 'That image is larger than 5 MB.')
    await ctx.auth.setAvatar(ctx.admin.seq, await resizePhoto(ctx, file))
    return ctx.go(PROFILE, { tone: 'success', text: 'Photo updated' })
  })

  router.post(`${PROFILE}/photo/delete`, async ({ ctx }) => {
    await ctx.auth.setAvatar(ctx.admin.seq, null)
    return ctx.go(PROFILE, { tone: 'success', text: 'Photo removed' })
  })

  router.post(`${PROFILE}/name`, async ({ ctx }) => {
    await ctx.organizations.renameMember(ctx.projects.control.config.orgId, ctx.admin.email, value(ctx.form, 'name'))
    return ctx.go(PROFILE, { tone: 'success', text: 'Name saved' })
  })

  router.post(`${PROFILE}/password`, async ({ ctx }) => {
    // Checking the current password is a password oracle; limit it like sign-in.
    try {
      await ctx.limiter.hit(`console-password:${ctx.admin.seq}:${ctx.ip}`, 10, 900)
    } catch {
      return ctx.go(`${PROFILE}#password`, { tone: 'critical', text: 'Too many attempts. Try again in 15 minutes.' })
    }
    const next = String(ctx.form.next ?? '')
    if (!(await ctx.auth.verifyPassword(ctx.admin.seq, String(ctx.form.current ?? '')))) {
      return ctx.go(`${PROFILE}#password`, { tone: 'critical', text: 'Your current password is not correct.' })
    }
    if (next !== String(ctx.form.confirm ?? '')) {
      return ctx.go(`${PROFILE}#password`, { tone: 'critical', text: 'The new passwords do not match.' })
    }
    if (next.length < 8 || next.length > 256) {
      return ctx.go(`${PROFILE}#password`, { tone: 'critical', text: 'Use a new password of 8 to 256 characters.' })
    }
    await ctx.auth.changePassword(ctx.admin.seq, next, ctx.auth.secretOf(ctx.request))
    return ctx.go(PROFILE, { tone: 'success', text: 'Password changed. Other sessions were signed out.' })
  })

  /** Any signed-in admin may see another's photo: the Members page shows them all. */
  router.get('/console/avatars/:seq', async ({ ctx, path, request }) => {
    const seq = Number(path.seq)
    const photo = Number.isInteger(seq) ? await ctx.auth.avatar(seq) : null
    if (!photo) return new Response('Not found', { status: 404 })
    const etag = `"${photo.at}"`
    const headers = {
      'content-type': photo.type,
      etag,
      // The URL carries the version, so a cached copy never goes stale.
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    }
    if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers })
    return new Response(new Uint8Array(photo.data), { headers })
  })
}
