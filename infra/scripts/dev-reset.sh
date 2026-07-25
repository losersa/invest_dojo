#!/usr/bin/env bash
# ──────────────────────────────────────────
# InvestDojo 本地基础设施 · 重置（危险！清数据）
# ──────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(dirname "$SCRIPT_DIR")"
# 基础设施已合并到 supabase-lite/docker-compose.yml（单一编排文件）
cd "$INFRA_DIR/supabase-lite"

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m'

echo -e "${RED}⚠️  此操作将清空本地缓存数据：${NC}"
echo "  - Redis（所有 key）"
echo "  - MinIO（所有 bucket/object）"
echo ""
echo -e "${YELLOW}Postgres 主库数据（./data/db）不在此脚本清理范围内。${NC}"
echo ""
read -p "确定继续？(输入 yes 确认): " answer

if [ "$answer" != "yes" ]; then
  echo "已取消"
  exit 0
fi

echo ""
echo "停止容器（保留 Postgres 卷）..."
docker compose down

echo "删除 Redis / MinIO 数据目录..."
rm -rf ../redis-data/* ../minio-data/* 2>/dev/null || true

echo -e "${GREEN}✓ 重置完成${NC}"
echo ""
echo "  重新启动：../supabase-lite/scripts/up.sh  或  ./scripts/dev-up.sh"
