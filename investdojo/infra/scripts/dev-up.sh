#!/usr/bin/env bash
# ──────────────────────────────────────────
# InvestDojo 本地基础设施 · 启动
# ──────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(dirname "$SCRIPT_DIR")"
cd "$INFRA_DIR"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  InvestDojo 基础设施启动${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# 1. 检查 docker
if ! command -v docker &>/dev/null; then
  echo -e "${RED}❌ 未检测到 docker 命令${NC}"
  echo "   请安装 OrbStack: brew install orbstack"
  echo "   或 Docker Desktop"
  exit 1
fi

if ! docker info &>/dev/null; then
  echo -e "${RED}❌ Docker 守护进程未运行${NC}"
  echo "   请打开 OrbStack.app 或 Docker Desktop"
  exit 1
fi

echo -e "${GREEN}✓${NC} Docker 就绪"

# 2. 检查 .env
if [ ! -f .env ]; then
  echo -e "${YELLOW}⚠${NC}  未发现 .env，从 .env.example 复制"
  cp .env.example .env
fi

# 3. 启动服务
echo ""
echo "启动容器..."
docker compose up -d

# 4. 等待 Redis 就绪
echo ""
echo -n "等待 Redis 就绪 "
for i in {1..30}; do
  if docker compose exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; then
    echo -e " ${GREEN}✓${NC}"
    break
  fi
  echo -n "."
  sleep 1
done

# 5. 等待 MinIO 就绪
echo -n "等待 MinIO 就绪 "
for i in {1..30}; do
  if curl -sf http://localhost:9000/minio/health/live &>/dev/null; then
    echo -e " ${GREEN}✓${NC}"
    break
  fi
  echo -n "."
  sleep 1
done

# 6. 显示状态
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✅ 所有服务已就绪${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Redis          redis://localhost:6379"
echo "  MinIO S3 API   http://localhost:9000"
echo "  MinIO Console  http://localhost:9001"

# 从 .env 读取 MinIO 凭证用于展示
if [ -f .env ]; then
  source .env 2>/dev/null || true
fi
echo "  MinIO User     ${MINIO_ROOT_USER:-investdojo}"
echo "  MinIO Pass     ${MINIO_ROOT_PASSWORD:-investdojo_dev_only}"
echo ""
echo "  停止：./scripts/dev-down.sh"
echo "  重置（清数据）：./scripts/dev-reset.sh"
echo ""
