#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# InvestDojo · Supabase Cloud → Windows 本地 数据迁移脚本
# ═══════════════════════════════════════════════════════════════════
#
# 运行位置：**Mac 开发机**（不是 Windows！）
# 作用：把云端 Supabase 的数据库完整搬到 Windows 上自托管的 Supabase
#
# 前置条件：
#   1. Windows 端已按 infra/supabase-windows/README.md 部署好栈
#   2. Mac 上有 pg_dump / pg_restore / psql (v15+)
#        brew install libpq && brew link --force libpq
#   3. Windows Postgres 5432 端口已放行（防火墙 Private profile）
#   4. 云端 DB 密码：Supabase Dashboard → Project Settings → Database
#
# 支持的模式（--mode）：
#   all            · 一把梭：dump + transfer + restore + verify
#   dump-only      · 只从云端拉 dump 到本地 work-dir
#   transfer-only  · 只把已有 dump 传到 Windows（需先 dump-only 完成）
#   restore-only   · 只在 Windows 上恢复（需先 transfer-only 完成）
#   verify         · 只跑行数校验（可单独用于部署后任何时候验数）
#
# 示例：
#   ./migrate_supabase_to_local.sh \
#       --source-url "postgresql://postgres:CLOUDPWD@db.adqznqsciqtepzimcvsg.supabase.co:5432/postgres" \
#       --target-host "investdojo.local" \
#       --target-password "WINPWD" \
#       --mode all
#
# 对应文档：
#   - docs/architecture/01_数据层.md §11 备份与恢复
#   - infra/supabase-windows/README.md
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

# ─── 颜色与日志 ───────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log_step()  { echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n${BLUE}  $*${NC}\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; }
log_ok()    { echo -e "${GREEN}✓${NC} $*"; }
log_warn()  { echo -e "${YELLOW}⚠${NC}  $*"; }
log_err()   { echo -e "${RED}❌${NC} $*" >&2; }
log_info()  { echo -e "${CYAN}ℹ${NC}  $*"; }

# ─── 默认参数 ─────────────────────────────────────────────────────
SOURCE_URL=""                              # 云端连接串
TARGET_HOST=""                             # Windows 主机名或 IP
TARGET_PORT="5432"
TARGET_USER="postgres"
TARGET_DB="postgres"
TARGET_PASSWORD=""                         # 即 Windows .env 里的 POSTGRES_PASSWORD
WORK_DIR="$HOME/investdojo-migrate"
MODE="all"
DUMP_FILE=""                               # 覆盖默认命名
SKIP_CONFIRM="false"
TRANSFER_METHOD="auto"                     # auto | scp | skip
SSH_USER=""                                # SCP 用；不指定则用 TARGET_USER 的桌面登录名
JOBS="4"                                   # pg_dump/restore 并行度

# Supabase 导不得碰的系统 schema
# 说明：
#   - public / auth / storage 要带走（我们代码和 RLS 依赖 auth.users、storage）
#   - supabase_functions / realtime / _analytics / pgsodium 等是各服务自有的，
#     新栈启动时官方脚本会重建，强行导入反而会冲突
DUMP_SCHEMAS=(public auth storage)

# ─── 使用说明 ─────────────────────────────────────────────────────
usage() {
    cat <<'EOF'
用法：
  ./migrate_supabase_to_local.sh [options]

必填：
  --source-url         URL   云端 PG 连接串
                             postgresql://postgres:<pwd>@db.<proj>.supabase.co:5432/postgres
  --target-host        HOST  Windows 主机地址（如 investdojo.local / 192.168.1.50）
  --target-password    PWD   Windows 上 Postgres 的密码（.env 里 POSTGRES_PASSWORD）

可选：
  --mode               MODE  all | dump-only | transfer-only | restore-only | verify
                             默认：all
  --target-port        PORT  目标端口，默认 5432
  --target-user        USER  目标 PG 用户，默认 postgres
  --target-db          DB    目标库名，默认 postgres
  --work-dir           DIR   dump 文件暂存目录，默认 ~/investdojo-migrate
  --dump-file          FILE  覆盖默认 dump 文件名（绝对路径）
  --transfer-method    M     auto | scp | skip   默认 auto（探测后选）
  --ssh-user           USER  SCP 用的 Windows 登录用户名
  --jobs               N     pg_dump/restore 并行度，默认 4
  --yes                      跳过所有 y/N 确认（慎用）
  -h, --help                 显示此帮助
EOF
}

