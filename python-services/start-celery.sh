#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# 启动 Celery worker + beat（使用项目内 python-services/.venv 解释器）
#
# 设计目标：解释器随项目走，不依赖 /tmp/id_venv（重启后会被清空）。
#   凭据从 infra/supabase-lite/.env 读取（REDIS_URL / POSTGRES_PASSWORD /
#   MINIO_* 等），与 start-services-linux.sh 保持一致。
#
# 用法：
#   ./python-services/start-celery.sh          # 启动（若已在跑会并存，先手动停旧进程）
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/python-services"
INFRA_ENV="$ROOT/infra/supabase-lite/.env"
LOG_DIR="$ROOT/logs"
VENV="$PY/.venv"
VENV_PY="$VENV/bin/python"
CELERY="$VENV/bin/celery"

if [[ ! -x "$VENV_PY" ]]; then
  echo "❌ 找不到 $VENV_PY，请先执行：uv venv --python 3.12 && uv sync" >&2
  exit 1
fi

# ── 读取 infra 凭据（REDIS_URL / POSTGRES_PASSWORD / MINIO_* 等）──
if [[ -f "$INFRA_ENV" ]]; then
  set -a
  # shellcheck disable=SC1090
  source <(grep -E '^[A-Z_]+=' "$INFRA_ENV" | sed 's/\r$//')
  set +a
else
  echo "⚠️  找不到 $INFRA_ENV，将使用默认值（可能连不上 Redis/PG）" >&2
fi

# 与 common/config.py 约定一致的变量
export PG_PASSWORD="${PG_PASSWORD:-$POSTGRES_PASSWORD}"
export PG_HOST="${PG_HOST:-localhost}"
export PG_PORT="${PG_PORT:-5432}"
export PG_USER="${PG_USER:-postgres}"
export PG_DATABASE="${PG_DATABASE:-postgres}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6379/0}"
export REDIS_HOST="${REDIS_HOST:-localhost}"
export REDIS_PORT="${REDIS_PORT:-6379}"
export MINIO_ENDPOINT="${MINIO_ENDPOINT:-http://localhost:9000}"
export MINIO_ROOT_USER="${MINIO_ROOT_USER:-investdojo}"
export MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-investdojo_dev_only}"
export MINIO_BUCKET="${MINIO_BUCKET:-investdojo}"

# factors 包位于 feature-svc，必须加入 PYTHONPATH 才能被 celery_worker 导入
export PYTHONPATH="$PY:$PY/train-svc:$PY/feature-svc"
export ENABLE_DAILY_BEAT=1

mkdir -p "$LOG_DIR"
celeryWorkdir="$PY/train-svc"

cd "$celeryWorkdir"
echo "🚀 启动 Celery worker + beat（解释器: $VENV_PY）"
# 用 venv 的 python 直接跑 celery，彻底不依赖脚本 shebang；setsid 脱离启动会话
setsid -- "$VENV_PY" -m celery -A celery_worker.celery_app worker --loglevel=info --queues=train,feature,default --concurrency=2 \
  > "$LOG_DIR/celery-worker.log" 2>&1 < /dev/null &
echo "   worker pid=$!"
setsid -- "$VENV_PY" -m celery -A celery_worker.celery_app beat --loglevel=info \
  > "$LOG_DIR/celery-beat.log" 2>&1 < /dev/null &
echo "   beat   pid=$!"

echo "✅ 已启动。日志："
echo "   tail -f $LOG_DIR/celery-worker.log"
echo "   tail -f $LOG_DIR/celery-beat.log"
