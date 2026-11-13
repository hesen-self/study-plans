import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyDraftOps,
  draftToRoadmapSteps,
  isTechDomain,
  previewDraftConflicts,
  sanitizeGraphDraft,
  suggestLinksToExisting,
} from '../worker/agent.ts'

test('id 与已有节点冲突时重命名，并同步 remap 边的端点', () => {
  const d = sanitizeGraphDraft({
    nodes: [
      { id: 'java', name: 'Java 基础', domain: 'backend', level: 1, tags: ['java'] },
      { id: 'spring', name: 'Spring', domain: 'backend', level: 2, tags: [] },
    ],
    edges: [{ source: 'java', target: 'spring', type: 'prerequisite' }],
  }, new Set(['java']))
  assert.equal(d.nodes[0].id, 'java-2')
  assert.equal(d.nodes[1].id, 'spring')
  assert.deepEqual(d.edges, [{ source: 'java-2', target: 'spring', type: 'prerequisite' }])
})

test('串联清洗保持幂等：不会反复追加后缀，也不会丢边', () => {
  const raw = {
    nodes: [
      { id: 'java', name: 'Java 基础', domain: 'backend', level: 1, tags: [] },
      { id: 'spring', name: 'Spring', domain: 'backend', level: 2, tags: [] },
    ],
    edges: [{ source: 'java', target: 'spring', type: 'prerequisite' }],
  }
  const first = sanitizeGraphDraft(raw, new Set(['java']))
  const second = sanitizeGraphDraft(first, new Set(['java']))
  assert.deepEqual(second, first)
  assert.equal(second.nodes[0].id, 'java-2')
  assert.equal(second.edges.length, 1)
})

test('过滤自环、orphan edge、重复边，并约束领域/难度/标签', () => {
  const d = sanitizeGraphDraft({
    nodes: [
      { id: 'a', name: 'A', domain: 'not-exist', level: 9, tags: 'oops' },
      { id: 'b', name: 'B', domain: 'ai-ml', level: 3, tags: [] },
    ],
    edges: [
      { source: 'a', target: 'a', type: 'prerequisite' },
      { source: 'a', target: 'ghost', type: 'related' },
      { source: 'a', target: 'b', type: 'bad-type' },
      { source: 'a', target: 'b', type: 'related' },
    ],
  })
  assert.equal(d.nodes[0].domain, 'cs-basic')
  assert.equal(d.nodes[0].level, 1)
  assert.deepEqual(d.nodes[0].tags, [])
  assert.deepEqual(d.edges, [{ source: 'a', target: 'b', type: 'related' }])
})

test('自定义领域白名单：不在清单内的落到 fallback', () => {
  const d = sanitizeGraphDraft(
    {
      nodes: [
        { id: 'a', name: 'A', domain: 'my-domain', level: 1, tags: [] },
        { id: 'b', name: 'B', domain: 'backend', level: 1, tags: [] },
      ],
      edges: [],
    },
    new Set(),
    ['my-domain', 'backend'],
    'backend'
  )
  assert.equal(d.nodes[0].domain, 'my-domain')
  assert.equal(d.nodes[1].domain, 'backend')
})

test('边端点不引用已有节点 id（与前端预览口径一致）', () => {
  const d = sanitizeGraphDraft({
    nodes: [{ id: 'a', name: 'A', domain: 'backend', level: 1, tags: [] }],
    edges: [{ source: 'existing', target: 'a', type: 'related' }],
  }, new Set(['existing']))
  assert.deepEqual(d.edges, [])
})

test('LLM 输出重复 id 时，第二个节点改用名称生成独立 id', () => {
  const d = sanitizeGraphDraft({
    nodes: [
      { id: 'dup', name: '甲', domain: 'backend', level: 1, tags: [] },
      { id: 'dup', name: '乙', domain: 'backend', level: 1, tags: [] },
    ],
    edges: [],
  })
  assert.equal(d.nodes.length, 2)
  assert.notEqual(d.nodes[0].id, d.nodes[1].id)
})

test('规模上限：节点与边按上限截断', () => {
  const nodes = Array.from({ length: 80 }, (_, i) => ({
    id: `n${i}`, name: `节点${i}`, domain: 'backend', level: 1, tags: [],
  }))
  const d = sanitizeGraphDraft({ nodes, edges: [] })
  assert.equal(d.nodes.length, 30)
})

test('isTechDomain：product 非技术，backend/ai-ml 为技术', () => {
  assert.equal(isTechDomain('product'), false)
  assert.equal(isTechDomain('backend'), true)
  assert.equal(isTechDomain('ai-ml'), true)
  assert.equal(isTechDomain('custom-x'), true)
})

