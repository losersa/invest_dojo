#!/usr/bin/env bash
# InvestDojo API 凭证体检脚本
# 用法：bash scripts/check_api_access.sh
#
# 读取 ~/.investdojo.env 里的所有 token，逐个打真实 API 看是否活着

set -euo pipefail

ENV_FILE="$HOME/.investdojo.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ 找不到 $ENV_FILE"
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

pass=0; fail=0; skip=0

check() {
  local name="$1" code="$2" expect="${3:-200}"
  if [[ -z "${!4:-}" ]]; then
    printf "  ⚪ %-28s \033[90mSKIP (未配置)\033[0m\n" "$name"
    skip=$((skip+1))
    return
  fi
  if [[ "$code" == "$expect" ]]; then
    printf "  ✅ %-28s \033[32mHTTP %s\033[0m\n" "$name" "$code"
    pass=$((pass+1))
  else
    printf "  ❌ %-28s \033[31mHTTP %s (期望 %s)\033[0m\n" "$name" "$code" "$expect"
    fail=$((fail+1))
  fi
}

echo "══════════════════════════════════════════"
echo "  🔐 InvestDojo API 凭证体检"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════"
echo ""

# ── Supabase Data (service_role) ──
if [[ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
  code=$(curl -sS -o /dev/null -w "%{http_code}" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    "$SUPABASE_URL/rest/v1/symbols?select=*&limit=1")
  check "Supabase Data (service)" "$code" "200" "SUPABASE_SERVICE_ROLE_KEY"
else
  check "Supabase Data (service)" "000" "200" "SUPABASE_SERVICE_ROLE_KEY"
fi

# ── Supabase Management ──
if [[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  code=$(curl -sS -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    "https://api.supabase.com/v1/projects")
  check "Supabase Management" "$code" "200" "SUPABASE_ACCESS_TOKEN"
else
  check "Supabase Management" "000" "200" "SUPABASE_ACCESS_TOKEN"
fi

# ── GitHub ──
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  code=$(curl -sS -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/user")
  check "GitHub API (user)" "$code" "200" "GITHUB_TOKEN"

  if [[ -n "${GITHUB_REPO:-}" ]]; then
    code=$(curl -sS -o /dev/null -w "%{http_code}" \
      -H "Authorization: Bearer $GITHUB_TOKEN" \
      -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/$GITHUB_REPO")
    check "GitHub Repo ($GITHUB_REPO)" "$code" "200" "GITHUB_TOKEN"
  fi
else
  check "GitHub API" "000" "200" "GITHUB_TOKEN"
fi

# ── DeepSeek ──
if [[ -n "${DEEPSEEK_API_KEY:-}" ]]; then
  code=$(curl -sS -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $DEEPSEEK_API_KEY" \
    "https://api.deepseek.com/models")
  check "DeepSeek" "$code" "200" "DEEPSEEK_API_KEY"
else
  check "DeepSeek" "000" "200" "DEEPSEEK_API_KEY"
fi

# ── Kimi (Moonshot) ──
if [[ -n "${KIMI_API_KEY:-}" ]]; then
  code=$(curl -sS -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $KIMI_API_KEY" \
    "https://api.moonshot.cn/v1/models")
  check "Kimi (Moonshot)" "$code" "200" "KIMI_API_KEY"
else
  check "Kimi (Moonshot)" "000" "200" "KIMI_API_KEY"
fi

# ── Tushare（POST 接口，检查方式不同）──
if [[ -n "${TUSHARE_TOKEN:-}" ]]; then
  body=$(curl -sS -X POST "https://api.tushare.pro" \
    -H "Content-Type: application/json" \
    -d "{\"api_name\":\"stock_basic\",\"token\":\"$TUSHARE_TOKEN\",\"params\":{\"limit\":1}}")
  if echo "$body" | grep -q '"code":0'; then
    printf "  ✅ %-28s \033[32mOK\033[0m\n" "Tushare Pro"
    pass=$((pass+1))
  else
    printf "  ❌ %-28s \033[31m%s\033[0m\n" "Tushare Pro" "$(echo "$body" | head -c 80)"
    fail=$((fail+1))
  fi
else
  printf "  ⚪ %-28s \033[90mSKIP (未配置)\033[0m\n" "Tushare Pro"
  skip=$((skip+1))
fi

# ── Vercel ──
if [[ -n "${VERCEL_TOKEN:-}" ]]; then
  code=$(curl -sS -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $VERCEL_TOKEN" \
    "https://api.vercel.com/v2/user")
  check "Vercel" "$code" "200" "VERCEL_TOKEN"
else
  check "Vercel" "000" "200" "VERCEL_TOKEN"
fi

# ── Cloudflare ──
if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  code=$(curl -sS -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/user/tokens/verify")
  check "Cloudflare" "$code" "200" "CLOUDFLARE_API_TOKEN"
else
  check "Cloudflare" "000" "200" "CLOUDFLARE_API_TOKEN"
fi

echo ""
echo "══════════════════════════════════════════"
printf "  ✅ %d 通过  ❌ %d 失败  ⚪ %d 未配置\n" "$pass" "$fail" "$skip"
echo "══════════════════════════════════════════"

[[ $fail -eq 0 ]] || exit 1
