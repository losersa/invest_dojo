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

# 2. 最新日志
echo "【2】最新进度（日志最后一行）"
LAST=$(tail -c 500 /tmp/seed_fundamentals_v2.log 2>/dev/null | tr '\r' '\n' | grep -E '\[[0-9]+/[0-9]+\]' | tail -1)
if [ -n "$LAST" ]; then
  echo "  $LAST" | sed 's/^[[:space:]]*/  /'
else
  echo "  （无匹配日志）"
  tail -5 /tmp/seed_fundamentals_v2.log 2>/dev/null | sed 's/^/  /'
fi
echo ""

# 3. 数据库落库（权威）
echo "【3】数据库 fundamentals 表实时统计"
source apps/server/.env
RESP=$(curl -s -X POST "${SUPABASE_URL}/rest/v1/rpc/exec_sql" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" 2>/dev/null || echo "")

# 用 PostgREST HEAD 拿 Content-Range（最快）
TOTAL=$(curl -s -I "${SUPABASE_URL}/rest/v1/fundamentals?select=id" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Prefer: count=exact" \
  -H "Range: 0-0" 2>/dev/null | grep -i "content-range" | awk -F'/' '{print $2}' | tr -d '\r\n')

SYMBOLS=$(curl -s "${SUPABASE_URL}/rest/v1/fundamentals?select=symbol" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(set(r['symbol'] for r in d)))" 2>/dev/null || echo "?")

echo "  总条数: ${TOTAL:-?}"
echo "  覆盖股票: ${SYMBOLS} 支"
echo ""
echo "══════════════════════════════════════════"
