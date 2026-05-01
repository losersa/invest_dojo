#!/bin/bash
# 因子值回填进度一键查看（T-3.05 辅助工具）
# 用法：bash scripts/check_backfill_progress.sh

set -e
cd "$(dirname "$0")/.."

echo "══════════════════════════════════════════"
echo "  📊 feature_values 回填进度"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════"
echo ""

# 1. 进程状态
echo "【1】进程状态"
PID=$(pgrep -f "backfill_factors.py" | head -1 || echo "")
if [ -n "$PID" ]; then
  echo "  ✅ 运行中 PID=$PID"
  ps -p "$PID" -o etime,pcpu,rss | tail -1 | awk '{printf "     已运行 %s | CPU %s%% | 内存 %.0fMB\n", $1, $2, $3/1024}'
else
  echo "  ❌ 未运行"
fi
echo ""

# 2. 日志尾
LATEST_LOG=$(ls -t /tmp/backfill_factors*.log 2>/dev/null | head -1 || echo "")
echo "【2】最新日志（${LATEST_LOG:-无}）"
if [ -n "$LATEST_LOG" ]; then
  # 进度行：batches= / records_written=
  tail -c 5000 "$LATEST_LOG" 2>/dev/null | LC_ALL=C tr '\r' '\n' \
    | grep -E "batch_done|batch_compute\.start|batch_compute\.done" \
    | tail -5 \
    | sed 's/^/  /' || echo "  （暂无进度行）"
fi
echo ""

# 3. 数据库统计（Management API SQL）
echo "【3】feature_values 表实时统计"

# 凭证
if [ -f "$HOME/.investdojo.env" ]; then
  # shellcheck disable=SC1091
  set -a; source "$HOME/.investdojo.env"; set +a
else
  # shellcheck disable=SC1091
  source apps/server/.env 2>/dev/null || true
fi

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ] || [ -z "${SUPABASE_URL:-}" ]; then
  echo "  ⚠ 缺少 SUPABASE_ACCESS_TOKEN 或 SUPABASE_URL，跳过"
  echo ""
  exit 0
fi

PROJECT_ID=$(echo "$SUPABASE_URL" | sed -E 's|https://([^.]+)\..*|\1|')
STATS=$(curl -sS -X POST "https://api.supabase.com/v1/projects/${PROJECT_ID}/database/query" \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"query":"SELECT COUNT(*) AS total, COUNT(DISTINCT factor_id) AS factors, COUNT(DISTINCT symbol) AS symbols, MIN(date) AS earliest, MAX(date) AS latest, MAX(computed_at) AS last_write FROM feature_values"}' \
  2>/dev/null)

TOTAL=$(echo "$STATS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"{d[0]['total']:,}\")" 2>/dev/null || echo "?")
FACTORS=$(echo "$STATS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['factors'])" 2>/dev/null || echo "?")
SYMBOLS=$(echo "$STATS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['symbols'])" 2>/dev/null || echo "?")
EARLIEST=$(echo "$STATS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0].get('earliest') or '-')" 2>/dev/null || echo "?")
LATEST=$(echo "$STATS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0].get('latest') or '-')" 2>/dev/null || echo "?")
LAST_WRITE=$(echo "$STATS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0].get('last_write') or '-')" 2>/dev/null || echo "?")

echo "  总条数:     $TOTAL"
echo "  覆盖因子:   $FACTORS / 204"
echo "  覆盖股票:   $SYMBOLS / 5200"
echo "  日期范围:   $EARLIEST ~ $LATEST"
echo "  最新写入:   $LAST_WRITE"
echo ""

# 4. 本次 backfill 的速率估算（从 log 尾部找 duration_sec）
if [ -n "$LATEST_LOG" ]; then
  BATCHES_DONE=$(grep -c "batch_done" "$LATEST_LOG" 2>/dev/null | tr -d '\n ' || echo 0)
  if [ "${BATCHES_DONE:-0}" -gt 0 ] 2>/dev/null; then
    START_TIME=$(head -1 "$LATEST_LOG" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}' | head -1 || echo "")
    echo "【4】速率"
    echo "  已完成批次: $BATCHES_DONE"
    if [ -n "$START_TIME" ]; then
      echo "  启动时刻:   $START_TIME"
    fi
  fi
fi

echo "══════════════════════════════════════════"
