// 应用层自建认证：邮箱验证码登录 + GitHub OAuth 登录
// session 存 KV（auth:session:{token} → { email }），httpOnly cookie 下发
// 邮箱验证码存 KV（auth:code:{email} → { code, expires_at, attempts }），网易 SMTP 发送
import { WorkerMailer } from 'worker-mailer'

export type AuthEnv = {
  STATS_KV: KVNamespace
  SMTP_HOST?: string
  SMTP_PORT?: string
  SMTP_USER?: string
  SMTP_PASS?: string
  SMTP_FROM_NAME?: string
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
}

const SESSION_TTL = 60 * 60 * 24 * 7 // 7 天
const CODE_TTL = 60 * 10 // 验证码 10 分钟有效
const CODE_MAX_ATTEMPTS = 5 // 最多尝试 5 次
const SEND_INTERVAL = 60 // 同一邮箱 60 秒内不重复发送

export const COOKIE_NAME = 'sp_session'

// ============ session ============
export async function createSession(env: AuthEnv, email: string): Promise<string> {
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
  await env.STATS_KV.put(
    `auth:session:${token}`,
    JSON.stringify({ email, created_at: Date.now() }),
    { expirationTtl: SESSION_TTL }
  )
  return token
}

export async function getSessionEmail(env: AuthEnv, token: string | undefined): Promise<string | null> {
  if (!token) return null
  const raw = await env.STATS_KV.get(`auth:session:${token}`)
  if (!raw) return null
  try {
    const data = JSON.parse(raw) as { email: string }
    return data.email || null
  } catch {
    return null
  }
}

export async function destroySession(env: AuthEnv, token: string | undefined): Promise<void> {
  if (!token) return
  await env.STATS_KV.delete(`auth:session:${token}`)
}

export function sessionCookie(token: string): string {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL}`
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

// ============ 邮箱验证码 ============
function codeKey(email: string): string {
  return `auth:code:${email.toLowerCase()}`
}
function sendMarkKey(email: string): string {
  return `auth:sent:${email.toLowerCase()}`
}

function generateCode(): string {
  const arr = new Uint8Array(6)
  crypto.getRandomValues(arr)
  let code = ''
  for (let i = 0; i < 6; i++) code += String(arr[i] % 10)
  return code
}

/** 发送登录验证码邮件。返回 null 表示成功，否则返回错误信息 */
export async function sendLoginCode(env: AuthEnv, email: string): Promise<string | null> {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) {
    return '邮件服务未配置，请联系管理员'
  }

  // 发送频率限制（防轰炸）
  const lastSent = await env.STATS_KV.get(sendMarkKey(email))
  if (lastSent && Date.now() - Number(lastSent) < SEND_INTERVAL * 1000) {
    return '发送过于频繁，请稍后再试'
  }

  const code = generateCode()
  const fromName = env.SMTP_FROM_NAME || '学习小助手'
  const host = env.SMTP_HOST
  const port = Number(env.SMTP_PORT || '465')

  const html = `<!doctype html>
<html><body style="font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;background:#f7f6f2;padding:32px 16px;">
<div style="max-width:420px;margin:0 auto;background:#fff;border:1px solid #eee;border-radius:16px;padding:36px;text-align:center;">
  <div style="font-size:20px;font-weight:600;color:#1c1b18;margin-bottom:8px;">学习提升系统</div>
  <div style="font-size:13px;color:#999;margin-bottom:24px;">你的登录验证码</div>
  <div style="font-size:32px;font-weight:700;letter-spacing:8px;color:#185fa5;padding:12px 0;">${code}</div>
  <div style="font-size:12px;color:#bbb;margin-top:20px;">验证码 10 分钟内有效，请勿泄露给他人</div>
