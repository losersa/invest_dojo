#!/usr/bin/env bash
# ──────────────────────────────────────────
# InvestDojo 基础设施 · 健康检查
# ──────────────────────────────────────────
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(dirname "$SCRIPT_DIR")"
cd "$INFRA_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  InvestDojo 基础设施健康检查${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

ALL_OK=1

# Docker
echo -n "Docker daemon       "
if docker info &>/dev/null; then
  echo -e "${GREEN}✓ 就绪${NC}"
else
  echo -e "${RED}✗ 未运行${NC}"
  ALL_OK=0
fi

# 容器
echo -n "Redis 容器          "
if docker ps --format '{{.Names}}' | grep -q investdojo-redis; then
  echo -e "${GREEN}✓ 运行中${NC}"
else
  echo -e "${RED}✗ 未运行${NC}"
  ALL_OK=0
fi

echo -n "MinIO 容器          "
if docker ps --format '{{.Names}}' | grep -q investdojo-minio; then
  echo -e "${GREEN}✓ 运行中${NC}"
else
  echo -e "${RED}✗ 未运行${NC}"
  ALL_OK=0
fi

# Redis ping
echo -n "Redis 连接测试       "
if docker compose exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; then
  echo -e "${GREEN}✓ PONG${NC}"
else
  echo -e "${RED}✗ 无响应${NC}"
  ALL_OK=0
fi

# MinIO health
echo -n "MinIO 健康           "
if curl -sf http://localhost:9000/minio/health/live &>/dev/null; then
  echo -e "${GREEN}✓ live${NC}"
else
  echo -e "${RED}✗ 无响应${NC}"
  ALL_OK=0
fi

# MinIO console
echo -n "MinIO Console        "
if curl -sf -o /dev/null http://localhost:9001 &>/dev/null; then
  echo -e "${GREEN}✓ 可访问${NC}"
else
  echo -e "${YELLOW}✗ 无响应（不影响 API 使用）${NC}"
fi

# Bucket 检查
echo -n "MinIO buckets        "
source .env 2>/dev/null || true
BUCKET_USER="${MINIO_ROOT_USER:-investdojo}"
BUCKET_PASS="${MINIO_ROOT_PASSWORD:-investdojo_dev_only}"
BUCKETS=$(docker run --rm --network host \
  -e MC_HOST_local="http://${BUCKET_USER}:${BUCKET_PASS}@localhost:9000" \
  minio/mc:latest ls local 2>/dev/null | awk '{print $NF}' | tr '\n' ' ')
if [ -n "$BUCKETS" ]; then
  echo -e "${GREEN}✓ $BUCKETS${NC}"
else
  echo -e "${YELLOW}⚠ 无 bucket（运行 dev-up.sh 初始化）${NC}"
fi

echo ""
if [ "$ALL_OK" = "1" ]; then
  echo -e "${GREEN}✅ 所有核心服务就绪${NC}"
  exit 0
else
  echo -e "${RED}❌ 部分服务未就绪${NC}"
  exit 1
fi
