import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeGraphDraft } from '../worker/agent.ts'

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
