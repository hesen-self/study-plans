-- 用户表：雪花算法生成的唯一无符号 id 与登录邮箱的权威映射
-- 说明：user_id 从「邮箱」切换为「雪花算法生成的唯一 id（无符号，字符串存储）」
--       邮箱使用独立的 email 字段存储。
-- 雪花 id 为 64 位无符号整数（最大约 1.8e19），超出 JS 安全整数与 SQLite 有符号
-- INTEGER 上限，故以 TEXT 存储十进制字符串，与现有各业务表 user_id TEXT 列兼容。
--
-- 存量数据（现有 user_id 为邮箱的业务表）由随后的数据迁移脚本回填，
-- 见 scripts/migrate-user-id.mjs（用应用层雪花算法生成一致 id 后逐表回填）。

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,               -- 雪花算法生成的唯一 id（十进制字符串）
  email TEXT NOT NULL,               -- 登录邮箱
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