# ─── 参数解析 ─────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --source-url)       SOURCE_URL="$2";       shift 2 ;;
        --target-host)      TARGET_HOST="$2";      shift 2 ;;
        --target-port)      TARGET_PORT="$2";      shift 2 ;;
        --target-user)      TARGET_USER="$2";      shift 2 ;;
        --target-db)        TARGET_DB="$2";        shift 2 ;;
        --target-password)  TARGET_PASSWORD="$2";  shift 2 ;;
        --work-dir)         WORK_DIR="$2";         shift 2 ;;
        --mode)             MODE="$2";             shift 2 ;;
        --dump-file)        DUMP_FILE="$2";        shift 2 ;;
        --transfer-method)  TRANSFER_METHOD="$2";  shift 2 ;;
        --ssh-user)         SSH_USER="$2";         shift 2 ;;
        --jobs)             JOBS="$2";             shift 2 ;;
        --yes)              SKIP_CONFIRM="true";   shift ;;
        -h|--help)          usage; exit 0 ;;
        *) log_err "未知参数: $1"; usage; exit 2 ;;
    esac
done

# ─── 推导默认值 ───────────────────────────────────────────────────
mkdir -p "$WORK_DIR"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
[[ -z "$DUMP_FILE" ]] && DUMP_FILE="$WORK_DIR/supabase_cloud_${TIMESTAMP}.dump"
MANIFEST_FILE="$WORK_DIR/supabase_cloud_${TIMESTAMP}.manifest.txt"
LATEST_LINK="$WORK_DIR/latest.dump"

# ─── 通用：确认 ───────────────────────────────────────────────────
confirm() {
    [[ "$SKIP_CONFIRM" == "true" ]] && return 0
    local prompt="${1:-确认继续？}"
    read -r -p "$(echo -e "${YELLOW}?${NC} $prompt [y/N] ")" ans
    [[ "$ans" =~ ^[Yy]$ ]]
}

# ─── 通用：执行远程 PG 查询（带密码） ──────────────────────────────
target_psql() {
    PGPASSWORD="$TARGET_PASSWORD" psql \
        -h "$TARGET_HOST" -p "$TARGET_PORT" \
        -U "$TARGET_USER" -d "$TARGET_DB" \
        -v ON_ERROR_STOP=1 \
        "$@"
}

# ═══════════════════════════════════════════════════════════════════
# Stage 0 · 环境检查
# ═══════════════════════════════════════════════════════════════════
check_prereqs() {
    log_step "Stage 0 · 环境检查"

    local fail=0

    # pg 工具
    for tool in pg_dump pg_restore psql; do
        if command -v "$tool" &>/dev/null; then
            local ver
            ver=$("$tool" --version | head -1)
            log_ok "$tool: $ver"
        else
            log_err "缺少 $tool"
            echo "     brew install libpq && brew link --force libpq"
            fail=1
        fi
    done

    # 版本检查：pg_dump >= 15（Supabase 是 15）
    if command -v pg_dump &>/dev/null; then
        local major
        major=$(pg_dump --version | grep -oE '[0-9]+' | head -1)
        if [[ "$major" -lt 15 ]]; then
            log_err "pg_dump 版本过低（$major），需要 >= 15"
            echo "     brew install libpq && brew link --force libpq"
            fail=1
        fi
    fi

    [[ $fail -ne 0 ]] && exit 1

    # 必填参数
    case "$MODE" in
        all|dump-only)
            [[ -z "$SOURCE_URL" ]] && { log_err "--source-url 必填"; exit 2; }
            ;;
    esac
    case "$MODE" in
        all|restore-only|verify)
            [[ -z "$TARGET_HOST" ]]     && { log_err "--target-host 必填"; exit 2; }
            [[ -z "$TARGET_PASSWORD" ]] && { log_err "--target-password 必填"; exit 2; }
            ;;
        all|transfer-only)
            [[ -z "$TARGET_HOST" ]]     && { log_err "--target-host 必填"; exit 2; }
            ;;
    esac

    log_ok "参数校验通过"
    log_info "工作目录：$WORK_DIR"
    log_info "运行模式：$MODE"
}

