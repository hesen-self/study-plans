import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AVATAR_MAX_BYTES,
  avatarUserSegment,
  buildAvatarKey,
  detectImageKind,
  inspectAvatarUpload,
  isOwnedAvatarKey,
  isStoredAvatarKey,
  publicAvatarUrl,
  requestLooksTooLarge,
  toClientAvatar,
} from '../worker/avatar.ts'
import app from '../worker/index.ts'

function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3])
}
function jpegBytes(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3])
}
function gifBytes(): Uint8Array {
  return new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 1])
}
function webpBytes(): Uint8Array {
  const b = new Uint8Array(16)
  b.set([0x52, 0x49, 0x46, 0x46], 0)
  b.set([0x57, 0x45, 0x42, 0x50], 8)
  return b
}
function svgBytes(): Uint8Array {
  return new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
}

test('detects real image signatures and rejects svg/html/exe', () => {
  assert.equal(detectImageKind(pngBytes()), 'png')
  assert.equal(detectImageKind(jpegBytes()), 'jpeg')
  assert.equal(detectImageKind(gifBytes()), 'gif')
  assert.equal(detectImageKind(webpBytes()), 'webp')
  assert.equal(detectImageKind(svgBytes()), null)
  assert.equal(detectImageKind(new TextEncoder().encode('<!DOCTYPE html>')), null)
  assert.equal(detectImageKind(new Uint8Array([0x4d, 0x5a, 0x90, 0x00])), null)
})

test('inspectAvatarUpload enforces size, whitelist, and content/type match', () => {
  assert.equal(AVATAR_MAX_BYTES, 5 * 1024 * 1024)
  assert.equal(inspectAvatarUpload({ bytes: new Uint8Array() }).ok, false)
  const atLimit = new Uint8Array(AVATAR_MAX_BYTES)
  atLimit.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const allowed = inspectAvatarUpload({ bytes: atLimit, declaredType: 'image/png' })
  assert.equal(allowed.ok, true)

  const tooBig = new Uint8Array(AVATAR_MAX_BYTES + 1)
  tooBig.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const oversized = inspectAvatarUpload({ bytes: tooBig, declaredType: 'image/png' })
  assert.equal(oversized.ok, false)
  if (!oversized.ok) assert.equal(oversized.status, 413)

  const svgDeclared = inspectAvatarUpload({ bytes: svgBytes(), declaredType: 'image/svg+xml' })
  assert.equal(svgDeclared.ok, false)
  if (!svgDeclared.ok) assert.equal(svgDeclared.status, 415)

  const pngAsJpeg = inspectAvatarUpload({ bytes: pngBytes(), declaredType: 'image/jpeg' })
  assert.equal(pngAsJpeg.ok, false)

  const exeAsPng = inspectAvatarUpload({
    bytes: new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03]),
    declaredType: 'image/png',
  })
  assert.equal(exeAsPng.ok, false)

  const ok = inspectAvatarUpload({ bytes: pngBytes(), declaredType: 'image/png' })
  assert.equal(ok.ok, true)
  if (ok.ok) {
    assert.equal(ok.ext, 'png')
    assert.equal(ok.contentType, 'image/png')
  }
})

test('requestLooksTooLarge allows multipart overhead under the cap', () => {
  assert.equal(requestLooksTooLarge(undefined), false)
  assert.equal(requestLooksTooLarge(String(AVATAR_MAX_BYTES)), false)
  assert.equal(requestLooksTooLarge(String(AVATAR_MAX_BYTES + 64 * 1024 + 1)), true)
})

test('server-generated keys are owned by the user and reject traversal/foreign keys', () => {
  const key = buildAvatarKey('alice@example.com', 'png')
  assert.equal(isStoredAvatarKey(key), true)
  assert.equal(isOwnedAvatarKey(key, 'alice@example.com'), true)
  assert.equal(isOwnedAvatarKey(key, 'bob@example.com'), false)
  assert.equal(isStoredAvatarKey('avatars/alice@example.com/../notes/x.md'), false)
  assert.equal(isStoredAvatarKey('notes/alice@example.com/n.md'), false)
  assert.equal(isStoredAvatarKey('avatars/alice@example.com/not-a-uuid.png'), false)
  assert.equal(isOwnedAvatarKey('avatars/bob@example.com/11111111-1111-1111-1111-111111111111.png', 'alice@example.com'), false)
  assert.equal(avatarUserSegment('../notes/default'), '.._notes_default')
  assert.equal(avatarUserSegment(''), 'unknown')
})

test('toClientAvatar never exposes raw object keys or dangerous URLs', () => {
  const key = 'avatars/alice@example.com/11111111-1111-1111-1111-111111111111.png'
  assert.equal(toClientAvatar(key, '2026-11-12 04:00:00'), '/api/profile/avatar?v=2026-11-12%2004%3A00%3A00')
  assert.equal(toClientAvatar('https://cdn.example.com/a.png'), 'https://cdn.example.com/a.png')
  assert.equal(toClientAvatar('javascript:alert(1)'), '')
  assert.equal(toClientAvatar('data:image/png;base64,aaaa'), '')
  assert.equal(toClientAvatar('avatars/not-valid'), '')
  assert.equal(publicAvatarUrl('t').startsWith('/api/profile/avatar?v='), true)
})