</div>
</body></html>`

  try {
    await WorkerMailer.send(
      {
        host,
        port,
        secure: true, // 465 SSL 隐式 TLS
        credentials: { username: env.SMTP_USER, password: env.SMTP_PASS },
        authType: 'plain',
      },
      {
        from: { name: fromName, email: env.SMTP_USER },
        to: { email },
        subject: '【学习提升系统】登录验证码',
        html,
        text: `你的登录验证码是：${code}（10 分钟内有效）`,
      }
    )
  } catch (e) {
    console.error('sendLoginCode SMTP failed', e)
    return '验证码发送失败，请稍后再试'
  }

  await env.STATS_KV.put(
    codeKey(email),
    JSON.stringify({ code, expires_at: Date.now() + CODE_TTL * 1000, attempts: 0 }),
    { expirationTtl: CODE_TTL }
  )
  await env.STATS_KV.put(sendMarkKey(email), String(Date.now()), { expirationTtl: SEND_INTERVAL })

  return null
}

/** 校验验证码。成功返回 null，失败返回错误信息 */
export async function verifyLoginCode(env: AuthEnv, email: string, code: string): Promise<string | null> {
  const raw = await env.STATS_KV.get(codeKey(email))
  if (!raw) return '验证码已过期或未发送'
  let data: { code: string; expires_at: number; attempts: number }
  try {
    data = JSON.parse(raw) as { code: string; expires_at: number; attempts: number }
  } catch {
    return '验证码已过期或未发送'
  }

  if (Date.now() > data.expires_at) {
    await env.STATS_KV.delete(codeKey(email))
    return '验证码已过期，请重新获取'
  }

  if (data.attempts >= CODE_MAX_ATTEMPTS) {
    await env.STATS_KV.delete(codeKey(email))
    return '尝试次数过多，请重新获取验证码'
  }

  if (data.code !== String(code).trim()) {
    data.attempts++
    await env.STATS_KV.put(codeKey(email), JSON.stringify(data), { expirationTtl: CODE_TTL })
    return '验证码错误'
  }

  // 校验成功，删除验证码
  await env.STATS_KV.delete(codeKey(email))
  await env.STATS_KV.delete(sendMarkKey(email))
  return null
}

// ============ GitHub OAuth ============
const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize'
const GITHUB_ACCESS_TOKEN = 'https://github.com/login/oauth/access_token'
const GITHUB_USER = 'https://api.github.com/user'

/** 生成 GitHub OAuth 跳转地址 */
export function githubAuthorizeUrl(env: AuthEnv, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID || '',
    redirect_uri: redirectUri,
    scope: 'read:user user:email',
    state,
  })
  return `${GITHUB_AUTHORIZE}?${params.toString()}`
}

/** 用 code 换取 access_token */
async function exchangeCode(env: AuthEnv, code: string, redirectUri: string): Promise<string | null> {
  const res = await fetch(GITHUB_ACCESS_TOKEN, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  })
  if (!res.ok) return null
  const data = (await res.json()) as { access_token?: string; error?: string }
  return data.access_token || null
}

/** 用 access_token 获取用户主邮箱 */
async function fetchGithubEmail(accessToken: string): Promise<string | null> {
  const res = await fetch(GITHUB_USER, {
    headers: { Authorization: `token ${accessToken}`, Accept: 'application/json' },
  })
  if (!res.ok) return null
  const user = (await res.json()) as { email?: string | null }
  if (user.email) return user.email

  // 主邮箱可能为空，回退到 emails 接口取 primary 邮箱
  const emailsRes = await fetch('https://api.github.com/user/emails', {
    headers: { Authorization: `token ${accessToken}`, Accept: 'application/json' },
  })
  if (!emailsRes.ok) return null
  const emails = (await emailsRes.json()) as { email: string; primary: boolean; verified: boolean }[]
  const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified)
  return primary?.email ?? null
}

/** 完整 GitHub OAuth 回调处理：code → token → email。返回 email 或 null */
export async function githubLogin(env: AuthEnv, code: string, redirectUri: string): Promise<string | null> {
  const accessToken = await exchangeCode(env, code, redirectUri)
  if (!accessToken) return null
  return fetchGithubEmail(accessToken)
}

/** 校验 state（防 CSRF） */
export async function checkOAuthState(env: AuthEnv, state: string): Promise<boolean> {
  const raw = await env.STATS_KV.get(`auth:state:${state}`)
  if (!raw) return false
  await env.STATS_KV.delete(`auth:state:${state}`)
  return true
}

export async function createOAuthState(env: AuthEnv): Promise<string> {
  const state = crypto.randomUUID()
  await env.STATS_KV.put(`auth:state:${state}`, '1', { expirationTtl: 600 })
  return state
}
