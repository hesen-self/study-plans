-- 多用户隔离：所有业务表加 user_id 列
-- 存量数据统一归给默认管理员 'default'
-- 注意：D1 不支持 ALTER TABLE ADD COLUMN IF NOT EXISTS，需确保只在 0001 基础上执行一次

ALTER TABLE nodes ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE edges ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE roadmaps ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE roadmap_steps ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE checkins ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE resources ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS idx_nodes_user ON nodes(user_id);
CREATE INDEX IF NOT EXISTS idx_edges_user ON edges(user_id);
CREATE INDEX IF NOT EXISTS idx_roadmaps_user ON roadmaps(user_id);
CREATE INDEX IF NOT EXISTS idx_roadmap_steps_user ON roadmap_steps(user_id);
CREATE INDEX IF NOT EXISTS idx_checkins_user ON checkins(user_id);
CREATE INDEX IF NOT EXISTS idx_resources_user ON resources(user_id);
