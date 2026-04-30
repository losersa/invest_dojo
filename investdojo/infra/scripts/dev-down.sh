#!/usr/bin/env bash
# ──────────────────────────────────────────
# InvestDojo 本地基础设施 · 停止
# ──────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(dirname "$SCRIPT_DIR")"
cd "$INFRA_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}停止 InvestDojo 基础设施...${NC}"
docker compose down
echo -e "${GREEN}✓ 已停止（数据保留）${NC}"
echo ""
echo "  重新启动：./scripts/dev-up.sh"
echo "  清空数据：./scripts/dev-reset.sh"
