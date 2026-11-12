-- 合并 users 表与 profile 表：用户信息统一到 users 表，废弃 profile 表
-- users 表扩展 profile 字段，email 字段语义为「登录邮箱」（身份标识，唯一）。
-- 原 profile 表中的「联系邮箱」字段并入后废弃（统一用登录邮箱 email）。

-- 1) users 表新增 profile 字段
ALTER TABLE users ADD COLUMN nickname TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN goal TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN location TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN website TEXT NOT NULL DEFAULT '';
-- 注意：SQLite ALTER ADD COLUMN 不支持非常量默认值（datetime('now')），updated_at 用 NULL 默认
ALTER TABLE users ADD COLUMN updated_at TEXT;

-- 2) 把 profile 表数据合并进 users（按 user_id 匹配，无匹配则不迁移）
UPDATE users
SET nickname = (SELECT nickname FROM profile WHERE profile.user_id = users.id),
    avatar = (SELECT avatar FROM profile WHERE profile.user_id = users.id),
    bio = (SELECT bio FROM profile WHERE profile.user_id = users.id),
    goal = (SELECT goal FROM profile WHERE profile.user_id = users.id),
    phone = (SELECT phone FROM profile WHERE profile.user_id = users.id),
    location = (SELECT location FROM profile WHERE profile.user_id = users.id),
    website = (SELECT website FROM profile WHERE profile.user_id = users.id),
    updated_at = (SELECT updated_at FROM profile WHERE profile.user_id = users.id)
WHERE EXISTS (SELECT 1 FROM profile WHERE profile.user_id = users.id);

-- 3) 删除 profile 表
DROP TABLE IF EXISTS profile;