test('applyDraftOps：增删改节点与边', () => {
  const base = sanitizeGraphDraft({
    nodes: [
      { id: 'a', name: 'A', domain: 'backend', level: 1, tags: [] },
      { id: 'b', name: 'B', domain: 'backend', level: 1, tags: [] },
    ],
    edges: [{ source: 'a', target: 'b', type: 'prerequisite' }],
  })
  const next = applyDraftOps(base, [
    { op: 'update_node', id: 'a', patch: { name: 'A2', level: 2 } },
    { op: 'add_node', node: { id: 'c', name: 'C', domain: 'ai-ml', level: 1, tags: [] } },
    { op: 'add_edge', edge: { source: 'b', target: 'c', type: 'extend' } },
    { op: 'remove_edge', source: 'a', target: 'b' },
  ])
  assert.equal(next.nodes.find((n) => n.id === 'a')?.name, 'A2')
  assert.equal(next.nodes.find((n) => n.id === 'a')?.level, 2)
  assert.ok(next.nodes.some((n) => n.id === 'c'))
  assert.equal(next.edges.length, 1)
  assert.deepEqual(next.edges[0], { source: 'b', target: 'c', type: 'extend' })
})

test('suggestLinksToExisting：名称相近时生成 related 边', () => {
  const draft = sanitizeGraphDraft({
    nodes: [{ id: 'spring-boot', name: 'Spring Boot', domain: 'backend', level: 2, tags: [] }],
    edges: [],
  })
  const links = suggestLinksToExisting(draft, [
    { id: 'spring', name: 'Spring' },
    { id: 'react', name: 'React' },
  ])
  assert.ok(links.some((e) => e.source === 'spring' && e.target === 'spring-boot' && e.type === 'related'))
})

test('previewDraftConflicts：检测名称相似', () => {
  const draft = sanitizeGraphDraft({
    nodes: [{ id: 'java-basic', name: 'Java 基础', domain: 'backend', level: 1, tags: [] }],
    edges: [],
  })
  const c = previewDraftConflicts(draft, [{ id: 'java', name: 'Java基础' }], [])
  assert.equal(c.willCreate.length, 1)
  assert.ok(c.nameSimilar.length >= 1)
})

test('draftToRoadmapSteps：按 prerequisite 拓扑排序', () => {
  const draft = sanitizeGraphDraft({
    nodes: [
      { id: 'a', name: 'A', domain: 'backend', level: 1, tags: [] },
      { id: 'b', name: 'B', domain: 'backend', level: 1, tags: [] },
      { id: 'c', name: 'C', domain: 'backend', level: 1, tags: [] },
    ],
    edges: [
      { source: 'a', target: 'b', type: 'prerequisite' },
      { source: 'b', target: 'c', type: 'prerequisite' },
      { source: 'a', target: 'c', type: 'related' },
    ],
  })
  const steps = draftToRoadmapSteps(draft)
  assert.deepEqual(steps.map((s) => s.node_id), ['a', 'b', 'c'])
  assert.deepEqual(steps.map((s) => s.seq), [1, 2, 3])
})

test('评测样例：合法草稿应有节点、合法领域、无 orphan、含 prerequisite 链', () => {
  const samples = [
    {
      nodes: [
        { id: 'llm', name: '大模型基础', domain: 'ai-ml', level: 1, tags: ['llm'] },
        { id: 'prompt', name: 'Prompt 工程', domain: 'ai-ml', level: 2, tags: [] },
        { id: 'rag', name: 'RAG', domain: 'ai-ml', level: 2, tags: [] },
      ],
      edges: [
        { source: 'llm', target: 'prompt', type: 'prerequisite' },
        { source: 'prompt', target: 'rag', type: 'prerequisite' },
      ],
    },
    {
      nodes: [
        { id: 'java', name: 'Java', domain: 'backend', level: 1, tags: [] },
        { id: 'spring', name: 'Spring', domain: 'backend', level: 2, tags: [] },
      ],
      edges: [{ source: 'java', target: 'spring', type: 'prerequisite' }],
    },
  ]
  const allowed = ['ai-ml', 'backend', 'frontend', 'data', 'devops', 'cs-basic', 'security', 'product']
  for (const raw of samples) {
    const d = sanitizeGraphDraft(raw, new Set(), allowed)
    assert.ok(d.nodes.length >= 2)
    assert.ok(d.nodes.every((n) => allowed.includes(n.domain)))
    const ids = new Set(d.nodes.map((n) => n.id))
    assert.ok(d.edges.every((e) => ids.has(e.source) && ids.has(e.target)))
    assert.ok(d.edges.some((e) => e.type === 'prerequisite'))
  }
})
