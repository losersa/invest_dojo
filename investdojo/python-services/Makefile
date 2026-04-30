# ──────────────────────────────────────────
# InvestDojo Python 微服务 · Makefile
# ──────────────────────────────────────────

SHELL := /bin/bash
.DEFAULT_GOAL := help
.PHONY: help install dev down status test lint format clean smoke

# 颜色
CYAN  := \033[36m
GREEN := \033[32m
RESET := \033[0m

help:  ## 显示帮助
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  $(CYAN)%-15s$(RESET) %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install:  ## 安装依赖（uv sync）
	uv sync
	@echo ""
	@echo "$(GREEN)✓$(RESET) 依赖安装完成"

dev:  ## 并行启动所有 5 个服务（用 overmind）
	@command -v overmind >/dev/null || (echo "请先 brew install overmind" && exit 1)
	@echo "$(GREEN)启动 5 个服务...$(RESET)"
	@echo "  feature-svc   :8001"
	@echo "  train-svc     :8002"
	@echo "  infer-svc     :8003"
	@echo "  backtest-svc  :8004"
	@echo "  monitor-svc   :8005"
	@echo ""
	OVERMIND_NO_PORT=1 overmind start -f Procfile

down:  ## 停止 overmind
	@overmind quit 2>/dev/null || echo "没有在跑的 overmind 实例"

status:  ## 检查 5 个服务的 /health
	@echo "$(CYAN)检查服务健康状态...$(RESET)"
	@for svc in "feature:8001" "train:8002" "infer:8003" "backtest:8004" "monitor:8005"; do \
		name=$${svc%%:*}; port=$${svc##*:}; \
		if curl -sf -m 3 http://localhost:$$port/health >/dev/null 2>&1; then \
			echo "  $(GREEN)✓$(RESET) $$name-svc   :$$port  http://localhost:$$port/docs"; \
		else \
			echo "  ✗ $$name-svc   :$$port  未响应"; \
		fi \
	done

smoke:  ## 冒烟测试（启动 → 查 health → 停止）
	@bash scripts/smoke.sh

test:  ## 运行所有 pytest（含 integration）
	PYTHONPATH=. .venv/bin/pytest -v

test-unit:  ## 只跑单元测试（不依赖外部，CI 用）
	PYTHONPATH=. .venv/bin/pytest -v -m "not integration"

test-integration:  ## 跑集成测试（依赖真实 Supabase/Redis/MinIO）
	PYTHONPATH=. .venv/bin/pytest -v -m integration

typecheck:  ## mypy 类型检查
	PYTHONPATH=. .venv/bin/mypy common --ignore-missing-imports --no-error-summary || true

lint:  ## ruff 检查
	.venv/bin/ruff check .

format:  ## ruff 格式化
	.venv/bin/ruff format .
	.venv/bin/ruff check --fix .

ci:  ## CI 完整流程（lint + typecheck + unit test）
	$(MAKE) lint
	$(MAKE) typecheck
	$(MAKE) test-unit

clean:  ## 清理缓存
	find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name ".pytest_cache" -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name ".ruff_cache" -exec rm -rf {} + 2>/dev/null || true
	@echo "$(GREEN)✓$(RESET) 已清理"
