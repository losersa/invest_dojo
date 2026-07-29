# InvestDojo 基础设施（自托管精简栈）

> **定位**：只跑代码实际依赖的 3 个组件（Postgres / Redis / MinIO），鉴权改用
> 自建轻量模块（data-svc `/api/v1/auth` + httpOnly Cookie `id_session`）。
> 已彻底移除 Supabase（PostgREST / GoTrue / Kong）。

---

## 🏗 架构

```
┌─────────────────────────────────────────────────────────┐
│  Next.js :3000（web）                                     │
│    /svc/<name> 同源代理 → 各 Python 微服务（:8001-8006）   │
└───────────────┬───────────────────────────────────────────┘
                │
   ┌────────────┼──────────────┬───────────────┐
   ▼            ▼              ▼               ▼
Postgres:5432  Redis:6379   MinIO:9000   Celery（异步任务）
（Python 微服务  （缓存/        （模型/报告/  ↑ broker=Redis
 直连，不经过   Pub-Sub/        Notebook）
 任何 Supabase  broker）                        │
 组件）                                         │
                                               ▼
                                    6 个 FastAPI 微服务
                              feature:8001 / train:8002 / infer:8003
                              backtest:8004 / monitor:8005 / data:8006
```

**和早期「Supabase 精简版」的区别**：
| 组件 | 早期有 | 现在 | 原因 |
|---|---|---|---|
| postgres | ✅ | ✅ | 数据本体 |
| redis | ✅ | ✅ | 缓存 / Celery broker |
| minio | ✅ | ✅ | 对象存储（模型/报告） |
| PostgREST + Kong | ✅ | ❌ | 前端改走 Next.js 同源代理 `/svc/*` |
| GoTrue（auth） | ✅ | ❌ | 改走自建鉴权（data-svc） |
| storage | ✅ | ❌ | 项目用 MinIO |

---

## 🚀 快速开始

### Windows (PowerShell)

```powershell
cd investdojo\infra\supabase-lite
.\scripts\up.ps1
```

### Mac / Linux

```bash
cd investdojo/infra/supabase-lite
chmod +x scripts/*.sh
./scripts/up.sh
```

**首次启动会自动**：
1. 从 `.env.example` 复制为 `.env`
2. 随机生成 `POSTGRES_PASSWORD` / `AUTH_JWT_SECRET` / `REDIS_PASSWORD`
3. `docker compose up -d`（db / redis / minio / minio-init）
4. 等待 Postgres healthy
5. 打印所有端点

---

## 🔑 启动成功后你会得到

```
  Postgres 直连    localhost:5432  (user: postgres)
  Redis            localhost:6379
  MinIO S3         localhost:9000  (Console :9001)

  自建鉴权         data-svc :8006  /api/v1/auth（httpOnly Cookie: id_session）
```

业务库迁移：

```bash
python-services/scripts/apply_migrations.sh
```

---

## 📋 常用命令

```bash
# 停止（数据保留）
./scripts/down.sh

# 看日志
docker compose logs -f db
docker compose logs -f minio

# 进入 DB 命令行
docker compose exec db psql -U postgres

# 手动备份
docker compose exec db pg_dump -U postgres postgres -Fc -f /backup/manual-$(date +%Y%m%d).dump

# 清空重装（危险！删所有数据）
./scripts/down.sh
rm -rf ./data
./scripts/up.sh
```

---

## 🐛 故障排查

### db 容器一直 restart

看日志：`docker compose logs db`。最常见：`.env` 里的 `POSTGRES_PASSWORD`
与容器已存在旧 volume 不一致。解决：`./scripts/down.sh && rm -rf ./data && ./scripts/up.sh`。

### Python 服务连不上 Postgres

- 检查 `infra/supabase-lite/.env` 里的 `POSTGRES_PASSWORD`
- 服务读取 `PG_PASSWORD`（与 `POSTGRES_PASSWORD` 一致）
- `docker compose exec db pg_isready -U postgres`

### 前端登录失败 / 拿不到会话

- 检查 data-svc :8006 是否起来：`curl localhost:8006/api/v1/auth/me`
- 浏览器需携带 `id_session` Cookie（由 `/api/v1/auth/login` 签发，HttpOnly）

---

## 🗂 目录说明

```
supabase-lite/
├── docker-compose.yml      # 4 个容器定义（db/redis/minio/minio-init）
├── .env.example            # 环境变量模板
├── .env                    # 首次 up 时生成（不进 git）
├── config/
│   └── postgresql.conf     # Postgres 调优
├── init/
│   └── 00_supabase_init.sql  # 首次启动时建扩展（不再建 auth/storage）
├── scripts/
│   ├── up.sh / up.ps1      # 启动（含自动生成密钥）
│   ├── down.sh / down.ps1  # 停止
└── data/                   # 持久化数据（不进 git）
    ├── db/                 # Postgres 数据
    └── db-backup/          # pg_dump 输出
```

---

## 🔗 相关文档

- 业务迁移 SQL：`investdojo/migrations/`
- 鉴权模块：`python-services/common/auth.py` + `python-services/data-svc/routers/auth.py`
- 数据层设计：`docs/architecture/01_数据层.md`
