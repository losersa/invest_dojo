#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# InvestDojo · 数据还原（在【devcloud】上运行）
#
# 作用：把 migrate_dump_source.sh 产出的 .dump 文件还原进本地 Postgres 容器。
#
# 前置：
#   - 已运行过 infra/supabase-lite/scripts/up.sh（db 已起、init SQL 已跑）
#   - 传入的 dump 文件存在
#
# 用法：
#   ./scripts/migrate_restore_devcloud.sh /path/to/investdojo-data.dump
#
# 原理：把 dump 拷进 db 容器挂载的 /backup 目录，再用容器内 pg_restore 还原。
#   --clean --if-exists 会先 drop 再建，覆盖 init 产生的空结构，不碰 init 建的 role。
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

DUMP="${1:?用法: $0 <dump文件>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK="$ROOT/infra/supabase-lite"
BACKUP_DIR="$STACK/data/db-backup"
DUMP_IN_CONTAINER="/backup/investdojo-data.dump"

if [[ ! -f "$DUMP" ]]; then echo "❌ 找不到 dump 文件: $DUMP"; exit 1; fi

cd "$STACK"

# 1) 放到 db 容器挂载的 /backup
mkdir -p "$BACKUP_DIR"
cp "$DUMP" "$BACKUP_DIR/investdojo-data.dump"
echo "▶ 已放入容器挂载目录: $BACKUP_DIR/investdojo-data.dump"

# 2) 还原（容器内 pg_restore，本地 trust 连接无需密码）
echo "▶ pg_restore --clean --if-exists ..."
docker compose exec -T db pg_restore -U postgres \
  --no-owner --no-acl --clean --if-exists \
  -d postgres "$DUMP_IN_CONTAINER"

# 3) 刷新统计
docker compose exec -T db psql -U postgres -d postgres -c "ANALYZE;"

echo "✅ 还原完成"
echo "   校验行数：docker compose exec -T db psql -U postgres -d postgres -c \"SELECT count(*) FROM public.klines_all;\""
