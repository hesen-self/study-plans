/** 头像上传校验与引用映射（纯函数，便于单测）。对象实际存放在已绑定的 R2 中。 */

export const AVATAR_MAX_BYTES = 5 * 1024 * 1024
export const AVATAR_KEY_PREFIX = 'avatars/'

export type ImageKind = 'jpeg' | 'png' | 'webp' | 'gif'

const KIND_META: Record<ImageKind, { ext: string; contentType: string }> = {
  jpeg: { ext: 'jpg', contentType: 'image/jpeg' },
  png: { ext: 'png', contentType: 'image/png' },
  webp: { ext: 'webp', contentType: 'image/webp' },
  gif: { ext: 'gif', contentType: 'image/gif' },
}

const DECLARED_TO_KIND: Record<string, ImageKind> = {
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

const AVATAR_KEY_RE =
  /^avatars\/[a-zA-Z0-9.@+_-]{1,200}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|gif)$/

export type UploadInspection =
  | { ok: true; kind: ImageKind; ext: string; contentType: string }
  | { ok: false; status: 400 | 413 | 415; error: string }

function startsWithBytes(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) return false
  return sig.every((b, i) => bytes[i] === b)
}

export function detectImageKind(bytes: Uint8Array): ImageKind | null {
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (
    startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return 'gif'
  }
  // RIFF....WEBP
  if (
    bytes.length >= 12 &&
    startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'webp'
  }
  return null
}

export function inspectAvatarUpload(input: {
  bytes: Uint8Array
  declaredType?: string
}): UploadInspection {
  if (!input.bytes.length) {
    return { ok: false, status: 400, error: '请选择要上传的图片' }
  }
  if (input.bytes.byteLength > AVATAR_MAX_BYTES) {
    return { ok: false, status: 413, error: '文件过大，最大 5MB' }
  }

  const declared = (input.declaredType ?? '').split(';')[0].trim().toLowerCase()
  if (
    declared &&
    (declared.includes('svg') ||
      declared.includes('xml') ||
      declared.includes('html') ||
      declared.includes('javascript') ||
      declared === 'text/plain' ||
      declared === 'application/pdf')
  ) {
    return { ok: false, status: 415, error: '仅支持 JPG、PNG、WebP、GIF 图片' }
  }

  const kind = detectImageKind(input.bytes)
  if (!kind) {
    return { ok: false, status: 415, error: '文件不是有效的图片内容' }
  }

  if (declared && declared !== 'application/octet-stream') {
    const declaredKind = DECLARED_TO_KIND[declared]
    if (!declaredKind) {
      return { ok: false, status: 415, error: '仅支持 JPG、PNG、WebP、GIF 图片' }
    }
    if (declaredKind !== kind) {
      return { ok: false, status: 415, error: '文件内容与声明的类型不符' }
    }
  }

  const meta = KIND_META[kind]
  return { ok: true, kind, ext: meta.ext, contentType: meta.contentType }
}

export function avatarUserSegment(uid: string): string {
  const s = uid.replace(/[^a-zA-Z0-9.@+-]/g, '_').slice(0, 200)
  if (!s || s === '.' || s === '..') return 'unknown'
  return s
}

export function buildAvatarKey(uid: string, ext: string): string {
  const safeExt = ext === 'jpeg' ? 'jpg' : ext
  return `${AVATAR_KEY_PREFIX}${avatarUserSegment(uid)}/${crypto.randomUUID()}.${safeExt}`
}

export function isStoredAvatarKey(value: string): boolean {
  return AVATAR_KEY_RE.test(value)
}

export function isOwnedAvatarKey(key: string, uid: string): boolean {
  if (!isStoredAvatarKey(key)) return false
  return key.startsWith(`${AVATAR_KEY_PREFIX}${avatarUserSegment(uid)}/`)
}

export function publicAvatarUrl(updatedAt?: string | null): string {
  const v = updatedAt ? encodeURIComponent(updatedAt) : String(Date.now())
  return `/api/profile/avatar?v=${v}`
}

export function toClientAvatar(stored: string | null | undefined, updatedAt?: string | null): string {
  if (!stored) return ''
  if (isStoredAvatarKey(stored)) return publicAvatarUrl(updatedAt)
  // 兼容替换前已保存的外部 URL；拒绝 javascript: / data: 等
  if (/^https:\/\//i.test(stored) || /^http:\/\/localhost\b/i.test(stored)) return stored
  return ''
}

export function requestLooksTooLarge(contentLengthHeader: string | undefined): boolean {
  if (!contentLengthHeader) return false
  const len = Number(contentLengthHeader)
  if (!Number.isFinite(len) || len < 0) return false
  // multipart 会有少量边界开销，请求上限略大于文件上限
  return len > AVATAR_MAX_BYTES + 64 * 1024
}
