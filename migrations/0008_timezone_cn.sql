-- 时间存储时区切换：UTC → 北京时间（UTC+8）
-- 背景：SQLite datetime('now') 返回 UTC；D1 宿主环境时区为 UTC，
--       'localtime' 修饰符无效，必须用 '+8 hours' 硬偏移。
-- 内容：
--   1) 存量时间数据统一 +8 小时（本迁移只执行一次，不会重复偏移）
--   2) SQLite 无法修改列默认值，重建 nodes / knowledge_docs / users 三张
--      带 datetime 默认值的表，默认值改为 datetime('now', '+8 hours')
-- 注意：updated_at 在 SQL 语句中显式赋值（worker/index.ts 已同步改为 +8 hours），
--       此处仅处理 created_at 默认值与存量数据。

-- ============ 1) 存量数据 +8 小时 ============
UPDATE users SET created_at = datetime(created_at, '+8 hours') WHERE created_at IS NOT NULL;
UPDATE users SET updated_at = datetime(updated_at, '+8 hours') WHERE updated_at IS NOT NULL;
UPDATE nodes SET created_at = datetime(created_at, '+8 hours') WHERE created_at IS NOT NULL;
UPDATE knowledge_docs SET created_at = datetime(created_at, '+8 hours') WHERE created_at IS NOT NULL;
UPDATE knowledge_docs SET updated_at = datetime(updated_at, '+8 hours') WHERE updated_at IS NOT NULL;

-- ============ 2) 重建 nodes（默认值为 +8 小时）============
CREATE TABLE nodes_new (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  level INTEGER DEFAULT 1,
  status TEXT DEFAULT 'todo',
  progress INTEGER DEFAULT 0,
  tags TEXT,
  created_at TEXT DEFAULT (datetime('now', '+8 hours')),
  PRIMARY KEY (user_id, id)
);
INSERT INTO nodes_new (id, user_id, name, domain, level, status, progress, tags, created_at)
SELECT id, user_id, name, domain, level, status, progress, tags, created_at
FROM nodes;
DROP TABLE nodes;
ALTER TABLE nodes_new RENAME TO nodes;
CREATE INDEX IF NOT EXISTS idx_nodes_user ON nodes(user_id);

-- ============ 3) 重建 knowledge_docs ============
CREATE TABLE knowledge_docs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL DEFAULT 'default',
  node_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  code TEXT,
  source_urls TEXT,
  domain TEXT,
  seq INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now', '+8 hours')),
  updated_at TEXT DEFAULT (datetime('now', '+8 hours')),
  UNIQUE(user_id, node_id)
);
INSERT INTO knowledge_docs_new (id, user_id, node_id, title, content, code, source_urls, domain, seq, created_at, updated_at)
SELECT id, user_id, node_id, title, content, code, source_urls, domain, seq, created_at, updated_at
FROM knowledge_docs;
DROP TABLE knowledge_docs;
ALTER TABLE knowledge_docs_new RENAME TO knowledge_docs;
CREATE INDEX IF NOT EXISTS idx_knowledge_user ON knowledge_docs(user_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_user_node ON knowledge_docs(user_id, node_id);

-- ============ 4) 重建 users ============
CREATE TABLE users_new (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now', '+8 hours')),
  nickname TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  goal TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  updated_at TEXT
);
INSERT INTO users_new (id, email, created_at, nickname, avatar, bio, goal, phone, location, website, updated_at)
SELECT id, email, created_at, nickname, avatar, bio, goal, phone, location, website, updated_at
FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
