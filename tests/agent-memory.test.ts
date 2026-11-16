import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTurnContext,
  heuristicIntent,
  looksLikeConfirm,
  normalizeSessionMemory,
  selectRelevantEpisodes,
} from '../worker/agent-memory.ts'

test('heuristicIntent：改稿动词 → revise', () => {
  assert.equal(heuristicIntent('再深一点，多加实战'), 'revise')
  assert.equal(heuristicIntent('去掉安全相关节点'), 'revise')
  assert.equal(heuristicIntent('压缩到 6 个核心节点'), 'revise')
})

test('heuristicIntent：咨询问句 → consult', () => {
  assert.equal(heuristicIntent('Spring 是什么？'), 'consult')
  assert.equal(heuristicIntent('这条路径合不合理'), 'consult')
})

test('heuristicIntent：模糊改稿意向不硬判（交给 clarify）', () => {
  assert.equal(heuristicIntent('能不能加点实战？'), null)
  assert.equal(heuristicIntent('要不要考虑加深一点'), null)
})

test('looksLikeConfirm：有 pending 时识别确认语', () => {
  const session = normalizeSessionMemory({
    pendingClarify: { summary: '加深实战', options: ['加深实战节点', '保持现状'], createdAt: 1 },
  })
  assert.equal(looksLikeConfirm('好的', session), true)
  assert.equal(looksLikeConfirm('加深实战节点', session), true)
  assert.equal(looksLikeConfirm('随便问问', session), false)
  assert.equal(looksLikeConfirm('好的', {}), false)
})

test('selectRelevantEpisodes：按主题与节点名打分', () => {
  const eps = [
    { id: '1', kind: 'build', summary: '规划了 Java 后端路线', topic: 'Java', node_ids: ['java'] },
    { id: '2', kind: 'consult', summary: '讲解了缓存', topic: 'Redis', node_ids: ['redis'] },
  ]
  const picked = selectRelevantEpisodes(
    eps,
    '继续完善 Java 学习',
    { nodes: [{ id: 'java', name: 'Java', domain: 'backend', level: 1, tags: [] }], edges: [] },
    3
  )
  assert.equal(picked[0]?.id, '1')
})

test('buildTurnContext：装配记忆块与历史摘录', () => {
  const ctx = buildTurnContext({
    messages: [
      { role: 'user', content: '学 Java' },
      { role: 'assistant', content: '已生成草稿' },
      { role: 'user', content: 'Spring 是什么？' },
    ],
    draft: {
      nodes: [{ id: 'spring', name: 'Spring', domain: 'backend', level: 2, tags: [] }],
      edges: [],
    },
    session: { sessionPreferences: ['偏实战'] },
    profile: {
      preferences: ['只要前置链'],
      avoid: [],
      style: '',
      focus_domains: ['backend'],
      level_bias: 'balanced',
      notes: '',
    },
    goal: '成为后端工程师',
    goalSummary: '',
    episodes: [
      { id: '1', kind: 'build', summary: 'Java 入门图谱', topic: 'Java', node_ids: [] },
    ],
    anchor: null,
  })
  assert.match(ctx.memoryBlock, /偏实战|只要前置链/)
  assert.match(ctx.memoryBlock, /成为后端工程师/)
  assert.equal(ctx.lastUser, 'Spring 是什么？')
  assert.ok(ctx.historyExcerpt.includes('用户'))
})
