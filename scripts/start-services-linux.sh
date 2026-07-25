#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# InvestDojo · Linux (devcloud) 启动脚本：Python 微服务 + Celery + 前端
#
# 前置：
#   1. 已在 infra/supabase-lite 跑过 ./scripts/up.sh（生成 .env 与全部容器）
#   2. python-services 已建好 venv：uv venv --python 3.12 && uv sync
#   3. 前端已装依赖：pnpm install
#
# 说明：
#   Linux 无 WinNAT 端口限制，Python 服务直接用原生端口 8001-8006
#   （Windows 上的 10001-10006 只是绕 WinNAT 的妥协）。
#   PG / Redis / MinIO 密码自动从 infra/supabase-lite/.env 读取。
#
# 用法：
#   ./scripts/start-services-linux.sh            # 全起
#   ./scripts/start-services-linux.sh -SkipFrontend
#   ./scripts/start-services-linux.sh -SkipDocker   # 仅起 Python + 前端（容器已在跑）
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/python-services"
WEB="$ROOT/apps/web"
INFRA_ENV="$ROOT/infra/supabase-lite/.env"
LOG_DIR="$ROOT/logs"

SKIP_FRONTEND=0
SKIP_DOCKER=0
for a in "$@"; do
  case "$a" in
    -SkipFrontend) SKIP_FRONTEND=1 ;;
    -SkipDocker)   SKIP_DOCKER=1 ;;
    *) echo "未知参数: $a"; exit 2 ;;
  esac
done

# ── 颜色 ──
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log_step(){ echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n${BLUE}  $*${NC}\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; }
log_ok(){ echo -e "${GREEN}✓${NC} $*"; }
log_warn(){ echo -e "${YELLOW}⚠${NC}  $*"; }
log_err(){ echo -e "${RED}❌${NC} $*" >&2; }

# ── 0. 读取 infra 凭据（PG / Redis / MinIO）──
log_step "0. 读取 infra 凭据"
if [[ ! -f "$INFRA_ENV" ]]; then
  log_err "找不到 $INFRA_ENV，请先运行 infra/supabase-lite/scripts/up.sh"
  exit 1
fi
set -a
# shellcheck disable=SC1090
source <(grep -E '^[A-Z_]+=' "$INFRA_ENV" | sed 's/\r$//')
set +a
export PG_PASSWORD="$POSTGRES_PASSWORD"
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
export PYTHONPATH="$PY"
log_ok "POSTGRES_PASSWORD / REDIS / MINIO 已注入环境"

# ── 1. 启动 Docker 基础设施（可选）──
if [[ $SKIP_DOCKER -eq 0 ]]; then
  log_step "1. 启动 Docker 基础设施"
  ( cd "$ROOT/infra/supabase-lite" && docker compose up -d )
  log_ok "容器已启动，等待 Postgres 就绪..."
  for i in $(seq 1 30); do
    if docker compose -f "$ROOT/infra/supabase-lite/docker-compose.yml" exec -T db pg_isready -U postgres -d postgres &>/dev/null; then
      log_ok "Postgres healthy"; break
    fi
    sleep 2
  done
else
  log_step "1. 跳过 Docker（-SkipDocker）"
fi

# ── 2. Python 微服务 ──
log_step "2. 启动 Python 微服务"
mkdir -p "$LOG_DIR"

VENV="$PY/.venv"
if [[ -x "$VENV/bin/python" ]]; then
  PYEXE="$VENV/bin/python"; CELERY="$VENV/bin/celery"
elif command -v python3 >/dev/null; then
  PYEXE=python3; CELERY=celery
else
  log_err "找不到 python venv 或 python3，先执行：uv venv --python 3.12 && uv sync"; exit 1
fi
log_ok "Python: $($PYEXE --version 2>&1)"

# dir -> 原生端口（与 common/config.py 默认值一致）
svcList=(
  "feature-svc:8001"
  "train-svc:8002"
  "infer-svc:8003"
  "backtest-svc:8004"
  "monitor-svc:8005"
  "data-svc:8006"
)

