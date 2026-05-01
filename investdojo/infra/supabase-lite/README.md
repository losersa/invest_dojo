# Supabase 精简栈（investdojo 自托管）

> **定位**：只跑你代码实际依赖的 3 个组件，代码零改动。
> **适合**：想脱离 Supabase Cloud 免费档限制，但又不想折腾全栈 10+ 容器的场景。

---

## 🏗 架构

```
┌─────────────────────────────────────────────────────────┐
│  Kong :8000                                              │
│    /rest/v1/*  → PostgREST (内部 :3000)                  │
│    /auth/v1/*  → GoTrue    (内部 :9999)                  │
└──────────────────────┬───────────────────────────────────┘
                       │
                  postgres:5432
                  (E:\investdojo\data\db 挂载)
```

**和完整 Supabase 的区别**：
| 组件 | 全栈有 | 精简版 | 原因 |
|---|---|---|---|
| postgres | ✅ | ✅ | 数据本体 |
| postgrest | ✅ | ✅ | Python 代码打这个 |
| gotrue (auth) | ✅ | ✅ | 前端 `@supabase/ssr` 打这个 |
| kong | ✅ | ✅ | 统一入口，URL 和云端一致 |
| storage | ✅ | ❌ | 项目用 MinIO |
| realtime | ✅ | ❌ | Epic 6 前用不到 |
| studio | ✅ | ❌ | 用 DBeaver/pgAdmin 代替 |
| analytics / functions / vector | ✅ | ❌ | MVP 用不到 |

**内存占用**：约 500-800 MB（全栈版要 3 GB+）

---

## 🚀 快速开始

### Windows

```powershell
# 前置：已装 Docker Desktop + WSL2 + Python 3.10+
cd investdojo\infra\supabase-lite
.\scripts\up.ps1
```

### Mac / Linux

```bash
# 前置：brew install docker openssl python3
cd investdojo/infra/supabase-lite
chmod +x scripts/*.sh
./scripts/up.sh
```

**首次启动会自动**：
1. 从 `.env.example` 生成 `.env`
2. 随机生成 `POSTGRES_PASSWORD` / `JWT_SECRET`
3. 用 `JWT_SECRET` 签出 `ANON_KEY` 和 `SERVICE_ROLE_KEY`（10 年有效期）
4. 拉镜像、起容器、注入密码、重启依赖服务
5. 打印所有端点

---

## 🔑 启动成功后你会得到

```
  SUPABASE_URL              = http://localhost:8000
  SUPABASE_ANON_KEY         = eyJhbGciOiJIUzI1NiI...（长串）
  SUPABASE_SERVICE_ROLE_KEY = eyJhbGciOiJIUzI1NiI...（长串）
```

**把这 3 个值填到项目各 `.env` 文件里就完事**：
- `investdojo/infra/.env`
- `investdojo/python-services/.env`
- `investdojo/apps/server/.env`
- `investdojo/apps/web/.env`（前端用 `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`）

---

## 📋 常用命令

```bash
# 停止（数据保留）
./scripts/down.sh

# 看日志（诊断用）
docker compose logs -f db
docker compose logs -f rest
docker compose logs -f auth
docker compose logs -f kong

# 进入 DB 命令行
docker compose exec db psql -U postgres

# 手动备份
docker compose exec db pg_dump -U postgres postgres -Fc -f /backup/manual-$(date +%Y%m%d).dump
# 备份文件会落到 $DATA_DIR/db-backup/

# 清空重装（危险！删所有数据）
./scripts/down.sh
rm -rf ./data
./scripts/up.sh
```

---

## 🌐 让 Mac 连到 Windows 的这套栈

### 在 Windows 上

1. 把 `.env` 里的 `API_EXTERNAL_URL` 改成：
   ```
   API_EXTERNAL_URL=http://investdojo.local:8000
   ```
   重启 auth：`docker compose restart auth`

2. 防火墙放行（管理员 PowerShell，一次性）：
   ```powershell
   New-NetFirewallRule -DisplayName "InvestDojo-Kong"   -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow -Profile Private
   New-NetFirewallRule -DisplayName "InvestDojo-Pg"     -Direction Inbound -Protocol TCP -LocalPort 5432 -Action Allow -Profile Private
   ```

3. 主机名改成 `investdojo`（管理员）：
   ```powershell
   Rename-Computer -NewName "investdojo" -Force
   # 重启
   ```

### 在 Mac 上

```bash
# 验证连通
ping investdojo.local
curl http://investdojo.local:8000/rest/v1/ -H "apikey: <你的 ANON_KEY>"

# 改 4 个 .env 里的 SUPABASE_URL = http://investdojo.local:8000
```

---

## 🔄 数据迁移（Cloud → 本地）

栈起来后，用项目根目录的迁移脚本：

```bash
# Mac 上跑
cd investdojo
./scripts/migrate_supabase_to_local.sh \
    --source-url "postgresql://postgres:<CLOUD_PWD>@db.adqznqsciqtepzimcvsg.supabase.co:5432/postgres" \
    --target-host investdojo.local \
    --target-password "<本地 POSTGRES_PASSWORD>" \
    --mode all
```

详见 `investdojo/scripts/migrate_supabase_to_local.sh --help`

---

## 🐛 故障排查

### rest 容器一直 restart

看日志：`docker compose logs rest`
最常见：`JWT secret`/`authenticator 密码`不一致。`up.sh/ps1` 的第 6 步要跑成功。

### auth 容器报 `pq: role "supabase_auth_admin" does not exist`

`init/00_supabase_init.sql` 没执行（容器已存在旧 volume）。
解决：清空数据重来（`./scripts/down.sh && rm -rf ./data && ./scripts/up.sh`）。

### Mac 连不上 Windows

- `ping investdojo.local` 不通 → Windows 的 mDNS/主机名没生效，改用 IP
- `ping` 通但 `curl :8000` 挂 → Windows 防火墙没放行 / Kong 没起来
- `curl :8000` 通但 `/rest/v1` 报 401 → `apikey` header 没带对

### Python 服务报错 `row level security policy`

说明 RLS 生效了但 JWT 不对。两种情况：
- 后端服务应该用 `SERVICE_ROLE_KEY`（绕过 RLS），检查 `.env`
- 前端用户操作应该带用户的 access_token（GoTrue 签发）

---

## 🗂 目录说明

```
supabase-lite/
├── docker-compose.yml      # 4 个容器定义
├── .env.example            # 环境变量模板
├── .env                    # 首次 up 时生成（不进 git）
├── config/
│   ├── kong.yml            # Kong 路由配置
│   └── postgresql.conf     # Postgres 调优
├── init/
│   └── 00_supabase_init.sql  # 首次启动时建 auth/schema/roles
├── scripts/
│   ├── up.sh / up.ps1      # 启动（含自动生成密钥）
│   ├── down.sh / down.ps1  # 停止
│   └── generate-keys.py    # 签 anon/service JWT
└── data/                   # 持久化数据（不进 git）
    ├── db/                 # Postgres 数据
    └── db-backup/          # pg_dump 输出
```

---

## 🔗 相关文档

- 数据迁移脚本：`investdojo/scripts/migrate_supabase_to_local.sh`
- 数据层设计：`docs/architecture/01_数据层.md`
- 迁移 SQL：`investdojo/migrations/`
- 旧的全栈方案（保留做参考）：`../supabase-windows/`
