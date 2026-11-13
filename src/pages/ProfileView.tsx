import { useEffect, useRef, useState } from 'react'
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

const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif'
const MAX_BYTES = 5 * 1024 * 1024

export default function ProfileView() {
  const [profile, setProfile] = useState<Profile>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [uploadOk, setUploadOk] = useState(false)
  const [localPreview, setLocalPreview] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api.profile().then((p) => setProfile({ ...EMPTY, ...p }))
  }, [])

  useEffect(() => {
    return () => {
      if (localPreview) URL.revokeObjectURL(localPreview)
    }
  }, [localPreview])

  const set = (k: keyof Profile, v: string) => {
    setProfile((prev) => ({ ...prev, [k]: v }))
    setSaved(false)
  }

  const save = async () => {
    setSaving(true)
    setSaveError('')
    setSaved(false)
    try {
      await api.saveProfile(profile)
      setSaved(true)
      // 侧栏优先显示昵称，资料保存后通知 App 立即刷新
      window.dispatchEvent(new Event('app:profile-updated'))
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const onPickFile = async (file: File | undefined) => {
    setUploadError('')
    setUploadOk(false)
    if (!file) return
    if (file.size > MAX_BYTES) {
      setUploadError('文件过大，最大 5MB')
      return
    }
    if (file.type && !ACCEPT.split(',').includes(file.type) && file.type !== 'image/jpg') {
      setUploadError('仅支持 JPG、PNG、WebP、GIF 图片')
      return
    }
    if (localPreview) URL.revokeObjectURL(localPreview)
    const preview = URL.createObjectURL(file)
    setLocalPreview(preview)
    setUploading(true)
    try {
      const res = await api.uploadAvatar(file)
      setProfile((prev) => ({ ...prev, avatar: res.avatar }))
      setUploadOk(true)
      URL.revokeObjectURL(preview)
      setLocalPreview('')
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : '上传失败')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const field = (k: keyof Profile, label: string, placeholder: string) => (
    <div>
      <label className="mb-1 block text-sm text-muted-foreground">{label}</label>
      <Input value={profile[k]} onChange={(e) => set(k, e.target.value)} placeholder={placeholder} />
    </div>
  )

  const displaySrc = localPreview || profile.avatar

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
            {displaySrc ? (
              <img src={displaySrc} alt="头像" className="h-full w-full object-cover" />
            ) : (
              <span className="flex h-full items-center justify-center text-2xl text-muted-foreground">
                {profile.nickname?.slice(0, 1) || '?'}
              </span>
            )}
          </div>
          <div className="flex-1">
            {field('nickname', '昵称', '你的昵称')}
            <div className="mt-3">
              <p className="mb-1 text-sm text-muted-foreground">头像</p>
              <input
                ref={fileRef}
                type="file"
                accept={ACCEPT}
                className="sr-only"
                disabled={uploading}
                onChange={(e) => void onPickFile(e.target.files?.[0])}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={uploading}
                onClick={() => fileRef.current?.click()}
              >
                {uploading ? '上传中…' : '上传图片'}
              </Button>
              <p className="mt-1 text-sm text-muted-foreground">支持 JPG、PNG、WebP、GIF，最大 5MB。</p>
              {uploadOk && <p className="mt-1 text-sm text-muted-foreground">头像已更新</p>}
              {uploadError && <p className="mt-1 text-sm text-destructive">{uploadError}</p>}
            </div>
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
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">登录邮箱</label>
            <Input value={profile.email} readOnly placeholder="you@example.com" className="bg-muted" />
          </div>
          {field('phone', '电话', '…')}
          {field('location', '所在地', '…')}
          {field('website', '个人主页', 'https://…')}
        </div>

        {saveError && <p className="text-sm text-destructive">{saveError}</p>}

        <div className="flex justify-end">
          <Button onClick={() => void save()} disabled={saving || uploading}>{saving ? '保存中…' : '保存'}</Button>
        </div>
      </div>
    </div>
  )
}
