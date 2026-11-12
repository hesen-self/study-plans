-- 知识库教材存储表：根据知识图谱逐节点联网查询并总结生成的教材
CREATE TABLE IF NOT EXISTS knowledge_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL DEFAULT 'default',
  node_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,                    -- 教材正文（markdown）
  code TEXT,                       -- 技术类 demo 关键代码（可空）
  source_urls TEXT,                -- JSON array，联网搜索来源 URL
  domain TEXT,                     -- 节点领域，便于前端分组
  seq INTEGER DEFAULT 0,           -- 章节顺序（拓扑序）
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_user ON knowledge_docs(user_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_user_node ON knowledge_docs(user_id, node_id);