# ═══════════════════════════════════════════════════════════════════
# Stage 1 · 从云端 dump
# ═══════════════════════════════════════════════════════════════════
do_dump() {
    log_step "Stage 1 · 从 Supabase Cloud 拉取 dump"

    # 先 ping 一下源库，拿基础信息
    log_info "连接云端测试..."
    local cloud_info
    cloud_info=$(psql "$SOURCE_URL" -Atc "SELECT version();" 2>&1) || {
        log_err "连不上云端 Supabase，请检查 --source-url 和网络"
        echo "$cloud_info"
        exit 3
    }
    log_ok "连接成功：${cloud_info:0:60}..."

    # 预估数据量（方便估计耗时）
    log_info "预估数据规模..."
    local klines_count
    klines_count=$(psql "$SOURCE_URL" -Atc "SELECT count(*) FROM public.klines_all;" 2>/dev/null || echo "?")
    log_info "  klines_all: ${klines_count} 行（参考值）"

    # 构造 --schema 参数
    local schema_args=()
    for s in "${DUMP_SCHEMAS[@]}"; do
        schema_args+=(--schema="$s")
    done

    log_info "开始 pg_dump（custom format, 并行 $JOBS）..."
    log_info "包含 schema: ${DUMP_SCHEMAS[*]}"
    log_info "目标文件：$DUMP_FILE"
    echo ""

    # custom format + 并行 job 最快
    # --no-owner/--no-acl：剥掉云端的 role 归属，恢复时不会因 role 不存在而报错
    pg_dump "$SOURCE_URL" \
        --format=directory \
        --jobs="$JOBS" \
        --no-owner \
        --no-acl \
        --no-comments \
        --verbose \
        "${schema_args[@]}" \
        --file="${DUMP_FILE%.dump}.dir" \
        2>&1 | awk '/^pg_dump: dumping contents/ { print "  " $0; next } /^pg_dump: /{ print "  " $0 }'

    # 并行 dump 产出的是目录，打个 tar 方便传输
    log_info "压缩 dump 目录..."
    tar -czf "$DUMP_FILE" -C "$(dirname "${DUMP_FILE%.dump}.dir")" "$(basename "${DUMP_FILE%.dump}.dir")"
    rm -rf "${DUMP_FILE%.dump}.dir"

    # 生成 manifest（记下关键行数，用于之后 verify 对比）
    log_info "生成 manifest..."
    {
        echo "# InvestDojo Supabase Cloud Dump Manifest"
        echo "# 生成于: $(date '+%Y-%m-%d %H:%M:%S')"
        echo "# 源: $SOURCE_URL" | sed 's#://[^@]*@#://***@#'
        echo "# Dump: $DUMP_FILE"
        echo ""
        echo "## 表行数（public schema）"
        psql "$SOURCE_URL" -At <<'SQL'
SELECT format('%-35s %s',
              schemaname || '.' || relname,
              n_live_tup)
FROM pg_stat_user_tables
WHERE schemaname IN ('public', 'auth')
ORDER BY schemaname, relname;
SQL
    } > "$MANIFEST_FILE"

    ln -sf "$DUMP_FILE" "$LATEST_LINK"

    local size
    size=$(du -h "$DUMP_FILE" | cut -f1)
    log_ok "Dump 完成：$DUMP_FILE ($size)"
    log_ok "Manifest：$MANIFEST_FILE"
    echo ""
    log_info "Manifest 预览（前 20 行）："
    head -20 "$MANIFEST_FILE" | sed 's/^/    /'
}

