import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseLessonPayload } from '../worker/agent.ts'

describe('parseLessonPayload', () => {
  it('解析标记格式（当前 prompt）', () => {
    const raw = `【标题】HTTP 基础\n【正文】## 概念\n\n请求与响应。\n【代码】curl -I https://example.com`
    const parsed = parseLessonPayload(raw, 'HTTP')
    assert.ok(parsed)
    assert.equal(parsed!.title, 'HTTP 基础')
    assert.match(parsed!.content, /请求与响应/)
    assert.match(parsed!.code, /curl/)
  })

  it('解析合法 JSON', () => {
    const raw = `{"title":"缓存","content":"先读再写","code":"redis.get"}`
    const parsed = parseLessonPayload(raw, '缓存')
    assert.ok(parsed)
    assert.equal(parsed!.title, '缓存')
    assert.equal(parsed!.content, '先读再写')
    assert.equal(parsed!.code, 'redis.get')
  })

  it('兜底：content 含裸换行的非法 JSON', () => {
    const raw = `{"title":"图","content":"第一行
第二行","code":""}`
    const parsed = parseLessonPayload(raw, '图')
    assert.ok(parsed)
    assert.equal(parsed!.title, '图')
    assert.match(parsed!.content, /第一行/)
    assert.match(parsed!.content, /第二行/)
  })

  it('无正文时返回 null', () => {
    assert.equal(parseLessonPayload('{"title":"x"}', 'x'), null)
    assert.equal(parseLessonPayload('【标题】空\n【正文】\n【代码】', '空'), null)
  })
})
