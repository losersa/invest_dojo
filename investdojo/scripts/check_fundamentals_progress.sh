#!/bin/bash
# 财报采集进度一键查看
# 用法：bash scripts/check_fundamentals_progress.sh

set -e
cd "$(dirname "$0")/.."

echo "══════════════════════════════════════════"
echo "  📊 T-1.05 财报采集进度"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════"
echo ""

# 1. 进程状态
echo "【1】进程状态"
if pgrep -f seed_fundamentals.py > /dev/null; then
  PID=$(pgrep -f seed_fundamentals.py | head -1)
  echo "  ✅ 运行中 PID=$PID"
  ps -p $PID -o etime,pcpu,rss | tail -1 | awk '{printf "     已运行 %s | CPU %s%% | 内存 %.0fMB\n", $1, $2, $3/1024}'
else
  echo "  ❌ 未运行"
fi
echo ""

# 2. 最新日志（自动取最近的 v* 日志）
LATEST_LOG=$(ls -t /tmp/seed_fundamentals*.log 2>/dev/null | head -1)
echo "【2】最新进度（$LATEST_LOG）"
LAST=$(tail -c 2000 "$LATEST_LOG" 2>/dev/null | LC_ALL=C tr '\r' '\n' | grep -E '\[[0-9]+/[0-9]+\]' | tail -1)
if [ -n "$LAST" ]; then
  echo "  $LAST" | sed 's/^[[:space:]]*/  /'
else
  echo "  （无匹配进度行）"
  tail -5 "$LATEST_LOG" 2>/dev/null | sed 's/^/  /'
fi
echo ""

# 3. 数据库落库（权威）—— 走 Management API 执行真实 SQL
# 为什么不用 PostgREST select=symbol？单页硬上限 1000 行，distinct 会失真
echo "【3】数据库 fundamentals 表实时统计"

# 优先读 ~/.investdojo.env（中心化凭证），fallback 回 apps/server/.env
if [ -f "$HOME/.investdojo.env" ]; then
  # shellcheck disable=SC1091
  set -a; source "$HOME/.investdojo.env"; set +a
else
  # shellcheck disable=SC1091
  source apps/server/.env
fi

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ] || [ -z "${SUPABASE_URL:-}" ]; then
  echo "  ⚠ 缺少 SUPABASE_ACCESS_TOKEN 或 SUPABASE_URL，跳过 DB 统计"
else
  PROJECT_ID=$(echo "$SUPABASE_URL" | sed -E 's|https://([^.]+)\..*|\1|')
  STATS=$(curl -sS -X POST "https://api.supabase.com/v1/projects/${PROJECT_ID}/database/query" \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"query":"SELECT COUNT(*) AS total, COUNT(DISTINCT symbol) AS symbols, MIN(report_date) AS earliest, MAX(report_date) AS latest FROM fundamentals"}' \
    2>/dev/null)

  TOTAL=$(echo "$STATS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['total'])" 2>/dev/null || echo "?")
  SYMBOLS=$(echo "$STATS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['symbols'])" 2>/dev/null || echo "?")
  EARLIEST=$(echo "$STATS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0].get('earliest') or '-')" 2>/dev/null || echo "?")
  LATEST=$(echo "$STATS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0].get('latest') or '-')" 2>/dev/null || echo "?")

  echo "  总条数: ${TOTAL}"
  echo "  覆盖股票: ${SYMBOLS} 支"
  echo "  报告期范围: ${EARLIEST} ~ ${LATEST}"
fi

echo ""
echo "══════════════════════════════════════════"
