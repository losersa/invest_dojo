# InvestDojo Python 服务集群

> 对应任务：[T-0.02](../../docs/product/99_MVP_Sprint0.md) ~ [T-0.03]
> 对应架构：[docs/architecture/00_系统总览.md](../../docs/architecture/00_系统总览.md)

Python 微服务集群，承载所有**重计算**工作。Node 负责编排，Python 负责计算。

---

## 📂 目录结构

```
python-services/
├── pyproject.toml          ← uv 管理的依赖
├── uv.lock                 ← 锁定版本
├── Procfile                ← overmind 启动配置
├── Makefile                ← 一键命令入口
├── .env.example            ← 环境变量模板
│
├── common/                 ← 共享库（所有服务 import）
│   ├── config.py           · pydantic-settings 统一配置
│   ├── logging.py          · structlog 结构化日志
│   ├── supabase_client.py  · Supabase REST 客户端（含分页修复）
│   ├── redis_client.py     · Redis sync/async 客户端 + Key 约定
│   ├── minio_client.py     · MinIO S3 客户端 + 路径约定
│   └── app.py              · FastAPI 工厂 + /health /metrics 底座
│
├── feature-svc/   :8001    因子计算服务（Epic 3）
├── train-svc/     :8002    模型训练服务（Epic 4）
├── infer-svc/     :8003    推理服务（Epic 6）
├── backtest-svc/  :8004    回测服务（Epic 4）
├── monitor-svc/   :8005    监控服务（Epic 8）
│
├── scripts/
│   └── smoke.sh            ← 冒烟测试（CI 用）
│
└── tests/                  ← pytest 单元测试
    ├── test_common.py
    └── test_supabase.py
```

---

## 🚀 快速开始

### 前置

- Python 3.11+（推荐 3.12）
- uv（`brew install uv`）
- overmind（`brew install overmind`）
- Docker 运行时（OrbStack / Docker Desktop）
- 基础设施已启动：`cd ../infra && ./scripts/dev-up.sh`

### 首次设置

```bash
cd python-services/

# 1. 装依赖（uv 会自动创建 .venv）
make install

# 2. 准备环境变量
cp .env.example .env
# 编辑 .env，特别是 Supabase key（可以从 ../apps/server/.env 复用）
```

### 日常启动

```bash
# 并行启动 5 个服务
make dev

# 另一个终端：健康检查
make status

# 停止
make down
```

输出示例：

```
启动 5 个服务...
  feature-svc   :8001
  train-svc     :8002
  infer-svc     :8003
  backtest-svc  :8004
  monitor-svc   :8005

✓ feature-svc   :8001  http://localhost:8001/docs
✓ train-svc     :8002  http://localhost:8002/docs
✓ infer-svc     :8003  http://localhost:8003/docs
✓ backtest-svc  :8004  http://localhost:8004/docs
✓ monitor-svc   :8005  http://localhost:8005/docs
```

---

## 🔍 每个服务自带

每个服务通过 `common.create_app()` 工厂构造，开箱即用：

| 端点 | 说明 |
|------|------|
| `GET /` | 服务名 + 端口 + 指引 |
| `GET /health` | 基础健康检查（liveness） |
| `GET /health/ready` | 就绪检查（检查 Redis/MinIO/Supabase 连通性） |
| `GET /docs` | Swagger UI |
| `GET /redoc` | ReDoc |
| `GET /openapi.json` | OpenAPI 规范 |
| `GET /metrics` | Prometheus 指标 |

---

## 🧪 测试

```bash
# 单元测试
make test

# lint
make lint

# 格式化
make format

# 冒烟测试（启动 → 检查所有端点 → 停止）
make smoke
```

当前测试覆盖：
- common 基础：配置加载、日志、Redis key 约定、FastAPI 工厂
- Supabase 客户端：filter 查询、count、**分页正确性**（验证 > 1000 行能完整拿回）

---

## 📐 开发规范

### 新增服务

1. 创建 `xxx-svc/` 目录
2. 写 `__init__.py` 和 `main.py`，用 `common.create_app()` 构造
3. 在 `Procfile` 添加一行
4. 在 `common/config.py` 添加端口配置

### 新增依赖

```bash
uv add some-package       # 生产依赖
uv add --dev pytest-mock  # 开发依赖
```

### 配置读取

**不要**直接读 `os.environ`，统一从 `common.settings` 获取：

```python
from common import settings, get_logger

logger = get_logger(__name__)
logger.info("starting", port=settings.feature_svc_port)
```

### 新建路由

```python
from fastapi import APIRouter

router = APIRouter(prefix="/api/v1/factors", tags=["factors"])

@router.get("")
async def list_factors(): ...
```

在 `main.py` 里挂载：

```python
app.include_router(router)
```

---

## 🛠 Makefile 命令参考

```
make help       显示帮助
make install    安装依赖
make dev        并行启动 5 个服务
make down       停止 overmind
make status     检查服务健康
make smoke      冒烟测试
make test       运行 pytest
make lint       ruff 检查
make format     ruff 格式化
make clean      清理缓存
```

---

## 🔧 故障排查

### `ModuleNotFoundError: No module named 'common'`

启动时需要把当前目录加到 PYTHONPATH。Procfile 和 smoke.sh 已经做了，但手动启动要注意：

```bash
PYTHONPATH=. .venv/bin/uvicorn main:app --app-dir feature-svc --port 8001
```

### `/health/ready` 返回 503

说明 Redis / MinIO / Supabase 之一不可用：

```bash
curl -s http://localhost:8001/health/ready | python3 -m json.tool
# 看 checks 字段哪个 false
```

修复：
- Redis/MinIO 不通 → `cd ../infra && ./scripts/dev-status.sh`
- Supabase 不通 → 检查 `.env` 中的 `SUPABASE_SERVICE_ROLE_KEY`

### 端口被占用

```bash
lsof -i :8001
kill -9 <PID>
```

### uv sync 慢

第一次会比较久（要装 fastapi/pandas/lightgbm 等），之后都秒级。
如果一直卡住，试试镜像源：

```bash
UV_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple uv sync
```

---

## 📚 下一步

- [T-0.03](../../docs/product/99_MVP_Sprint0.md) 共享 Python 库（大部分已完成，补充 as_of_enforcer 占位即可）
- [T-0.04](../../docs/product/99_MVP_Sprint0.md) CI 流水线
- Epic 1 数据层与采集（开始动实际业务）
