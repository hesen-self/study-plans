import { useEffect, useState } from 'react'
import { api, Profile } from '@/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

const EMPTY: Profile = {
  user_id: 'default',
  nickname: '',
  avatar: '',
  bio: '',
  goal: '',
  email: '',
  phone: '',
  location: '',
  website: '',
}

export default function ProfileView() {
  const [profile, setProfile] = useState<Profile>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    api.profile().then((p) => setProfile({ ...EMPTY, ...p }))
  }, [])

  const set = (k: keyof Profile, v: string) => {
    setProfile((prev) => ({ ...prev, [k]: v }))
    setSaved(false)
  }

  const save = async () => {
    setSaving(true)
    await api.saveProfile(profile)
    setSaving(false)
    setSaved(true)
  }

  const field = (k: keyof Profile, label: string, placeholder: string) => (
    <div>
      <label className="mb-1 block text-sm text-muted-foreground">{label}</label>
      <Input value={profile[k]} onChange={(e) => set(k, e.target.value)} placeholder={placeholder} />
    </div>
  )

  return (
    <div className="mx-auto max-w-2xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">个人资料</h1>
        {saved && <span className="text-sm text-muted-foreground">已保存</span>}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">维护你的个人信息，随学习记录一起沉淀。</p>

      <div className="mt-6 space-y-5 rounded-lg border border-border bg-card p-6">
        <div className="flex items-center gap-4">
          <div className="h-20 w-20 shrink-0 overflow-hidden rounded-full border border-border bg-secondary">
            {profile.avatar ? (
              <img src={profile.avatar} alt="头像" className="h-full w-full object-cover" />
            ) : (
              <span className="flex h-full items-center justify-center text-2xl text-muted-foreground">
                {profile.nickname?.slice(0, 1) || '?'}
              </span>
            )}
          </div>
          <div className="flex-1">
            {field('nickname', '昵称', '你的昵称')}
            <div className="mt-3">{field('avatar', '头像 URL', 'https://…')}</div>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-sm text-muted-foreground">简介</label>
          <Textarea
            value={profile.bio}
            onChange={(e) => set('bio', e.target.value)}
            placeholder="一句话介绍自己…"
            className="min-h-[70px]"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm text-muted-foreground">目标 / 座右铭</label>
          <Textarea
            value={profile.goal}
            onChange={(e) => set('goal', e.target.value)}
            placeholder="当前学习目标或座右铭…"
            className="min-h-[70px]"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          {field('email', '邮箱', 'you@example.com')}
          {field('phone', '电话', '…')}
          {field('location', '所在地', '…')}
          {field('website', '个人主页', 'https://…')}
        </div>

        <div className="flex justify-end">
          <Button onClick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
        </div>
      </div>
    </div>
  )
}
