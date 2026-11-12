#!/usr/bin/env bash
# 移除 study.hesen.dpdns.org 的 Cloudflare Access 保护
#
# ⚠️ 重要：执行前必须已完成以下两步，否则你会被锁在门外！
#   1. 已用 wrangler secret put 填好 SMTP_PASS / GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
#   2. 已在浏览器实测「邮箱验证码」和「GitHub」登录均可用
#
# 用法：bash scripts/remove-access.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOKEN_FILE="$ROOT/.cf-token"

if [ ! -f "$TOKEN_FILE" ]; then
  echo "✗ 未找到凭证文件：$TOKEN_FILE"
  exit 1
fi

API_TOKEN="$(sed -n '6p' "$TOKEN_FILE")"
ACCOUNT_ID="$(sed -n '7p' "$TOKEN_FILE")"

BASE="https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/apps"

echo "==> 列出当前 Access 应用…"
curl -s --ssl-no-revoke "$BASE" -H "Authorization: Bearer $API_TOKEN" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);(j.result||[]).forEach(a=>console.log(`  - ${a.uid||a.id}  ${a.name}  (${a.domain})`))})'

echo ""
echo "⚠️  即将删除名为 study-plans、域名 study.hesen.dpdns.org 的 Access 应用。"
echo "    删除后站点将完全依赖应用层自建登录。"
read -r -p "    确认已填好 secret 且登录可用？输入 yes 继续：" CONFIRM

if [ "$CONFIRM" != "yes" ]; then
  echo "已取消。"
  exit 0
fi

# 找到 study-plans 应用的 id
APP_ID="$(curl -s --ssl-no-revoke "$BASE" -H "Authorization: Bearer $API_TOKEN" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);const a=(j.result||[]).find(x=>x.name==="study-plans");console.log(a?(a.uid||a.id):"")})')"

if [ -z "$APP_ID" ]; then
  echo "✗ 未找到 study-plans 应用，可能已删除。"
  exit 0
fi

echo "==> 删除 Access 应用 $APP_ID …"
RESULT="$(curl -s --ssl-no-revoke -X DELETE "$BASE/$APP_ID" -H "Authorization: Bearer $API_TOKEN")"
echo "$RESULT" | head -c 500; echo

if echo "$RESULT" | grep -q '"success":true'; then
  echo "✓ Access 保护已移除。站点现由应用层自建登录保护。"
else
  echo "✗ 删除失败，请检查输出。"
fi