type StoredObject = {
  body: Uint8Array
  httpMetadata?: { contentType?: string; contentDisposition?: string; cacheControl?: string }
  customMetadata?: Record<string, string>
}

function createEnv() {
  const profiles = new Map<string, Record<string, string>>()
  const objects = new Map<string, StoredObject>()

  const DB = {
    prepare(sql: string) {
      const stmt: {
        _args: unknown[]
        bind: (...args: unknown[]) => typeof stmt
        first: <T>() => Promise<T | null>
        run: () => Promise<{ success: true }>
      } = {
        _args: [],
        bind(...args: unknown[]) {
          stmt._args = args
          return stmt
        },
        async first<T>() {
          const uid = String(stmt._args[0] ?? '')
          const row = profiles.get(uid)
          return (row ? ({ ...row } as T) : null)
        },
        async run() {
          const uid = String(stmt._args[0] ?? '')
          const existing = profiles.get(uid) ?? {
            user_id: uid,
            nickname: '',
            avatar: '',
            bio: '',
            goal: '',
            email: '',
            phone: '',
            location: '',
            website: '',
            updated_at: '',
          }
          if (sql.includes('INSERT INTO profile (user_id, avatar, updated_at)')) {
            existing.avatar = String(stmt._args[1] ?? '')
            existing.updated_at = '2026-11-12 05:00:00'
            existing.user_id = uid
            profiles.set(uid, existing)
          } else if (sql.includes('INSERT INTO profile (user_id, nickname, avatar, bio, goal')) {
            const hasRow = profiles.has(uid)
            existing.nickname = String(stmt._args[1] ?? '')
            existing.bio = String(stmt._args[3] ?? '')
            existing.goal = String(stmt._args[4] ?? '')
            existing.email = String(stmt._args[5] ?? '')
            existing.phone = String(stmt._args[6] ?? '')
            existing.location = String(stmt._args[7] ?? '')
            existing.website = String(stmt._args[8] ?? '')
            existing.updated_at = '2026-11-12 05:01:00'
            if (!hasRow) existing.avatar = String(stmt._args[2] ?? '')
            // ON CONFLICT does not update avatar
            profiles.set(uid, existing)
          }
          return { success: true as const }
        },
      }
      return stmt
    },
  }

  const NOTES = {
    async put(key: string, value: ArrayBuffer | ArrayBufferView | Uint8Array, options?: StoredObject) {
      const body = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer)
      objects.set(key, {
        body,
        httpMetadata: options?.httpMetadata,
        customMetadata: options?.customMetadata,
      })
      return { key, size: body.byteLength }
    },
    async get(key: string) {
      const obj = objects.get(key)
      if (!obj) return null
      return {
        body: obj.body,
        httpEtag: '"etag"',
        writeHttpMetadata(headers: Headers) {
          if (obj.httpMetadata?.contentType) headers.set('content-type', obj.httpMetadata.contentType)
          if (obj.httpMetadata?.contentDisposition) headers.set('content-disposition', obj.httpMetadata.contentDisposition)
          if (obj.httpMetadata?.cacheControl) headers.set('cache-control', obj.httpMetadata.cacheControl)
        },
      }
    },
    async delete(key: string) {
      objects.delete(key)
    },
    _objects: objects,
  }

  const env = {
    DB,
    NOTES,
    STATS_KV: { get: async () => null, delete: async () => {} },
    VECTORS: {},
    AI: {},
    ASSETS: { fetch: async () => new Response('missing', { status: 404 }) },
  }
  return { env, profiles, objects }
}

function accessJwt(email: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ email })).toString('base64url')
  return `${header}.${payload}.x`
}

async function request(
  env: ReturnType<typeof createEnv>['env'],
  path: string,
  init: RequestInit & { email?: string } = {},
) {
  const headers = new Headers(init.headers)
  if (init.email) headers.set('cf-access-jwt-assertion', accessJwt(init.email))
  return app.request(path, { ...init, headers }, env)
}

test('upload stores a random key and returns a same-origin read URL, not the object key', async () => {
  const { env, objects, profiles } = createEnv()
  const file = new File([pngBytes()], 'face.png', { type: 'image/png' })
  const body = new FormData()
  body.append('file', file)
  const res = await request(env, '/api/profile/avatar', { method: 'POST', body, email: 'alice@example.com' })
  assert.equal(res.status, 200)
  const json = (await res.json()) as { avatar: string }
  assert.equal(json.avatar.startsWith('/api/profile/avatar?v='), true)
  assert.equal(json.avatar.includes('avatars/'), false)
  const stored = [...objects.keys()]
  assert.equal(stored.length, 1)
  assert.match(stored[0], /^avatars\/alice@example.com\/[0-9a-f-]{36}\.png$/)
  assert.equal(profiles.get('alice@example.com')?.avatar, stored[0])
})

