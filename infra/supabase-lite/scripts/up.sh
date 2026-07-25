#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# InvestDojo · Supabase 精简栈 · 启动脚本（Mac / Linux）
# ═══════════════════════════════════════════════════════════════════
# 用法：cd infra/supabase-lite && ./scripts/up.sh
#
# 做的事：
#   1. 检查 docker / docker compose
#   2. 检查 .env（没有就从 .env.example 复制 + 生成随机密钥）
#   3. docker compose up -d
#   4. 等 db healthy
#   5. 给 authenticator / supabase_auth_admin 设密码（ALTER ROLE）
#   6. 重启 rest / auth 容器（让它们用新密码重连）
#   7. 打印所有端点 + anon/service_role key
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
    log_warn "未找到 .env，从 .env.example 复制并生成随机密钥"
    cp .env.example .env

    # 生成随机密钥（macOS 的 base64 没有 -w，用 tr 代替换行）
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

    log_ok "已生成 POSTGRES_PASSWORD 和 JWT_SECRET"
    log_warn "ANON_KEY / SERVICE_ROLE_KEY 还需手动签，稍后用 ./scripts/generate-keys.sh 生成"
else
    log_ok "找到现有 .env"
fi

# 加载 .env（忽略注释 / 空行 / 带空格的变量）
set -a
# shellcheck disable=SC1091
source <(grep -E '^[A-Z_]+=' .env | sed 's/\r$//')
set +a

# ─── 3. ANON_KEY / SERVICE_ROLE_KEY 自动生成（如果还是占位）──────
if [[ "${ANON_KEY:-}" == "<CHANGE_ME_ANON_JWT>" || -z "${ANON_KEY:-}" ]]; then
    log_warn "ANON_KEY 还是占位，自动用 Python 签一对（需要 python3）"
    if ! command -v python3 >/dev/null; then
        log_err "需要 python3 用于签 JWT"
        exit 1
    fi
    KEYS=$(python3 "$SCRIPT_DIR/generate-keys.py" "$JWT_SECRET")
    NEW_ANON=$(echo "$KEYS" | awk '/^ANON_KEY=/ { print substr($0, 10) }')
    NEW_SERVICE=$(echo "$KEYS" | awk '/^SERVICE_ROLE_KEY=/ { print substr($0, 18) }')

    if [[ "$(uname)" == "Darwin" ]]; then
        sed -i '' "s|ANON_KEY=.*|ANON_KEY=$NEW_ANON|" .env
        sed -i '' "s|SERVICE_ROLE_KEY=.*|SERVICE_ROLE_KEY=$NEW_SERVICE|" .env
    else
        sed -i "s|ANON_KEY=.*|ANON_KEY=$NEW_ANON|" .env
        sed -i "s|SERVICE_ROLE_KEY=.*|SERVICE_ROLE_KEY=$NEW_SERVICE|" .env
    fi

    export ANON_KEY=$NEW_ANON
    export SERVICE_ROLE_KEY=$NEW_SERVICE
    log_ok "已生成并写入 .env"
fi

# ─── 4. 创建数据目录 ─────────────────────────────────────────────
log_step "3. 创建数据目录"
: "${DATA_DIR:=./data}"
mkdir -p "$DATA_DIR/db" "$DATA_DIR/db-backup"
log_ok "DATA_DIR=$DATA_DIR"

# ─── 5. 启动容器 ─────────────────────────────────────────────────
log_step "4. 启动容器"
docker compose up -d
log_ok "compose up 完成"

# ─── 6. 等 db healthy ───────────────────────────────────────────
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

# ─── 7. 设置 role 密码（authenticator / supabase_auth_admin）─────
log_step "6. 注入 authenticator / supabase_auth_admin 密码"
docker compose exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" db psql -U postgres -d postgres <<SQL
ALTER ROLE authenticator        WITH PASSWORD '$POSTGRES_PASSWORD';
ALTER ROLE supabase_auth_admin  WITH PASSWORD '$POSTGRES_PASSWORD';
SQL
log_ok "role 密码已设置"

# ─── 8. 重启依赖 db 的服务（让它们用新密码重连）───────────────────
log_step "7. 重启 rest / auth（使用新密码）"
docker compose restart rest auth
sleep 3
log_ok "重启完成"

# ─── 9. 健康探测 ────────────────────────────────────────────────
log_step "8. 健康探测"
KONG_PORT=${KONG_HTTP_PORT:-8000}
sleep 2

if curl -sf "http://localhost:$KONG_PORT/rest/v1/" -H "apikey: $ANON_KEY" -o /dev/null; then
    log_ok "PostgREST 通过 Kong 可达"
else
    log_warn "PostgREST 探测失败（可能服务还在启动，稍等 10s 再 curl）"
fi

if curl -sf "http://localhost:$KONG_PORT/auth/v1/health" -o /dev/null; then
    log_ok "GoTrue 通过 Kong 可达"
else
    log_warn "GoTrue 探测失败（可能还在跑 migration）"
fi

# ─── 10. 总结 ───────────────────────────────────────────────────
log_step "✅ 启动完成"
cat <<EOF

  API 网关         http://localhost:$KONG_PORT
  PostgREST        http://localhost:$KONG_PORT/rest/v1/
  GoTrue Auth      http://localhost:$KONG_PORT/auth/v1/
  Postgres 直连    localhost:${POSTGRES_PORT:-5432}  (user: postgres)

  SUPABASE_URL              = http://localhost:$KONG_PORT
  SUPABASE_ANON_KEY         = $ANON_KEY
  SUPABASE_SERVICE_ROLE_KEY = $SERVICE_ROLE_KEY

  对外给 Mac 用（Windows 上跑这个脚本时）：
    把 localhost 换成 investdojo.local 或你的局域网 IP

  停止：     docker compose down
  看日志：   docker compose logs -f <service>
  进入 DB：  docker compose exec db psql -U postgres

EOF
