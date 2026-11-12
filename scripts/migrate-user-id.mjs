#!/usr/bin/env node
/**
 * 存量用户数据迁移：把各业务表 user_id 从「邮箱」迁移为「雪花算法生成的唯一 id」。
 *
 * 背景：
 *   用户体系从「user_id = 登录邮箱」切换为「user_id = 雪花算法唯一 id（无符号，字符串）」
 *   ，邮箱独立存入 users.email。本脚本为所有「非 default 的存量邮箱」生成雪花 id、
 *   写入 users 表，并把各业务表的 user_id 回填为雪花 id。
 *
 * 幂等性：可重复运行。已迁移过的邮箱（users 表已存在）会复用已有 id，不会重复创建。
 *
 * 用法：
 *   node scripts/migrate-user-id.mjs            # 迁移线上 D1（读 .cf-token + wrangler.toml）
 *   node scripts/migrate-user-id.mjs --local    # 迁移本地 D1（走 wrangler d1 execute --local）
 *
 * 说明：雪花算法逻辑与 worker/snowflake.ts 保持一致（64 位无符号，BigInt 计算，字符串输出）。
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const LOCAL = process.argv.includes('--local')

// ============ 雪花算法（与 worker/snowflake.ts 一致） ============
const EPOCH = 1700000000000n
const WORKER_ID_BITS = 10n
const SEQUENCE_BITS = 12n
const MAX_WORKER_ID = (1n << WORKER_ID_BITS) - 1n
const MAX_SEQUENCE = (1n << SEQUENCE_BITS) - 1n
let lastTimestamp = -1n
let sequence = 0n

function nextSnowflakeId(workerId = 1) {
  const wid = BigInt(workerId) & MAX_WORKER_ID
  let ts = BigInt(Date.now()) - EPOCH
  if (ts < lastTimestamp) ts = lastTimestamp
  if (ts === lastTimestamp) {
    sequence = (sequence + 1n) & MAX_SEQUENCE
    if (sequence === 0n) {
      while (BigInt(Date.now()) - EPOCH <= lastTimestamp) {
        /* busy wait next ms */
      }
      ts = BigInt(Date.now()) - EPOCH
    }
  } else {
    sequence = 0n
  }
  lastTimestamp = ts
  return ((ts << (WORKER_ID_BITS + SEQUENCE_BITS)) | (wid << SEQUENCE_BITS) | sequence).toString()
}

// ============ D1 查询封装 ============
let query

if (LOCAL) {
  // 本地：走 wrangler d1 execute --local，SQL 通过 stdin 传入
  query = (sql, params = []) => {
    // 简单起见本地也用 JSON 输出；参数少，直接内联转义
    const flat = sql.replace(/\?\??/g, () => {
      const v = params.shift()
      if (v === undefined) return 'NULL'
      return `'${String(v).replace(/'/g, "''")}'`
    })
    const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'study-plans', '--local', '--json', '--command', flat], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    // wrangler --json 输出前可能有告警行，取最后一个 JSON 对象
    const json = out.slice(out.lastIndexOf('{"'))
    try {
      return JSON.parse(json)
    } catch {
      return JSON.parse(out.trim())
    }
  }
} else {
  // 线上：D1 REST API（.cf-token 第 6 行 = API Token，第 7 行 = Account ID）
  const tokenFile = join(ROOT, '.cf-token')
  const lines = readFileSync(tokenFile, 'utf8').split('\n').map((s) => s.trim())
  const API_TOKEN = lines[5]
  const ACCOUNT_ID = lines[6]
  const DB_ID = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8').match(/database_id\s*=\s*"([^"]+)"/)[1]
  query = async (sql, params = []) => {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }),
    })
    const j = await res.json()
    if (!j.success) throw new Error(`D1 查询失败: ${JSON.stringify(j.errors || j)}`)
    return j
  }
}

// ============ 主流程 ============
const TABLES = ['nodes', 'edges', 'roadmaps', 'roadmap_steps', 'checkins', 'resources', 'profile', 'knowledge_docs']

async function main() {
  console.log(`==> ${LOCAL ? '本地' : '线上'} D1：收集存量邮箱（非 default）…`)

  // 1. 确保 users 表存在（幂等；正常情况下已由 0006 迁移创建）
  await query(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now', '+8 hours')))`)
  await query('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)')

  // 2. 收集所有非 default、非空、看起来像邮箱的 user_id
  const emails = new Set()
  for (const t of TABLES) {
    const r = await query(`SELECT DISTINCT user_id FROM ${t}`)
    const rows = r.result?.[0]?.results || r.result || []
    for (const row of rows) {
      const uid = row.user_id
      if (uid && uid !== 'default' && uid.includes('@')) emails.add(uid)
    }
  }

  const list = [...emails]
  console.log(`==> 发现 ${list.length} 个存量邮箱用户：${list.join(', ') || '（无）'}`)
  if (list.length === 0) {
    console.log('    无需迁移。')
    return
  }

  // 3. 为每个邮箱生成雪花 id 并写入 users（已存在则复用）
  const mapping = {} // email -> snowflakeId
  for (const email of list) {
    const exist = await query('SELECT id FROM users WHERE email = ?', [email])
    const existRows = exist.result?.[0]?.results || exist.result || []
    if (existRows.length > 0) {
      mapping[email] = existRows[0].id
      console.log(`   · ${email} 已在 users 表，复用 id=${existRows[0].id}`)
    } else {
      const id = nextSnowflakeId()
      await query('INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)', [id, email])
      const re = await query('SELECT id FROM users WHERE email = ?', [email])
      const reRows = re.result?.[0]?.results || re.result || []
      mapping[email] = reRows[0]?.id || id
      console.log(`   · ${email} 新建 id=${mapping[email]}`)
    }
  }

  // 4. 回填各业务表 user_id
  for (const t of TABLES) {
    for (const email of list) {
      const id = mapping[email]
      const r = await query(`UPDATE ${t} SET user_id = ? WHERE user_id = ?`, [id, email])
      const meta = r.result?.[0]?.meta || r.meta || {}
      const changed = meta.changes || 0
      if (changed > 0) console.log(`   ✓ ${t}: ${email} -> ${id}（${changed} 行）`)
    }
  }

  console.log('==> 迁移完成。')
}

main().catch((e) => {
  console.error('✗ 迁移失败：', e.message || e)
  process.exit(1)
})
