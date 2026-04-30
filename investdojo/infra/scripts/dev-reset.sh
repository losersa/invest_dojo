#!/usr/bin/env bash
# ──────────────────────────────────────────
# InvestDojo 本地基础设施 · 重置（危险！清数据）
# ──────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(dirname "$SCRIPT_DIR")"
cd "$INFRA_DIR"

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m'

echo -e "${RED}⚠️  此操作将清空所有本地数据：${NC}"
echo "  - Redis（所有 key）"
echo "  - MinIO（所有 bucket/object）"
echo ""
echo -e "${YELLOW}本操作不影响云端 Supabase 数据。${NC}"
echo ""
read -p "确定继续？(输入 yes 确认): " answer

if [ "$answer" != "yes" ]; then
  echo "已取消"
  exit 0
fi

echo ""
echo "停止并删除容器..."
docker compose down -v

echo "删除数据目录..."
rm -rf redis-data/* minio-data/* 2>/dev/null || true

echo -e "${GREEN}✓ 重置完成${NC}"
echo ""
echo "  重新启动：./scripts/dev-up.sh"
