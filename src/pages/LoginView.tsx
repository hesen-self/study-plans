import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'

const COUNTDOWN = 60

export default function LoginView({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sending, setSending] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [hint, setHint] = useState('')
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current)
    }
  }, [])

  const startCountdown = () => {
    setCountdown(COUNTDOWN)
    if (timerRef.current) window.clearInterval(timerRef.current)
    timerRef.current = window.setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          if (timerRef.current) window.clearInterval(timerRef.current)
          return 0
        }
        return prev - 1
      })
    }, 1000)
  }

  const sendCode = async () => {
    setError('')
    if (!email.trim()) {
      setError('请输入邮箱地址')
      return
    }
    setSending(true)
    try {
      const r = await fetch('/api/auth/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      })
      const data = (await r.json()) as { ok?: boolean; error?: string }
      if (!data.ok) {
        setError(data.error || '发送失败')
      } else {
        setHint('验证码已发送至你的邮箱，10 分钟内有效')
        startCountdown()
      }
    } catch {
      setError('发送失败，请稍后再试')
    } finally {
      setSending(false)
    }
  }

  const verify = async () => {
    setError('')
    if (!email.trim() || !code.trim()) {
      setError('请输入邮箱和验证码')
      return
    }
    setLoading(true)
    try {
      const r = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), code: code.trim() }),
      })
      const data = (await r.json()) as { ok?: boolean; error?: string }
      if (!data.ok) {
        setError(data.error || '登录失败')
      } else {
        onLogin()
      }
    } catch {
      setError('登录失败，请稍后再试')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-8 shadow-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-xl font-semibold text-primary-foreground">
            学
          </div>
          <h1 className="text-xl font-semibold tracking-tight">学习提升系统</h1>
          <p className="mt-1 text-sm text-muted-foreground">私人学习知识图谱 · 请登录</p>
        </div>

        <div className="space-y-3">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="邮箱地址"
            className="h-10 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus:border-primary"
          />
          <div className="flex gap-2">
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="验证码"
              maxLength={6}
              className="h-10 min-w-0 flex-1 rounded-md border border-input bg-transparent px-3 text-sm outline-none focus:border-primary"
            />
            <Button type="button" variant="outline" onClick={sendCode} disabled={sending || countdown > 0} className="shrink-0">
              {countdown > 0 ? `${countdown}s` : sending ? '发送中…' : '发送验证码'}
            </Button>
          </div>

          {(hint || error) && (
            <p className={`text-xs ${error ? 'text-destructive' : 'text-muted-foreground'}`}>{error || hint}</p>
          )}

          <Button className="w-full" onClick={verify} disabled={loading}>
            {loading ? '登录中…' : '登录'}
          </Button>
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">登录即代表你同意仅用于个人学习用途</p>
      </div>
    </div>
  )
}
