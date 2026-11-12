#!/usr/bin/env bash
# 读取 .dev.vars 中的敏感凭据，上传到 Cloudflare secret 并部署 Worker。
#
# 用法：
#   1. 编辑 .dev.vars，填入 SMTP_PASS / GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
#   2. 运行 bash scripts/deploy-with-secrets.sh
#
# 脚本会：
#   1. 校验三个凭据非空
#   2. 通过 wrangler secret put 上传（值经 stdin 管道，不落命令行历史）
#   3. 构建前端 + wrangler deploy 部署
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VARS_FILE="$ROOT/.dev.vars"
TOKEN_FILE="$ROOT/.cf-token"

if [ ! -f "$VARS_FILE" ]; then
  echo "✗ 未找到 $VARS_FILE"
  exit 1
fi
if [ ! -f "$TOKEN_FILE" ]; then
  echo "✗ 未找到 $TOKEN_FILE"
  exit 1
fi

# 读取 .dev.vars（忽略注释行，KEY=value 格式）
get_var() {
  local key="$1"
  sed -n "s/^${key}=//p" "$VARS_FILE" | head -1
}

SMTP_PASS="$(get_var SMTP_PASS)"
GITHUB_CLIENT_ID="$(get_var GITHUB_CLIENT_ID)"
GITHUB_CLIENT_SECRET="$(get_var GITHUB_CLIENT_SECRET)"

# 校验非空
MISSING=""
[ -z "$SMTP_PASS" ] && MISSING="$MISSING SMTP_PASS"
[ -z "$GITHUB_CLIENT_ID" ] && MISSING="$MISSING GITHUB_CLIENT_ID"
[ -z "$GITHUB_CLIENT_SECRET" ] && MISSING="$MISSING GITHUB_CLIENT_SECRET"

if [ -n "$MISSING" ]; then
  echo "✗ 以下凭据在 .dev.vars 中为空，请先填写：$MISSING"
  exit 1
fi

# 注入部署凭证到环境
export CLOUDFLARE_API_TOKEN="$(sed -n '6p' "$TOKEN_FILE")"
export CLOUDFLARE_ACCOUNT_ID="$(sed -n '7p' "$TOKEN_FILE")"

echo "==> 上传 secrets（值经 stdin 管道，不落命令行历史）…"
printf '%s' "$SMTP_PASS" | npx wrangler secret put SMTP_PASS >/dev/null 2>&1
printf '%s' "$GITHUB_CLIENT_ID" | npx wrangler secret put GITHUB_CLIENT_ID >/dev/null 2>&1
printf '%s' "$GITHUB_CLIENT_SECRET" | npx wrangler secret put GITHUB_CLIENT_SECRET >/dev/null 2>&1
echo "   ✓ SMTP_PASS / GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET 已上传"

echo "==> 构建前端…"
npm run build

echo "==> 部署 Worker…"
npx wrangler deploy

echo ""
echo "✓ 完成。站点：https://study.hesen.dpdns.org"
