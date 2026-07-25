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

# 3. 数据库落库（权威）—— 直连本地 PG（infra/supabase-lite/.env）
echo "【3】数据库 fundamentals 表实时统计（本地 PG）"

# 本地 PG 凭据
INFRA_ENV="$(cd "$(dirname "$0")/.." && pwd)/infra/supabase-lite/.env"
if [ -f "$INFRA_ENV" ]; then
  # shellcheck disable=SC1090
  set -a; source <(grep -E '^[A-Z_]+=' "$INFRA_ENV" | sed 's/\r$//'); set +a
fi
export PGPASSWORD="${PGPASSWORD:-$POSTGRES_PASSWORD}"
PGHOST="${PG_HOST:-127.0.0.1}"
PGPORT="${PG_PORT:-5432}"
PGUSER="${PG_USER:-postgres}"
PGDB="${PG_DATABASE:-postgres}"

PYTHON="$(cd "$(dirname "$0")/.." && pwd)/python-services/.venv/bin/python"
if [ -x "$PYTHON" ]; then
  STATS=$(timeout 30 "$PYTHON" - "$PGHOST" "$PGPORT" "$PGUSER" "$PGDB" "$PGPASSWORD" <<'PY'
import sys, json
host, port, user, db, pwd = sys.argv[1:6]
try:
    import psycopg2
    conn = psycopg2.connect(host=host, port=int(port), user=user,
                            password=pwd, dbname=db, connect_timeout=10)
    cur = conn.cursor()
    cur.execute(
        "SELECT COUNT(*) AS total, COUNT(DISTINCT symbol) AS symbols, "
        "MIN(report_date) AS earliest, MAX(report_date) AS latest "
        "FROM fundamentals"
    )
    t, s, e, l = cur.fetchone()
    print(json.dumps({"total": t, "symbols": s,
                       "earliest": str(e) if e else None,
                       "latest": str(l) if l else None}))
    conn.close()
except Exception as ex:  # noqa: BLE001
    print(json.dumps({"error": str(ex)}))
PY
)
  if [ -n "$STATS" ]; then
    TOTAL=$(echo "$STATS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('total','?'))" 2>/dev/null)
    SYMBOLS=$(echo "$STATS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('symbols','?'))" 2>/dev/null)
    EARLIEST=$(echo "$STATS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('earliest') or '-')" 2>/dev/null)
    LATEST=$(echo "$STATS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('latest') or '-')" 2>/dev/null)
    echo "  总条数: ${TOTAL}"
    echo "  覆盖股票: ${SYMBOLS} 支"
    echo "  报告期范围: ${EARLIEST} ~ ${LATEST}"
  else
    echo "  ⚠ 查询失败（PG 连接 / psycopg2 问题）"
  fi
else
  echo "  ⚠ 找不到 python-services/.venv/bin/python，跳过 DB 统计"
fi

echo ""
echo "══════════════════════════════════════════"
