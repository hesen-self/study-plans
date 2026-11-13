-- 收口层 / 学习闭环 / AI 产物治理：一次性补齐三批功能所需表结构
-- 说明：本迁移只执行一次；禁止修改 0001~0009 已执行的迁移文件。

-- ============ 1) 用户元数据：图谱初始化标记 + 打卡目标 ============
-- graph_seeded 用于区分「新用户从未初始化」与「用户主动删空图谱」，
-- 避免 ensureUserGraph 以节点数为 0 为依据反复回填模板图谱。
CREATE TABLE IF NOT EXISTS user_meta (
  user_id TEXT PRIMARY KEY,
  graph_seeded INTEGER NOT NULL DEFAULT 0,
  daily_goal_minutes INTEGER NOT NULL DEFAULT 0,
  weekly_goal_minutes INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now', '+8 hours'))
);

-- 教材人工编辑标记：批处理任务跳过已人工编辑的章节，避免覆盖用户修改
ALTER TABLE knowledge_docs ADD COLUMN is_edited INTEGER NOT NULL DEFAULT 0;

-- ============ 2) 知识库服务端批处理任务 ============
-- 任务与逐节点进度持久化在 D1：关页面不丢状态，超时/失败可断点续跑。
CREATE TABLE IF NOT EXISTS knowledge_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',   -- running | paused | completed | cancelled
  detailed INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  current_node TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now', '+8 hours')),
  updated_at TEXT DEFAULT (datetime('now', '+8 hours'))
);

CREATE TABLE IF NOT EXISTS knowledge_job_items (
  job_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | done | failed | skipped
  error TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (job_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_jobs_user ON knowledge_jobs(user_id, status);
CREATE INDEX IF NOT EXISTS idx_knowledge_job_items_job ON knowledge_job_items(job_id, status);
-- 每个用户最多一个进行中/待续跑任务，防止并发创建重复任务（含部分索引谓词）
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_jobs_one_active
  ON knowledge_jobs(user_id) WHERE status IN ('running', 'paused');

-- ============ 3) 领域清单按用户隔离 ============
-- 共享的 8 类模板归属 'default'；每个用户可新增 / 改名 / 改色 / 删除（覆盖行）。
-- deleted=1 的用户覆盖行表示「该用户隐藏了共享模板」。
DROP TABLE IF EXISTS domains_new;
CREATE TABLE domains_new (
  user_id TEXT NOT NULL DEFAULT 'default',
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  sort INTEGER DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now', '+8 hours')),
  PRIMARY KEY (user_id, id)
);
INSERT INTO domains_new (user_id, id, name, color, sort, created_at)
SELECT 'default', id, name, color, sort, created_at FROM domains;
DROP TABLE domains;
ALTER TABLE domains_new RENAME TO domains;
CREATE INDEX IF NOT EXISTS idx_domains_user ON domains(user_id, sort, id);
