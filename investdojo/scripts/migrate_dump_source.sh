#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# InvestDojo · 数据源导出（在【数据所在的 Windows】上运行）
#
# 作用：把本地 docker 里的 Postgres（public / auth / storage 三套 schema）
#       导出为一个 .dump 文件，之后传到 devcloud 用 migrate_restore_devcloud.sh 还原。
#
# 前置：
#   - 该机器 docker / docker compose 正在运行（investdojo-db 容器存在）
#   - 在项目根目录运行（或用 PROJECT_DIR 指定）
#
# 用法：
#   ./scripts/migrate_dump_source.sh                         # 默认导出到 ~/investdojo-data.dump
#   ./scripts/migrate_dump_source.sh /path/to/out.dump       # 指定输出文件
#
# 注意（PowerShell 用户）：没有 Git Bash 时，等价命令是：
#   docker compose -f infra/supabase-lite/docker-compose.yml exec -T db `
#     pg_dump -U postgres --format=custom --no-owner --no-acl --no-comments `
#     --schema=public --schema=auth --schema=storage postgres > d:\investdojo-data.dump
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-$(pwd)}"
OUT="${1:-$HOME/investdojo-data.dump}"

cd "$PROJECT_DIR"

# 兼容 docker compose / docker-compose
if docker compose version >/dev/null 2>&1; then
  DC="docker compose -f infra/supabase-lite/docker-compose.yml"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose -f infra/supabase-lite/docker-compose.yml"
else
  echo "❌ 找不到 docker compose"; exit 1
fi

echo "▶ 导出 public / auth / storage 到 $OUT ..."
$DC exec -T db pg_dump -U postgres \
  --format=custom --no-owner --no-acl --no-comments \
  --schema=public --schema=auth --schema=storage \
  postgres > "$OUT"

echo "✅ 导出完成: $OUT ($(du -h "$OUT" | cut -f1))"
echo "   下一步：把该文件传到 devcloud，然后运行 migrate_restore_devcloud.sh <dump文件>"