PIDS=()
for entry in "${svcList[@]}"; do
  svc="${entry%%:*}"; port="${entry##*:}"
  workdir="$PY/$svc"
  # 让 config.py 的 *_svc_port 与实际监听端口一致（monitor 据此探测兄弟服务）
  envName="$(echo "$svc" | tr '[:lower:]' '[:upper:]' | tr '-' '_')_PORT"
  export "$envName"="$port"
  log_ok "启动 $svc :$port"
  # --reload-dir 收窄 watch 范围：只 watch 本服务 + common。
  # 不限制时 watch 整个工作目录（含 logs/、.task_history/ 等高频写入目录），
  # 任何文件变动都触发全部服务 reload，且优雅退出遇慢请求会卡死
  # （排障手册 docs/ops/dev-troubleshooting.md ## 12）。
  nohup "$PYEXE" -m uvicorn main:app --app-dir "$workdir" --host 0.0.0.0 --port "$port" \
    --reload --reload-dir "$workdir" --reload-dir "$PY/common" \
    > "$LOG_DIR/$svc.log" 2>&1 &
  PIDS+=("$!")
done

# ── 3. Celery worker + beat（每日 17:00 增量因子）──
log_step "3. 启动 Celery worker + beat"
if [[ -x "$CELERY" ]] || command -v "$CELERY" >/dev/null 2>&1 || command -v celery >/dev/null 2>&1; then
  export ENABLE_DAILY_BEAT=1
  export PYTHONPATH="$PY:$PY/train-svc:$PY/feature-svc"
  celeryWorkdir="$PY/train-svc"
  nohup "$CELERY" -A celery_worker.celery_app worker --loglevel=info --queues=train,feature,default --concurrency=2 \
    > "$LOG_DIR/celery-worker.log" 2>&1 &
  PIDS+=("$!")
  nohup "$CELERY" -A celery_worker.celery_app beat --loglevel=info \
    > "$LOG_DIR/celery-beat.log" 2>&1 &
  PIDS+=("$!")
  log_ok "celery worker + beat 已启动"
else
  log_warn "找不到 celery，跳过定时任务"
fi

# ── 4. 前端 ──
if [[ $SKIP_FRONTEND -eq 0 ]]; then
  log_step "4. 启动 Next.js 前端"
  # 写 .env.local（从 infra/.env 取 anon key）
  ANON_KEY_VAL="${ANON_KEY:-}"
  cat > "$WEB/.env.local" <<EOF
NEXT_PUBLIC_SUPABASE_URL=http://localhost:8000
NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON_KEY_VAL
EOF
  log_ok "已写入 $WEB/.env.local"
  if command -v pnpm >/dev/null; then
    nohup pnpm dev > "$LOG_DIR/frontend.log" 2>&1 &
    PIDS+=("$!")
    log_ok "前端启动中（日志 $LOG_DIR/frontend.log）"
  else
    log_warn "未找到 pnpm，跳过前端（请先 npm i -g pnpm）"
  fi
else
  log_step "4. 跳过前端（-SkipFrontend）"
fi

# ── 5. 健康检查 ──
log_step "5. 健康检查"
sleep 8
checks=(
  "feature-svc:http://localhost:8001/health"
  "train-svc:http://localhost:8002/health"
  "infer-svc:http://localhost:8003/health"
  "backtest-svc:http://localhost:8004/health"
  "monitor-svc:http://localhost:8005/health"
  "data-svc:http://localhost:8006/health"
)
for c in "${checks[@]}"; do
  name="${c%%:*}"; url="${c##*:}"
  if curl -sf "$url" -o /dev/null; then log_ok "$name"; else log_warn "$name 未就绪（看 $LOG_DIR/$name.log）"; fi
done

echo ""
log_step "✅ 启动完成（PID: ${PIDS[*]}）"
echo -e "  前端:      ${GREEN}http://localhost:3000${NC}"
echo -e "  Kong 网关: ${GREEN}http://localhost:8000${NC}  (PostgREST + GoTrue)"
echo -e "  Python:    ${GREEN}:8001-8006${NC}"
echo -e "  PG:        ${GREEN}localhost:5432${NC}"
echo -e "\n  查看日志: tail -f $LOG_DIR/<服务>.log"
echo -e "  停止全部: kill ${PIDS[*]}"
