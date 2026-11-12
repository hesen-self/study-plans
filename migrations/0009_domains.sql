-- 领域管理：领域清单从硬编码枚举迁移为可配置数据表
-- 领域采用「学科粗分 + 标签二级细分」模型，8 类起始
CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,              -- 领域唯一标识，如 'ai-ml'
  name TEXT NOT NULL,               -- 中文名，如 'AI / 机器学习'
  color TEXT NOT NULL,              -- 图例/节点颜色
  sort INTEGER DEFAULT 0,           -- 排序权重，越小越靠前
  created_at TEXT DEFAULT (datetime('now', '+8 hours'))
);

-- 初始 8 类领域
INSERT OR IGNORE INTO domains (id, name, color, sort) VALUES
  ('ai-ml',    'AI / 机器学习', '#7F77DD', 1),
  ('backend',  '后端开发',      '#D85A30', 2),
  ('frontend', '前端开发',      '#378ADD', 3),
  ('data',     '数据与数据库',  '#D4A017', 4),
  ('devops',   '工程与运维',    '#1D9E75', 5),
  ('cs-basic', '计算机基础',    '#17A2B8', 6),
  ('security', '安全',          '#C0392B', 7),
  ('product',  '产品与软技能',  '#7F8C8D', 8);
