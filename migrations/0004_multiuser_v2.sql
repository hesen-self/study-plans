-- 多用户隔离 v2：去除 id 前缀拼接，改为纯 user_id 字段隔离
-- 同时移除所有外键约束（D1 运行时 foreign_keys 默认 OFF，外键从未真正级联，
-- 依赖应用层显式级联删除；外键反而阻碍主键改为复合主键）
-- 顺序：先重建「引用表」去掉外键 → 再重建「被引用表」改复合主键

-- ============ 1) edges（去掉 REFERENCES nodes）============
CREATE TABLE edges_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL DEFAULT 'default',
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  type TEXT DEFAULT 'related'
);
INSERT INTO edges_new (id, user_id, source, target, type)
SELECT id, user_id,
  CASE WHEN instr(source, ':') > 0 THEN substr(source, instr(source, ':') + 1) ELSE source END,
  CASE WHEN instr(target, ':') > 0 THEN substr(target, instr(target, ':') + 1) ELSE target END,
  type
FROM edges;
DROP TABLE edges;
ALTER TABLE edges_new RENAME TO edges;
CREATE INDEX IF NOT EXISTS idx_edges_user ON edges(user_id);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);

-- ============ 2) checkins（去掉 REFERENCES nodes）============
CREATE TABLE checkins_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL DEFAULT 'default',
  node_id TEXT NOT NULL,
  date TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  note TEXT
);
INSERT INTO checkins_new (id, user_id, node_id, date, minutes, note)
SELECT id, user_id,
  CASE WHEN instr(node_id, ':') > 0 THEN substr(node_id, instr(node_id, ':') + 1) ELSE node_id END,
  date, minutes, note
FROM checkins;
DROP TABLE checkins;
ALTER TABLE checkins_new RENAME TO checkins;
CREATE INDEX IF NOT EXISTS idx_checkins_user ON checkins(user_id);
CREATE INDEX IF NOT EXISTS idx_checkins_date ON checkins(date);
CREATE INDEX IF NOT EXISTS idx_checkins_node ON checkins(node_id);

-- ============ 3) resources（去掉 REFERENCES nodes）============
CREATE TABLE resources_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL DEFAULT 'default',
  node_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  kind TEXT DEFAULT 'doc'
);
INSERT INTO resources_new (id, user_id, node_id, title, url, kind)
SELECT id, user_id,
  CASE WHEN instr(node_id, ':') > 0 THEN substr(node_id, instr(node_id, ':') + 1) ELSE node_id END,
  title, url, kind
FROM resources;
DROP TABLE resources;
ALTER TABLE resources_new RENAME TO resources;
CREATE INDEX IF NOT EXISTS idx_resources_user ON resources(user_id);
CREATE INDEX IF NOT EXISTS idx_resources_node ON resources(node_id);

-- ============ 4) roadmap_steps（去掉 REFERENCES nodes/roadmaps）============
CREATE TABLE roadmap_steps_new (
  roadmap_id TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT 'default',
  node_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (roadmap_id, user_id, node_id)
);
INSERT INTO roadmap_steps_new (roadmap_id, user_id, node_id, seq)
SELECT roadmap_id, user_id,
  CASE WHEN instr(node_id, ':') > 0 THEN substr(node_id, instr(node_id, ':') + 1) ELSE node_id END,
  seq
FROM roadmap_steps;
DROP TABLE roadmap_steps;
ALTER TABLE roadmap_steps_new RENAME TO roadmap_steps;
CREATE INDEX IF NOT EXISTS idx_roadmap_steps_user ON roadmap_steps(user_id);

-- ============ 5) nodes（复合主键 user_id + id）============
CREATE TABLE nodes_new (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  level INTEGER DEFAULT 1,
  status TEXT DEFAULT 'todo',
  progress INTEGER DEFAULT 0,
  tags TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, id)
);
INSERT INTO nodes_new (id, user_id, name, domain, level, status, progress, tags, created_at)
SELECT
  CASE WHEN instr(id, ':') > 0 THEN substr(id, instr(id, ':') + 1) ELSE id END,
  user_id, name, domain, level, status, progress, tags, created_at
FROM nodes;
DROP TABLE nodes;
ALTER TABLE nodes_new RENAME TO nodes;
CREATE INDEX IF NOT EXISTS idx_nodes_user ON nodes(user_id);

-- ============ 6) roadmaps（复合主键 user_id + id）============
CREATE TABLE roadmaps_new (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  description TEXT,
  PRIMARY KEY (user_id, id)
);
INSERT INTO roadmaps_new (id, user_id, name, description)
SELECT id, user_id, name, description FROM roadmaps;
DROP TABLE roadmaps;
ALTER TABLE roadmaps_new RENAME TO roadmaps;
CREATE INDEX IF NOT EXISTS idx_roadmaps_user ON roadmaps(user_id);
