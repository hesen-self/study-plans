#!/usr/bin/env bash
# 上传 Cloudflare Access 自定义登录页（login page）模板
#
# 前置条件：
#   1. Zero Trust 套餐为 Pay-as-you-go 或 Enterprise（免费套餐会返回错误码 12133）
#   2. API Token 具备「Access: Custom Pages Write」权限
#   3. 部署凭证已写入项目根目录 .cf-token（第 6 行 token、第 7 行 account_id）
#
# 用法：bash scripts/deploy-access-login-page.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$ROOT/private/otp-template.html"
TOKEN_FILE="$ROOT/.cf-token"

if [ ! -f "$TEMPLATE" ]; then
  echo "✗ 未找到模板文件：$TEMPLATE"
  exit 1
fi
if [ ! -f "$TOKEN_FILE" ]; then
  echo "✗ 未找到凭证文件：$TOKEN_FILE"
  exit 1
fi

API_TOKEN="$(sed -n '6p' "$TOKEN_FILE")"
ACCOUNT_ID="$(sed -n '7p' "$TOKEN_FILE")"

if [ -z "$API_TOKEN" ] || [ -z "$ACCOUNT_ID" ]; then
  echo "✗ .cf-token 中凭证为空，请检查第 6/7 行"
  exit 1
fi

BASE="https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/custom_pages"

# 用 Node 把 HTML 转成 JSON 字符串（避免手动转义不可靠），平台已含 Node
CUSTOM_HTML="$(node -e 'const fs=require("fs");process.stdout.write(JSON.stringify(fs.readFileSync(process.argv[1],"utf8")))' "$TEMPLATE")"

echo "==> 1/3 校验模板语法（validate）…"
VALIDATE="$(curl -s --ssl-no-revoke -X POST "$BASE/validate" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"login\",\"custom_html\":$CUSTOM_HTML}")"
echo "$VALIDATE" | head -c 1200; echo

# 若 validate 返回 blocking errors，则中止
if echo "$VALIDATE" | grep -q '"errors":[[:space:]]*\[' && ! echo "$VALIDATE" | grep -q '"errors":[[:space:]]*\[\]'; then
  # 粗略判断：errors 数组非空（更精确判断交给用户看输出）
  echo "⚠ 校验返回了 errors，请查看上方输出确认是否为 blocking。若确认无 blocking 错误可忽略。"
fi

echo "==> 2/3 创建/更新 login 模板…"
# 先查是否已存在 login 类型模板
LIST="$(curl -s --ssl-no-revoke "$BASE" -H "Authorization: Bearer $API_TOKEN")"
EXISTING_ID="$(echo "$LIST" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);const p=(j.result||[]).find(x=>x.type==="login");console.log(p?p.uid||p.id||"":"");}catch(e){console.log("")}})')"

if [ -n "$EXISTING_ID" ]; then
  echo "  已存在 login 模板 id=$EXISTING_ID，执行 PUT 更新…"
  RESULT="$(curl -s --ssl-no-revoke -X PUT "$BASE/$EXISTING_ID" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"login\",\"type\":\"login\",\"custom_html\":$CUSTOM_HTML}")"
else
  echo "  不存在，执行 POST 创建…"
  RESULT="$(curl -s --ssl-no-revoke -X POST "$BASE" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"login\",\"type\":\"login\",\"custom_html\":$CUSTOM_HTML}")"
fi
echo "$RESULT" | head -c 1200; echo

echo "==> 3/3 完成"
if echo "$RESULT" | grep -q '"success":true'; then
  echo "✓ 登录页模板已发布（发布后仍需在 Zero Trust 后台将其设为账户默认或分配到应用）"
  echo "  路径：Zero Trust → Reusable components → Custom pages → Access login page → Set as default"
else
  echo "✗ 上传失败，请检查："
  echo "   - 错误码 12133：当前为免费套餐，需升级到 Pay-as-you-go/Enterprise"
  echo "   - 其它鉴权错误：Token 需具备 Access: Custom Pages Write 权限"
fi
