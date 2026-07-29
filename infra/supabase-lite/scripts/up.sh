#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# InvestDojo · 基础设施 · 启动脚本（Mac / Linux）
# ═══════════════════════════════════════════════════════════════════
# 用法：cd infra/supabase-lite && ./scripts/up.sh
#
# 做的事：
#   1. 检查 docker / docker compose
#   2. 检查 .env（没有就从 .env.example 复制 + 生成随机密码）
#   3. docker compose up -d
#   4. 等 db healthy
#   5. 打印端点
#
# 鉴权已改为自建模块（data-svc /api/v1/auth + httpOnly Cookie），
# 不再依赖 Supabase 的 PostgREST / GoTrue / Kong。
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(dirname "$SCRIPT_DIR")"
cd "$STACK_DIR"

# 颜色
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'
log_step() { echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n${BLUE}  $*${NC}\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; }
log_ok()   { echo -e "${GREEN}✓${NC} $*"; }
log_warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
log_err()  { echo -e "${RED}❌${NC} $*" >&2; }
log_info() { echo -e "${CYAN}ℹ${NC}  $*"; }

# ─── 1. 环境检查 ─────────────────────────────────────────────────
log_step "1. 环境检查"

command -v docker >/dev/null || { log_err "未找到 docker"; exit 1; }
docker info >/dev/null 2>&1 || { log_err "Docker 守护进程未运行"; exit 1; }
log_ok "Docker 就绪"

# ─── 2. .env（缺失就生成）─────────────────────────────────────────
log_step "2. 检查 .env"

if [[ ! -f .env ]]; then
    log_warn "未找到 .env，从 .env.example 复制并生成随机密码"
    cp .env.example .env

    # 生成随机密码（macOS 的 base64 没有 -w，用 tr 代替换行）
    PG_PWD=$(openssl rand -base64 24 | tr -d '/+=\n' | cut -c1-24)
    JWT_SEC=$(openssl rand -base64 48 | tr -d '\n')

    # sed -i 语法差异：Mac 要空串，Linux 不要
    if [[ "$(uname)" == "Darwin" ]]; then
        SED_INPLACE=(-i '')
    else
        SED_INPLACE=(-i)
    fi

    sed "${SED_INPLACE[@]}" "s|<CHANGE_ME_STRONG_PASSWORD>|$PG_PWD|g" .env
    sed "${SED_INPLACE[@]}" "s|<CHANGE_ME_AT_LEAST_32_BYTES>|$JWT_SEC|g" .env

    log_ok "已生成 POSTGRES_PASSWORD 和 AUTH_JWT_SECRET"
else
    log_ok "找到现有 .env"
fi

# 加载 .env（忽略注释 / 空行 / 带空格的变量）
set -a
# shellcheck disable=SC1091
source <(grep -E '^[A-Z_]+=' .env | sed 's/\r$//')
set +a

# ─── 3. 创建数据目录 ─────────────────────────────────────────────
log_step "3. 创建数据目录"
: "${DATA_DIR:=./data}"
mkdir -p "$DATA_DIR/db" "$DATA_DIR/db-backup"
log_ok "DATA_DIR=$DATA_DIR"

# ─── 4. 启动容器 ─────────────────────────────────────────────────
log_step "4. 启动容器"
docker compose up -d
log_ok "compose up 完成"

# ─── 5. 等 db healthy ───────────────────────────────────────────
log_step "5. 等待 Postgres 就绪"
for i in $(seq 1 30); do
    if docker compose exec -T db pg_isready -U postgres -d postgres &>/dev/null; then
        log_ok "Postgres healthy"
        break
    fi
    echo -n "."
    sleep 2
done
echo ""

# ─── 6. 总结 ───────────────────────────────────────────────────
log_step "✅ 启动完成"
cat <<EOF

  Postgres 直连    localhost:${POSTGRES_PORT:-5432}  (user: postgres)
  Redis            localhost:6379
  MinIO S3         localhost:9000
  MinIO Console    localhost:9001

  鉴权（自建）     data-svc :8006  /api/v1/auth（httpOnly Cookie: id_session）

  业务迁移：       python-services/scripts/apply_migrations.sh
  停止：           docker compose down
  看日志：         docker compose logs -f <service>
  进入 DB：        docker compose exec db psql -U postgres

EOF
