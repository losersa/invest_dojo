# Windows 端 Supabase 自托管部署

> 目标：在 Windows 上跑一个自托管 Supabase 栈，替代已满的云端免费档。
> Mac 端代码零修改，只改 `.env` 里的 `SUPABASE_URL`。

---

## 📁 本目录内容

| 文件 | 作用 |
|------|------|
| `docker-compose.override.yml` | 覆写 Supabase 官方 compose：把所有卷映射到 E 盘 + 端口绑到 0.0.0.0 |
| `postgresql.conf` | Postgres 性能调优（12GB WSL2 内存基准） |
| `pg_hba.conf` | 客户端认证规则（放行局域网、拒绝公网） |
| `.env.windows.example` | 环境变量模板，复制为 `.env` 填入密钥 |

---

## 🚀 部署流程（Windows PowerShell 管理员）

### 1. 装 Docker Desktop（WSL2 后端）

设置 → Resources → WSL Integration 打开；Advanced 里把磁盘给到 100GB+。

`C:\Users\<你>\.wslconfig` 建议写上：
```ini
[wsl2]
memory=12GB
processors=6
swap=4GB
```
重启 WSL：`wsl --shutdown`。

### 2. 准备数据目录

```powershell
mkdir E:\investdojo\data\db
mkdir E:\investdojo\data\db-config
mkdir E:\investdojo\data\db-backup
mkdir E:\investdojo\data\storage
mkdir E:\investdojo\data\functions
mkdir E:\investdojo\data\logs
```

### 3. 克隆 Supabase 官方栈

```powershell
cd E:\investdojo
git clone --depth 1 https://github.com/supabase/supabase.git supabase-src
mkdir supabase
Copy-Item -Recurse supabase-src\docker\* supabase\
cd supabase
```

此时 `supabase\docker-compose.yml` 已就位。

### 4. 套上本目录的 override + 配置

从仓库里把这 4 个文件拷过去（和 `docker-compose.yml` 同级）：
```powershell
# 假设仓库克隆在 E:\project\invest_dojo
$src = "E:\project\invest_dojo\investdojo\infra\supabase-windows"
Copy-Item "$src\docker-compose.override.yml" .
Copy-Item "$src\.env.windows.example" ".env"
Copy-Item "$src\postgresql.conf" "E:\investdojo\data\db-config\"
Copy-Item "$src\pg_hba.conf"      "E:\investdojo\data\db-config\"
```

### 5. 编辑 `.env`，替换所有 `<CHANGE_ME_*>`

必改的几项：
- `POSTGRES_PASSWORD`
- `JWT_SECRET`（`openssl rand -base64 32`）
- `ANON_KEY` / `SERVICE_ROLE_KEY`（用 JWT_SECRET 按 Supabase 官方文档生成）
- `DASHBOARD_PASSWORD`
- `API_EXTERNAL_URL` / `SUPABASE_PUBLIC_URL`（改成 Mac 看得到的地址）

### 6. Windows 防火墙放行（Private profile）

```powershell
New-NetFirewallRule -DisplayName "InvestDojo-SupabaseAPI" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow -Profile Private
New-NetFirewallRule -DisplayName "InvestDojo-Postgres"    -Direction Inbound -Protocol TCP -LocalPort 5432 -Action Allow -Profile Private
New-NetFirewallRule -DisplayName "InvestDojo-Studio"      -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
```

### 7. 启动

```powershell
cd E:\investdojo\supabase
docker compose pull
docker compose up -d
docker compose ps       # 全部 healthy 才算成功
```

首次启动约 2-3 分钟（Postgres 初始化 + 各服务加载扩展）。

### 8. 校验

本机：
```powershell
curl http://localhost:8000/rest/v1/           # 应返回 OpenAPI 元信息
curl http://localhost:3000                    # Studio 页面
```

Mac 端：
```bash
ping investdojo.local
curl -s http://investdojo.local:8000/rest/v1/ -H "apikey: <你的ANON_KEY>"
```

---

## 🔧 常用运维命令

```powershell
# 查状态
docker compose ps

# 看日志（某个服务）
docker compose logs -f db
docker compose logs -f kong
docker compose logs -f rest

# 重启单个服务
docker compose restart rest

# 手动备份
docker exec supabase-db pg_dump -U postgres postgres -Fc -f /backup/investdojo_manual.dump

# 停止 / 启动
docker compose down        # 只停服务，数据保留
docker compose up -d

# ⚠️ 危险：清空所有数据（会删 E:\investdojo\data 下的东西？不会！bind mount 不受 down -v 影响）
# 如果真要清空，手动 rm 目录
```

---

## 🐛 常见坑

| 症状 | 原因 | 解决 |
|------|------|------|
| `db` 容器一直 restarting | `postgresql.conf` 或 `pg_hba.conf` 没放到 `E:\investdojo\data\db-config\` | 看 `docker compose logs db`，大概率是配置文件找不到 |
| Mac 连不上 `:5432` | Windows 防火墙没放 / profile 错 | `Get-NetFirewallRule -DisplayName "InvestDojo-*"` 核对 |
| 查询特别慢 | WSL2 内存给太小 | 改 `.wslconfig`，重启 WSL |
| `ANON_KEY` 无效 | JWT 不是用 `.env` 里那个 `JWT_SECRET` 签的 | 用 Supabase 官方的 `jwt-cli` 或在线工具重签 |
| 端口 8000 被占 | Windows 上有别的服务占了 | 改 `.env` 里的 `KONG_HTTP_PORT` |

---

## 🔗 相关文档

- 数据迁移脚本：`scripts/migrate_supabase_to_local.sh`（待生成）
- 数据层设计：`docs/architecture/01_数据层.md`
- 迁移 SQL：`migrations/000_bootstrap.sql` ~ `005_rls_policies.sql`
