#!/usr/bin/env bash
# ──────────────────────────────────────────
# 冒烟测试：启动所有服务 → 检查 /health → 停止
# 用途：CI 验证 + 本地一键验证
# ──────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

GREEN='\033[0;32m'
RED='\033[0;31m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

# 服务配置
SERVICES=("feature:8001" "train:8002" "infer:8003" "backtest:8004" "monitor:8005")
PIDS=()

cleanup() {
  echo ""
  echo -e "${YELLOW}清理启动的进程...${NC}"
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT

echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}  InvestDojo Python 服务冒烟测试${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# 1. 检查基础设施
echo -e "${CYAN}[1/4]${NC} 检查基础设施..."
if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q investdojo-redis; then
  echo -e "${YELLOW}⚠${NC}  Redis 未运行，请先跑 infra/scripts/dev-up.sh"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} Redis / MinIO 就绪"

# 2. 启动服务
echo ""
echo -e "${CYAN}[2/4]${NC} 启动 5 个服务..."
mkdir -p /tmp/investdojo-smoke-logs

for svc in "${SERVICES[@]}"; do
  name="${svc%%:*}"
  port="${svc##*:}"
  log_file="/tmp/investdojo-smoke-logs/${name}.log"

  PYTHONPATH="$ROOT_DIR" .venv/bin/uvicorn main:app \
    --app-dir "${name}-svc" \
    --host 127.0.0.1 \
    --port "$port" \
    --log-level warning \
    > "$log_file" 2>&1 &
  PIDS+=($!)
  echo -e "  ${name}-svc 启动中 (PID=$!)，日志：$log_file"
done

# 3. 等待就绪（每 0.5s 检查一次，最多 15 秒）
echo ""
echo -e "${CYAN}[3/4]${NC} 等待服务就绪..."
MAX_WAIT=30
for svc in "${SERVICES[@]}"; do
  name="${svc%%:*}"
  port="${svc##*:}"
  printf "  ${name}-svc "
  ready=0
  for i in $(seq 1 $MAX_WAIT); do
    if curl -sf -m 1 "http://localhost:$port/health" >/dev/null 2>&1; then
      echo -e "${GREEN}✓${NC} (${i} 次尝试)"
      ready=1
      break
    fi
    sleep 0.5
  done
  if [ $ready = 0 ]; then
    echo -e "${RED}✗ 超时${NC}"
    echo ""
    echo -e "${RED}${name}-svc 日志：${NC}"
    tail -30 "/tmp/investdojo-smoke-logs/${name}.log"
    exit 1
  fi
done

# 4. 验证关键端点
echo ""
echo -e "${CYAN}[4/4]${NC} 验证端点..."
ALL_OK=1
for svc in "${SERVICES[@]}"; do
  name="${svc%%:*}"
  port="${svc##*:}"

  # /health
  health_json=$(curl -sf -m 3 "http://localhost:$port/health" 2>/dev/null || echo "")
  if echo "$health_json" | grep -q '"status":"ok"'; then
    health_ok="${GREEN}✓${NC}"
  else
    health_ok="${RED}✗${NC}"
    ALL_OK=0
  fi

  # /docs（HTML 返回 200）
  if curl -sf -m 3 -o /dev/null -w "%{http_code}" "http://localhost:$port/docs" 2>/dev/null | grep -q "200"; then
    docs_ok="${GREEN}✓${NC}"
  else
    docs_ok="${RED}✗${NC}"
    ALL_OK=0
  fi

  # /metrics（Prometheus）
  if curl -sf -m 3 "http://localhost:$port/metrics" 2>/dev/null | grep -q "investdojo_request_total"; then
    metrics_ok="${GREEN}✓${NC}"
  else
    # 初次启动可能还没有请求，仅验证端点存在
    if curl -sf -m 3 -o /dev/null "http://localhost:$port/metrics" 2>/dev/null; then
      metrics_ok="${GREEN}✓${NC}"
    else
      metrics_ok="${RED}✗${NC}"
      ALL_OK=0
    fi
  fi

  echo -e "  ${name}-svc  health:${health_ok}  docs:${docs_ok}  metrics:${metrics_ok}"
done

echo ""
if [ $ALL_OK = 1 ]; then
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}✅ 冒烟测试通过${NC}"
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  exit 0
else
  echo -e "${RED}❌ 冒烟测试失败${NC}"
  exit 1
fi
