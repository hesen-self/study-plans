-- 助手长期工作记忆：L1 用户画像 + L2 情景摘要（不存完整聊天原文）

CREATE TABLE IF NOT EXISTS agent_user_memory (
  user_id TEXT PRIMARY KEY,
  profile_json TEXT NOT NULL DEFAULT '{}',
  goal_summary TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
);

CREATE TABLE IF NOT EXISTS agent_memory_episodes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  node_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
);

CREATE INDEX IF NOT EXISTS idx_agent_ep_user_time
  ON agent_memory_episodes(user_id, created_at DESC);
