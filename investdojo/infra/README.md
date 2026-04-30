# InvestDojo 基础设施（Infrastructure）

> 对应任务：[T-0.01](../docs/product/99_MVP_Sprint0.md#t-001---docker-compose-基础设施)
> 对应架构文档：[架构 §9](../docs/architecture/00_系统总览.md#9-开发环境与工作流)

本目录包含 InvestDojo 本地开发所需的基础设施：**Redis + MinIO**。
通过 Docker Compose 一键启停。

---

## 目录结构

```
infra/
├── docker-compose.yml    ← 服务定义（Redis + MinIO）
├── .env.example          ← 环境变量模板
├── .gitignore            ← 不提交数据目录
├── scripts/
│   ├── dev-up.sh         ← 启动
│   ├── dev-down.sh       ← 停止
│   ├── dev-reset.sh      ← 重置（清数据）
│   └── dev-status.sh     ← 健康检查
├── redis-data/           ← Redis 持久化（git 忽略）
└── minio-data/           ← MinIO 数据（git 忽略）
```

---

## 前置要求

### Docker 运行时

需要任一 Docker 引擎：

- **OrbStack**（推荐，Mac 专用，轻量）
  ```bash
  brew install orbstack
  open /Applications/OrbStack.app   # 首次打开完成设置
  ```

- **Docker Desktop**：https://www.docker.com/products/docker-desktop/

- **Colima**（社区开源，轻量）
  ```bash
  brew install colima docker docker-compose
  colima start
  ```

### 验证

```bash
docker --version          # Docker 20+
docker compose version    # Docker Compose v2+
```

---

## 快速开始

```bash
# 1. 启动全部服务
./scripts/dev-up.sh

# 2. 健康检查
./scripts/dev-status.sh

# 3. 打开 MinIO 控制台
open http://localhost:9001
# 用户名：investdojo
# 密码：  investdojo_dev_only
```

---

## 服务清单

| 服务 | 端口 | 用途 |
|------|------|------|
| Redis | 6379 | 缓存 / Pub/Sub / Celery broker |
| MinIO S3 API | 9000 | 模型文件 / 回测报告 / Notebook |
| MinIO Console | 9001 | Web 管理界面 |

### 预置 Bucket

启动时自动创建（在 `investdojo` bucket 下）：

- `models/` 模型文件
- `backtests/` 回测报告
- `notebooks/` Notebook 快照
- `exports/` 用户数据导出
- `klines_archive/` 分钟级 K 线归档

详见 [数据层 §9](../docs/architecture/01_数据层.md#9-对象存储minios3)。

---

## 日常操作

### 启动

```bash
./scripts/dev-up.sh
```

### 停止（保留数据）

```bash
./scripts/dev-down.sh
```

### 健康检查

```bash
./scripts/dev-status.sh
```

输出示例：
```
Docker daemon       ✓ 就绪
Redis 容器          ✓ 运行中
MinIO 容器          ✓ 运行中
Redis 连接测试      ✓ PONG
MinIO 健康          ✓ live
MinIO Console       ✓ 可访问
MinIO buckets       ✓ investdojo/
✅ 所有核心服务就绪
```

### 重置（⚠️ 清空所有数据）

```bash
./scripts/dev-reset.sh
```

会删除 Redis 和 MinIO 的所有本地数据。**不影响云端 Supabase**。

---

## 连接示例

### Redis（Python）

```python
import redis
r = redis.from_url("redis://localhost:6379/0")
r.set("hello", "world")
print(r.get("hello"))  # b'world'
```

### MinIO（Python）

```python
from minio import Minio
client = Minio(
    "localhost:9000",
    access_key="investdojo",
    secret_key="investdojo_dev_only",
    secure=False,
)
client.list_buckets()
```

### Redis（Node.js）

```javascript
import { createClient } from 'redis';
const client = await createClient({ url: 'redis://localhost:6379' }).connect();
await client.set('hello', 'world');
```

### MinIO（Node.js）

```javascript
import { S3Client } from '@aws-sdk/client-s3';
const s3 = new S3Client({
  endpoint: 'http://localhost:9000',
  region: 'us-east-1',
  credentials: { accessKeyId: 'investdojo', secretAccessKey: 'investdojo_dev_only' },
  forcePathStyle: true,
});
```

---

## 资源占用

OrbStack 下实测（Apple Silicon）：

| 服务 | 内存（空载） | 内存（满载） | CPU |
|------|------------|------------|-----|
| Redis | ~10 MB | ~100 MB | 极低 |
| MinIO | ~80 MB | ~200 MB | 低 |
| OrbStack VM | ~300 MB | - | - |
| **合计** | **~400 MB** | **~600 MB** | **<5%** |

比 Docker Desktop 轻约 2x。

---

## 故障排查

### `docker: command not found`
未安装 Docker 引擎。装 OrbStack：`brew install orbstack`。

### `Cannot connect to the Docker daemon`
Docker 引擎未启动。打开 OrbStack.app 或运行 `colima start`。

### 端口冲突（6379 / 9000 / 9001 已占用）
查占用：`lsof -i :6379`
要么停掉占用的进程，要么改 `docker-compose.yml` 里的端口映射。

### MinIO 控制台打不开
1. 先跑 `./scripts/dev-status.sh` 看各项状态
2. 看容器日志：`docker logs investdojo-minio`
3. 重启：`./scripts/dev-down.sh && ./scripts/dev-up.sh`

### 重置后还是有旧数据
```bash
# 强制清理
docker compose down -v
rm -rf redis-data minio-data
./scripts/dev-up.sh
```

---

## 下一步

基础设施就位后：
- **T-0.02 Python 服务骨架**：开始搭 FastAPI 微服务
- **T-0.03 共享 Python 库**：Supabase/Redis/MinIO 客户端封装
- **T-1.01 数据层迁移 SQL**：执行新表创建和现有表改造

详见 [MVP Sprint 0 任务拆解](../docs/product/99_MVP_Sprint0.md)。
