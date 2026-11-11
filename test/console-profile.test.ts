/** The profile page: a console admin's own photo, name and password. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import sharp from 'sharp'

import { ConsoleAuth } from '~/console/auth'
import { startServer, type TestServer } from './helpers'

let server: TestServer
let base: string
let cookie = ''

const post = (path: string, body: URLSearchParams | FormData, as = cookie) =>
  fetch(`${base}${path}`, { method: 'POST', body, redirect: 'manual', headers: { cookie: as } })
const get = (path: string, as = cookie) => fetch(`${base}${path}`, { headers: { cookie: as }, redirect: 'manual' })
const flash = (res: Response) => new URL(res.headers.get('location') ?? '/', base).searchParams

async function signIn(password: string): Promise<string> {
  const res = await post('/console/login', new URLSearchParams({ email: 'me@example.com', password }), '')
  expect(res.status).toBe(303)
  return res.headers.get('set-cookie')!.split(';')[0]!
}

beforeAll(async () => {
  server = startServer()
  base = server.endpoint.replace(/\/v1$/, '')
  await new ConsoleAuth(server.db).upsert('me@example.com', 'first-password')
  await new ConsoleAuth(server.db).upsert('other@example.com', 'other-password')
  cookie = await signIn('first-password')
})
afterAll(() => server.stop())

describe('console profile', () => {
  test('the profile page is reachable from the account menu and the sidebar', async () => {
    const res = await get('/console/profile')
    expect(res.status).toBe(200)
    const page = await res.text()
    expect(page).toContain('me@example.com')
    expect(page).toContain('action="/console/profile/photo"')
    expect(page).toContain('enctype="multipart/form-data"')
    expect(page).toContain('action="/console/profile/name"')
    expect(page).toContain('action="/console/profile/password"')
    expect(page).toContain('href="/console/profile"')
  })

  test('a member can change their name', async () => {
    const res = await post('/console/profile/name', new URLSearchParams({ name: 'Rina Wijaya' }))
    expect(flash(res).get('ok')).toBe('Name saved')
    expect(await (await get('/console/profile')).text()).toContain('Rina Wijaya')
    expect(await (await get('/console/organization/members')).text()).toContain('Rina Wijaya')
    const blank = await post('/console/profile/name', new URLSearchParams({ name: '  ' }))
    expect(flash(blank).get('err')).toContain('1 to 128')
  })

  test('a member can upload, see and remove a profile photo', async () => {
    const png = await sharp({ create: { width: 640, height: 400, channels: 3, background: '#3366cc' } }).png().toBuffer()
    const body = new FormData()
    body.append('photo', new File([png], 'me.png', { type: 'image/png' }))
    const res = await post('/console/profile/photo', body)
    expect(flash(res).get('ok')).toBe('Photo updated')

    const page = await (await get('/console/profile')).text()
    const url = /src="(\/console\/avatars\/\d+\?v=[^"]+)"/.exec(page)?.[1]
    expect(url).toBeDefined()
    const photo = await get(url!.replace(/&amp;/g, '&'))
    expect(photo.status).toBe(200)
    expect(photo.headers.get('content-type')).toBe('image/webp')
    const meta = await sharp(Buffer.from(await photo.arrayBuffer())).metadata()
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 256, 256])
    // Members see each other's photos.
    expect(await (await get('/console/organization/members')).text()).toContain(url!)

    const junk = new FormData()
    junk.append('photo', new File(['not an image'], 'x.png', { type: 'image/png' }))
    expect(flash(await post('/console/profile/photo', junk)).get('err')).toContain('not an image we can read')

    const removed = await post('/console/profile/photo/delete', new URLSearchParams())
    expect(flash(removed).get('ok')).toBe('Photo removed')
    expect(await (await get('/console/profile')).text()).not.toContain('/console/avatars/')
    expect((await get(url!)).status).toBe(404)
  })

  test('changing the password needs the current one and signs out other sessions', async () => {
    const elsewhere = await signIn('first-password')

    const wrong = await post('/console/profile/password', new URLSearchParams({ current: 'nope', next: 'second-password', confirm: 'second-password' }))
    expect(flash(wrong).get('err')).toBe('Your current password is not correct.')
    const mismatch = await post('/console/profile/password', new URLSearchParams({ current: 'first-password', next: 'second-password', confirm: 'other' }))
    expect(flash(mismatch).get('err')).toBe('The new passwords do not match.')
    const short = await post('/console/profile/password', new URLSearchParams({ current: 'first-password', next: 'short', confirm: 'short' }))
    expect(flash(short).get('err')).toContain('8 to 256')

    const ok = await post('/console/profile/password', new URLSearchParams({ current: 'first-password', next: 'second-password', confirm: 'second-password' }))
    expect(flash(ok).get('ok')).toContain('Password changed')
    // This browser stays signed in; the other session is gone.
    expect((await get('/console/profile')).status).toBe(200)
    expect((await get('/console/profile', elsewhere)).headers.get('location')).toBe('/console/login')
    // The new password works; the old one does not.
    await signIn('second-password')
    const old = await post('/console/login', new URLSearchParams({ email: 'me@example.com', password: 'first-password' }), '')
    expect(old.status).toBe(200)
  })
})