# ═══════════════════════════════════════════════════════════════════
# Stage 2 · 传输到 Windows
# ═══════════════════════════════════════════════════════════════════
do_transfer() {
    log_step "Stage 2 · 传输 dump 到 Windows"

    [[ ! -f "$DUMP_FILE" ]] && {
        # 尝试用 latest 链接
        if [[ -L "$LATEST_LINK" && -f "$(readlink -f "$LATEST_LINK")" ]]; then
            DUMP_FILE="$(readlink -f "$LATEST_LINK")"
            log_info "使用最近的 dump：$DUMP_FILE"
        else
            log_err "找不到 dump 文件：$DUMP_FILE"
            log_err "请先用 --mode dump-only 生成"
            exit 4
        fi
    }

    local method="$TRANSFER_METHOD"

    # auto 模式：探测 SSH 是否可用
    if [[ "$method" == "auto" ]]; then
        if command -v ssh &>/dev/null && timeout 3 bash -c "exec 3<>/dev/tcp/$TARGET_HOST/22" 2>/dev/null; then
            method="scp"
            log_info "探测到 SSH 可用，使用 scp"
        else
            method="skip"
            log_warn "未探测到 SSH，跳过自动传输"
        fi
    fi

    local size
    size=$(du -h "$DUMP_FILE" | cut -f1)
    log_info "待传文件：$DUMP_FILE ($size)"

    case "$method" in
        scp)
            local remote_user="${SSH_USER:-$(whoami)}"
            local remote_path="C:/Users/$remote_user/investdojo-migrate"
            log_info "传输目标：${remote_user}@${TARGET_HOST}:${remote_path}"

            # 远端建目录
            ssh "${remote_user}@${TARGET_HOST}" "mkdir -p \"$remote_path\"" || {
                log_err "SSH 连接或建目录失败"
                exit 5
            }

            # scp 带进度条
            scp -p "$DUMP_FILE" "${remote_user}@${TARGET_HOST}:${remote_path}/" || {
                log_err "scp 失败"
                exit 5
            }

            # 也传 manifest
            [[ -f "$MANIFEST_FILE" ]] && scp -p "$MANIFEST_FILE" "${remote_user}@${TARGET_HOST}:${remote_path}/" || true

            REMOTE_DUMP_PATH="$remote_path/$(basename "$DUMP_FILE")"
            log_ok "传输完成：$REMOTE_DUMP_PATH"
            ;;

        skip)
            log_warn "跳过自动传输。请手动把下列文件拷到 Windows："
            echo "  文件：$DUMP_FILE"
            echo ""
            echo "  可选方式："
            echo "    a) Windows 开 SMB 共享，Mac Finder → 前往 → 连接服务器 → smb://$TARGET_HOST"
            echo "    b) 用 U 盘 / iCloud / OneDrive"
            echo "    c) Windows 装 OpenSSH Server 后重跑本脚本（--transfer-method scp）"
            echo ""
            if [[ "$MODE" == "all" ]]; then
                log_err "在 --mode all 下无法自动继续 restore，请手动传输后用 --mode restore-only"
                exit 6
            fi
            ;;

        *)
            log_err "未知 --transfer-method: $method"
            exit 2
            ;;
    esac
}

