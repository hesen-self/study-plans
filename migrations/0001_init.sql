-- 学习提升系统 D1 初始表结构
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,           -- ai-general | java-ai | frontend | cs-basic
  level INTEGER DEFAULT 1,        -- 1入门 2进阶 3高级
  status TEXT DEFAULT 'todo',     -- todo | learning | done
  progress INTEGER DEFAULT 0,     -- 0-100
  tags TEXT,                      -- JSON array
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  type TEXT DEFAULT 'related'     -- prerequisite前置 | related相关 | extend扩展
);

CREATE TABLE IF NOT EXISTS roadmaps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS roadmap_steps (
  roadmap_id TEXT NOT NULL REFERENCES roadmaps(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  PRIMARY KEY (roadmap_id, node_id)
);

CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  date TEXT NOT NULL,             -- '2026-11-12'
  minutes INTEGER NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  kind TEXT DEFAULT 'doc'         -- doc | video | repo | article
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
CREATE INDEX IF NOT EXISTS idx_checkins_date ON checkins(date);
CREATE INDEX IF NOT EXISTS idx_checkins_node ON checkins(node_id);
CREATE INDEX IF NOT EXISTS idx_resources_node ON resources(node_id);