test('GET avatar serves only the current user object and ignores attacker-supplied keys', async () => {
  const { env, objects } = createEnv()
  const file = new File([jpegBytes()], 'a.jpg', { type: 'image/jpeg' })
  const body = new FormData()
  body.append('file', file)
  await request(env, '/api/profile/avatar', { method: 'POST', body, email: 'alice@example.com' })
  const aliceKey = [...objects.keys()][0]

  const ok = await request(env, `/api/profile/avatar?key=${encodeURIComponent(aliceKey)}`, {
    email: 'alice@example.com',
  })
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('content-type'), 'image/jpeg')
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff')
  const served = new Uint8Array(await ok.arrayBuffer())
  assert.deepEqual(served, jpegBytes())

  const bob = await request(env, `/api/profile/avatar?key=${encodeURIComponent(aliceKey)}`, {
    email: 'bob@example.com',
  })
  assert.equal(bob.status, 404)

  const bobProfile = await request(env, '/api/profile', { email: 'bob@example.com' })
  const bobJson = (await bobProfile.json()) as { avatar: string }
  assert.equal(bobJson.avatar, '')
})

test('replacing an avatar deletes the previous object and refresh URL changes', async () => {
  const { env, objects, profiles } = createEnv()
  const first = new FormData()
  first.append('file', new File([pngBytes()], 'a.png', { type: 'image/png' }))
  const r1 = await request(env, '/api/profile/avatar', { method: 'POST', body: first, email: 'alice@example.com' })
  const firstUrl = ((await r1.json()) as { avatar: string }).avatar
  const firstKey = profiles.get('alice@example.com')!.avatar
  assert.equal(objects.has(firstKey), true)

  const second = new FormData()
  second.append('file', new File([jpegBytes()], 'b.jpg', { type: 'image/jpeg' }))
  const r2 = await request(env, '/api/profile/avatar', { method: 'POST', body: second, email: 'alice@example.com' })
  const secondUrl = ((await r2.json()) as { avatar: string }).avatar
  const secondKey = profiles.get('alice@example.com')!.avatar
  assert.notEqual(firstKey, secondKey)
  assert.equal(objects.has(firstKey), false)
  assert.equal(objects.has(secondKey), true)
  assert.equal(secondUrl.startsWith('/api/profile/avatar?v='), true)
  // same path so refresh works; cache buster comes from updated_at
  assert.equal(new URL(firstUrl, 'http://example.test').pathname, '/api/profile/avatar')
  assert.equal(new URL(secondUrl, 'http://example.test').pathname, '/api/profile/avatar')
})

test('rejected uploads: svg, mismatched type, too large; profile PUT cannot overwrite avatar key', async () => {
  const { env, profiles } = createEnv()

  const svg = new FormData()
  svg.append('file', new File([svgBytes()], 'x.svg', { type: 'image/svg+xml' }))
  const svgRes = await request(env, '/api/profile/avatar', { method: 'POST', body: svg, email: 'alice@example.com' })
  assert.equal(svgRes.status, 415)

  const mismatch = new FormData()
  mismatch.append('file', new File([pngBytes()], 'x.jpg', { type: 'image/jpeg' }))
  const mismatchRes = await request(env, '/api/profile/avatar', { method: 'POST', body: mismatch, email: 'alice@example.com' })
  assert.equal(mismatchRes.status, 415)

  const exact = new Uint8Array(AVATAR_MAX_BYTES)
  exact.set(pngBytes())
  const exactForm = new FormData()
  exactForm.append('file', new File([exact], 'exact.png', { type: 'image/png' }))
  const exactRes = await request(env, '/api/profile/avatar', { method: 'POST', body: exactForm, email: 'alice@example.com' })
  assert.equal(exactRes.status, 200)

  const big = new Uint8Array(AVATAR_MAX_BYTES + 1)
  big.set(pngBytes())
  const huge = new FormData()
  huge.append('file', new File([big], 'big.png', { type: 'image/png' }))
  const hugeRes = await request(env, '/api/profile/avatar', { method: 'POST', body: huge, email: 'alice@example.com' })
  assert.equal(hugeRes.status, 413)

  const ok = new FormData()
  ok.append('file', new File([pngBytes()], 'ok.png', { type: 'image/png' }))
  await request(env, '/api/profile/avatar', { method: 'POST', body: ok, email: 'alice@example.com' })
  const storedKey = profiles.get('alice@example.com')!.avatar

  const put = await request(env, '/api/profile', {
    method: 'PUT',
    email: 'alice@example.com',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      nickname: 'Alice',
      avatar: 'avatars/bob@example.com/11111111-1111-1111-1111-111111111111.png',
      bio: 'hi',
    }),
  })
  assert.equal(put.status, 200)
  const putJson = (await put.json()) as { avatar: string }
  assert.equal(putJson.avatar.startsWith('/api/profile/avatar?v='), true)
  assert.equal(profiles.get('alice@example.com')?.avatar, storedKey)
  assert.equal(profiles.get('alice@example.com')?.nickname, 'Alice')
})