# ═══════════════════════════════════════════════════════════════════
# Stage 3 · 在 Windows 上恢复
# ═══════════════════════════════════════════════════════════════════
do_restore() {
    log_step "Stage 3 · 在 Windows Postgres 上 restore"

    # 探活
    log_info "ping Windows PG..."
    if ! PGPASSWORD="$TARGET_PASSWORD" psql \
            -h "$TARGET_HOST" -p "$TARGET_PORT" \
            -U "$TARGET_USER" -d "$TARGET_DB" \
            -Atc "SELECT 1;" &>/dev/null; then
        log_err "连不上 Windows Postgres（$TARGET_HOST:$TARGET_PORT）"
        log_err "排查清单："
        echo "  1) Windows 上 docker compose ps 看 db 是否 healthy"
        echo "  2) Windows 防火墙放行 5432（Private profile）"
        echo "  3) --target-password 对不对"
        echo "  4) pg_hba.conf 允许你这台 Mac 所在子网"
        exit 7
    fi
    log_ok "Windows PG 可连"

    # 空库检查（防误覆盖）
    log_info "检查目标库是否空..."
    local existing
    existing=$(target_psql -Atc "
        SELECT count(*) FROM pg_stat_user_tables
        WHERE schemaname = 'public'
          AND relname = 'klines_all'
          AND n_live_tup > 0;
    " 2>/dev/null || echo "0")

    if [[ "$existing" != "0" ]]; then
        log_warn "目标库的 klines_all 已有数据（n_live_tup > 0）"
        log_warn "继续会执行 --clean 先 drop 再建，会永久丢失当前数据"
        confirm "真的要继续覆盖吗？" || { log_info "已取消"; exit 0; }
    else
        log_ok "目标库干净，可以放心恢复"
    fi

    # 定位 dump 文件
    # 如果本地有 DUMP_FILE 就直接通过 psql 从本地流式 restore
    # 但 pg_restore --format=directory 要求目录直接可见，所以分两种情况：
    #   a) 如果是通过 scp 传到 Windows 上的 dump → 在 Windows 本机用 pg_restore
    #   b) 如果 dump 还在 Mac 上 → 先解压，再走远程 pg_restore
    local restore_source
    if [[ -n "${REMOTE_DUMP_PATH:-}" ]]; then
        # 走 SSH 在 Windows 端本地 restore（最快，最稳）
        log_info "在 Windows 端执行 pg_restore（通过 SSH）..."
        local remote_user="${SSH_USER:-$(whoami)}"
        local remote_dir="${REMOTE_DUMP_PATH%.dump}.dir"

        ssh "${remote_user}@${TARGET_HOST}" bash -s <<EOF
set -e
cd "$(dirname "$REMOTE_DUMP_PATH")"
# 解压 tar.gz
tar -xzf "$(basename "$REMOTE_DUMP_PATH")"
# 本机 pg_restore（容器 db 的 5432 已经 expose 到 localhost）
PGPASSWORD='$TARGET_PASSWORD' pg_restore \
    -h localhost -p $TARGET_PORT \
    -U $TARGET_USER -d $TARGET_DB \
    --jobs=$JOBS \
    --clean --if-exists \
    --no-owner --no-acl \
    --verbose \
    "\$(basename "$(basename "$REMOTE_DUMP_PATH" .dump).dir")"
EOF

    else
        # Mac 上解压后远程 pg_restore
        log_info "在 Mac 本地解压后远程 restore..."
        local local_dir="${DUMP_FILE%.dump}.dir"
        if [[ ! -d "$local_dir" ]]; then
            tar -xzf "$DUMP_FILE" -C "$(dirname "$DUMP_FILE")"
        fi

        PGPASSWORD="$TARGET_PASSWORD" pg_restore \
            -h "$TARGET_HOST" -p "$TARGET_PORT" \
            -U "$TARGET_USER" -d "$TARGET_DB" \
            --jobs="$JOBS" \
            --clean --if-exists \
            --no-owner --no-acl \
            --verbose \
            "$local_dir" 2>&1 | awk '/^pg_restore: /{ print "  " $0 }'
    fi

    log_ok "pg_restore 完成"

    # 关键：恢复 search_path、analyze
    log_info "ANALYZE（刷新统计信息）..."
    target_psql -c "ANALYZE;" >/dev/null
    log_ok "ANALYZE 完成"
}

# ═══════════════════════════════════════════════════════════════════
# Stage 4 · 校验
# ═══════════════════════════════════════════════════════════════════
do_verify() {
    log_step "Stage 4 · 数据校验"

    log_info "连接 Windows PG..."
    target_psql -Atc "SELECT 1;" >/dev/null || {
        log_err "连不上目标库，先排查"
        exit 8
    }
    log_ok "连接成功"

    echo ""
    echo "  ┌─────────────────────────────────┬──────────────┬──────────────┐"
    printf "  │ %-31s │ %12s │ %-12s │\n" "表" "实际行数" "基准 (docs)"
    echo "  ├─────────────────────────────────┼──────────────┼──────────────┤"

    # 基准来自 docs/product/99_MVP_Sprint0.md §T-1.0x
    # 注意：basin 值会随业务推进增长，只作"下限"校验
    declare -a checks=(
        "public.symbols|5524"
        "public.industries|102"
        "public.klines_all|5712896"      # 5,603,772 日K + 108,144 5m + 老 72,980（有重叠）
        "public.news|49"
        "public.market_snapshots|2995"
        "public.scenarios|4"
        "public.factor_definitions|5"
    )

    local fail=0
    for row in "${checks[@]}"; do
        local table="${row%|*}"
        local expected="${row#*|}"
        local actual
        actual=$(target_psql -Atc "SELECT count(*) FROM $table;" 2>/dev/null || echo "ERR")

        local status_icon="${GREEN}✓${NC}"
        if [[ "$actual" == "ERR" ]]; then
            status_icon="${RED}✗${NC}"
            fail=1
        elif [[ "$actual" -lt $((expected * 80 / 100)) ]]; then
            # 实际行数 < 基准的 80%，视为异常
            status_icon="${RED}✗${NC}"
            fail=1
        elif [[ "$actual" -lt "$expected" ]]; then
            status_icon="${YELLOW}!${NC}"
        fi

        printf "  │ %-31s │ %12s │ %12s │ $status_icon\n" "$table" "$actual" "$expected"
    done
    echo "  └─────────────────────────────────┴──────────────┴──────────────┘"
    echo ""

    # RLS 开启情况
    log_info "RLS 启用表数（基准 14）..."
    local rls_count
    rls_count=$(target_psql -Atc "
        SELECT count(*) FROM pg_tables
        WHERE schemaname = 'public' AND rowsecurity = true;
    ")
    if [[ "$rls_count" -ge 14 ]]; then
        log_ok "RLS 表数：$rls_count"
    else
        log_warn "RLS 表数：$rls_count（基准 14，请检查 005_rls_policies.sql 是否生效）"
        fail=1
    fi

    # auth.users 条数
    log_info "auth.users 用户数..."
    local users_count
    users_count=$(target_psql -Atc "SELECT count(*) FROM auth.users;" 2>/dev/null || echo "0")
    log_ok "auth.users：$users_count"

    # 分区表检查
    log_info "feature_values 分区数（基准 17，2014-2030）..."
    local parts
    parts=$(target_psql -Atc "
        SELECT count(*) FROM pg_inherits
        WHERE inhparent = 'public.feature_values'::regclass;
    " 2>/dev/null || echo "0")
    if [[ "$parts" -ge 17 ]]; then
        log_ok "feature_values 分区数：$parts"
    else
        log_warn "feature_values 分区数：$parts（基准 17）"
    fi

    # 核心业务抽样（防未来函数的 as_of 关键）
    log_info "抽样校验：茅台 2024-04-01 日K..."
    local mt_open
    mt_open=$(target_psql -Atc "
        SELECT open FROM public.klines_all
        WHERE symbol = 'sh.600519' AND timeframe = '1d' AND dt::date = '2024-04-01'
        LIMIT 1;
    " 2>/dev/null || echo "")
    if [[ -n "$mt_open" ]]; then
        log_ok "茅台 2024-04-01 开盘：$mt_open（基准 1601.87）"
    else
        log_warn "没找到茅台 2024-04-01 的数据（symbol 格式可能是 '600519' 不是 'sh.600519'）"
    fi

    echo ""
    if [[ $fail -eq 0 ]]; then
        log_ok "${BOLD}校验通过 🎉${NC}"
    else
        log_err "${BOLD}校验有异常，请查看上面的 ✗ 或 !${NC}"
        return 1
    fi
}

# ═══════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════
main() {
    echo -e "${BOLD}${BLUE}"
    cat <<'BANNER'
  ╔═══════════════════════════════════════════════════════════╗
  ║   InvestDojo · Supabase Cloud → Windows 本地 数据迁移     ║
  ╚═══════════════════════════════════════════════════════════╝
BANNER
    echo -e "${NC}"

    check_prereqs

    # 预估耗时警示
    if [[ "$MODE" == "all" && "$SKIP_CONFIRM" != "true" ]]; then
        echo ""
        log_warn "即将执行完整流程（dump → transfer → restore → verify）"
        log_warn "预计总耗时：家用百兆 40-60 分钟；千兆 10-15 分钟"
        log_warn "云端只做只读快照，不影响线上使用"
        echo ""
        confirm "开始？" || { log_info "已取消"; exit 0; }
    fi

    case "$MODE" in
        all)
            do_dump
            do_transfer
            do_restore
            do_verify
            ;;
        dump-only)      do_dump ;;
        transfer-only)  do_transfer ;;
        restore-only)   do_restore ;;
        verify)         do_verify ;;
        *)
            log_err "未知 --mode: $MODE"
            usage
            exit 2
            ;;
    esac

    echo ""
    log_step "✅ 完成"
    if [[ "$MODE" == "all" || "$MODE" == "verify" ]]; then
        log_info "下一步："
        echo "    1. 修改 Mac 上 investdojo/python-services/.env："
        echo "         SUPABASE_URL=http://$TARGET_HOST:8000"
        echo "         SUPABASE_SERVICE_ROLE_KEY=<Windows .env 里新生成的>"
        echo "    2. cd investdojo && make dev  # 重启 Python 服务"
        echo "    3. make test-integration     # 跑集成测试验收"
    fi
}

main "$@"
