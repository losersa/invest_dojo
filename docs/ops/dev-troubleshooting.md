# 开发环境排障手册（devcloud / 远程开发）

> 本文记录 devcloud 上 dev 环境反复踩到的坑，以及**标准启动 / 清理 / 排障流程**。
> 每次“页面空白 / 加载失败 / 端口被占”基本都能在这找到原因。
>
> 📌 **配套 Skill**：`.codebuddy/skills/investdojo-troubleshooting/`
> 内含条目化、可搜索的「已知问题知识库」（`references/known-issues.md`），
> 并规定「遇到问题先查、解决后必记」的工作流。**新排查出的坑请同时回写到那里。**

---

## 0. 最重要的两件事（先看）

1. **权威代码目录是 `/data/home/studyinguo/investdojo/`，不是 `cfs/invest_dojo/investdojo/`。**
   - `cfs/...` 只是 CFS 网络文件系统的同步副本，**运行中的 uvicorn 服务、`start-web.sh`、Next.js 都来自前者**。
   - 之前在 `cfs/...` 里改 `middleware.ts` / `sdk.ts` 全部不生效，就是这个原因。
   - 改任何“要跑起来”的代码，都改 `/data/home/studyinguo/investdojo/` 下的。

2. **浏览器访问的是 devcloud 的 `:3000`，但浏览器自己的 `localhost:800x` 不是 devcloud。**
   - 前端 SDK 默认把请求发到 `http://localhost:800x`（数据/因子等服务）。
   - 当你的浏览器在**远程机器**（通过端口转发看 `:3000`）时，`localhost:800x` 指向的是**你本地电脑**，那里什么都没有 → 表现为：K 线 0 根、因子库 `Failed to fetch`。
   - 解决方案是**同源代理**（见第 4 节），已被实现，不要改成直连绝对地址。

---

## 1. 服务端口速查

| 端口 | 服务 | 说明 |
|------|------|------|
| 3000 | Next.js web（前端） | `pnpm dev` 中由 turbo 拉起 |
| 4000 | `@investdojo/server`（Hono API） | `pnpm dev` 中由 turbo 拉起；根路径返回 404 属正常 |
| 8000 | Supabase Kong | docker 容器内，前端经 `/sb/*` 代理访问 |
| 8001–8006 | python 微服务（feature/train/infer/backtest/monitor/data） | 宿主机 uvicorn，前端经 `/svc/*` 代理访问 |
| 5432 | Postgres（容器内 `investdojo-db`） | 数据本体 |

> ⚠️ **不要在 `.env.local` 里把 SDK 指向 `localhost:10001~10006`**。
> SDK 在未配置 `NEXT_PUBLIC_*_SVC_URL` 时**默认回退到 10001–10006**，而这些端口没有服务 → 数据全空。
> 正确配置见第 3 节。

---

## 2. `.env.local` 必须包含的变量（apps/web/.env.local）

```bash
# 微服务（python）— 真实端口 8001-8006
NEXT_PUBLIC_DATA_SVC_URL=http://localhost:8006
NEXT_PUBLIC_FEATURE_SVC_URL=http://localhost:8001
NEXT_PUBLIC_TRAIN_SVC_URL=http://localhost:8002
NEXT_PUBLIC_INFER_SVC_URL=http://localhost:8003
NEXT_PUBLIC_BACKTEST_SVC_URL=http://localhost:8004
NEXT_PUBLIC_MONITOR_SVC_URL=http://localhost:8005

# Supabase（走 Kong 8000，前端经 /sb 代理）
NEXT_PUBLIC_SUPABASE_URL=http://localhost:8000
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
```

> 只有 Supabase、缺上面 6 行，是本次“K 线空白 + 因子库失败”的直接原因。

---

## 3. 同源代理是怎么工作的（改动点回顾）

为了让远程浏览器也能访问 devcloud 的服务，而不是它自己的 `localhost`：

- **`apps/web/src/lib/proxy-fetch.ts`（新增）**
  浏览器内：把 `http://localhost:<port>/path` 改写成同源路径：
  - `8000` → `/sb`
  - `8001` → `/svc/feature`，`8002` → `/svc/train`，`8003` → `/svc/infer`
  - `8004` → `/svc/backtest`，`8005` → `/svc/monitor`，`8006` → `/svc/data`
  - Node 端（SSR）直接 `fetch`，不重写。
- **`apps/web/src/middleware.ts`**
  拦截 `/svc/*` 与 `/sb/*`，转发到 `localhost:8001~8006` / `8000`，再把响应原样返回；
  非代理路径回退到原有 Supabase 鉴权逻辑。
- **`apps/web/src/lib/sdk.ts`** / **`.../supabase/client.ts`**
  分别把 `proxyFetch` 作为 `fetchImpl` / `fetch` 注入 SDK 与 Supabase 浏览器客户端。
- **`packages/api/src/index.ts`**
  `SDKOptions` 增加 `fetchImpl?: typeof fetch` 并向下透传。

> ❗ 想“简化”成浏览器直连 `localhost:800x` **只在浏览器与 devcloud 同机时才有效**；
> 远程访问必断。保留代理方案。

---

## 4. 标准启动流程（推荐）

所有 dev 进程统一由**一个** `pnpm dev`（turbo）管理，不要拆开单独起，否则容易端口冲突。

```bash
# 1) 先彻底清理遗留进程（见第 5 节脚本）
bash /tmp/killweb.sh

# 2) 确保端口空闲
for p in 3000 4000; do
  (exec 3<>/dev/tcp/127.0.0.1/$p) 2>/dev/null && echo "BUSY $p" || echo "free $p"
done

# 3) 后台启动完整全栈（web + server 由同一个 turbo 管）
export PATH="/data/home/studyinguo/.workbuddy/binaries/node/versions/20.18.0/bin:$PATH"
cd /data/home/studyinguo/investdojo
setsid pnpm dev > /tmp/full-dev.log 2>&1 < /dev/null &
echo "PID=$!"
```

> 注意：`pnpm dev` 是**持久进程**。直接用 `bash -c "pnpm dev"` 前台跑会被工具当作“看门任务”卡 300s。
> 一定要 `setsid ... &` 后台化并立即返回（或写进脚本用 `bash 脚本` 执行）。

---

## 5. 进程清理（孤儿端口占用）

### 现象
重启后新 `pnpm dev` 报 `EADDRINUSE`，但 `ss -ltnp | grep :4000` 能看到一个**父进程是 1（init）**的孤儿 node。
这说明上一次的 `turbo`/`pnpm dev` 父进程已退出，但子 server 没被回收，继续占着端口。

### 根因与陷阱
- 在 `turbo run dev` 下，**手动 kill 掉其中某一个子任务（如 server）会让整个 dev 栈停掉**，
  连带把 web 一起杀掉。所以要清就**全部清**，再统一重启。
- 某些执行环境会把**命令行里出现 `kill` / `pnpm dev` / `middleware.ts` 的命令误判为长任务并 300s 超时**，
  导致 `kill -9` 看起来“没执行”。**绕过办法：把命令写进 `/tmp/*.sh` 脚本，再用 `bash 脚本` 执行。**

### 清理脚本 `/tmp/killweb.sh`
```bash
#!/usr/bin/env bash
pkill -9 -f 'pnpm dev'
pkill -9 -f 'turbo run dev'
pkill -9 -f 'next dev'
pkill -9 -f 'next-server'
pkill -9 -f 'cli.mjs watch'   # tsx watch（server）
pkill -9 -f 'tsx.*src/index.ts'
sleep 2
echo "killweb done"
```

> 单独清理某个 PID 时，也用脚本包一层（避免命令行直接出现 `kill` 字样被卡住）。

---

## 6. 验证清单（启动后逐项确认）

```bash
# web 是否起来
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/          # 期望 200

# 同源代理是否打通（这是浏览器实际走的路径）
curl -s -o /dev/null -w "%{http_code}\n" \
  "http://localhost:3000/svc/data/api/v1/data/klines?symbols=300750&timeframe=5m&page_size=1"  # 期望 200 + 真实 OHLCV
curl -s -o /dev/null -w "%{http_code}\n" \
  "http://localhost:3000/svc/feature/api/v1/factors?page_size=2"          # 期望 200 + 因子列表
curl -s -o /dev/null -w "%{http_code}\n" \
  "http://localhost:3000/sb/auth/v1/settings"                            # 期望 200（Supabase 代理）

# server (4000) 是否在
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4000/          # 404 即正常（根无 handler）
```

浏览器端：**强制刷新**（Ctrl/Cmd+Shift+R）以加载带代理逻辑的新打包。

---

## 7. 常见症状 → 原因 → 解决

| 症状 | 原因 | 解决 |
|------|------|------|
| K 线“0 根 K 线” | `.env.local` 缺 `NEXT_PUBLIC_*_SVC_URL`，SDK 回退到死端口 10001–10006 | 补全第 2 节变量 |
| 因子库 `[network_error] Failed to fetch` | 同上 / 浏览器 `localhost:800x` 指向自己机器 | 用同源代理（第 3 节），勿改直连 |
| 改了 `middleware.ts` 等却不生效 | 改错目录（改到了 `cfs/...` 副本） | 改 `/data/home/studyinguo/investdojo/` |
| `pnpm dev` 报 `EADDRINUSE :4000` | 上次 server 孤儿进程占端口 | 跑 `/tmp/killweb.sh` 后重启 |
| 手动 kill 一个子任务后 web 也挂了 | turbo 在子任务退出时停掉整个 dev 栈 | 全清后统一重启（第 4 节） |
| `kill -9` 命令卡 300s 像没执行 | 命令行含 `kill` 等被误判为长任务 | 写进 `/tmp/*.sh` 再 `bash` 执行 |

---

## 8. 因子历史值查询 500（feature-svc 后端）

**现象**：因子详情页点“查询”历史值，报 `[unknown] Internal Server Error`。
K 线因子（只用 close/volume 等）正常，但依赖基本面字段的因子（如 `pb < 1`）必崩。

**根因**：`feature-svc/actors/panel_loader.py` 的 `_compute_derived()` 在面板交给计算引擎**之前**就做衍生计算，
而 K 线字段（numeric）从 Postgres 读出是 `decimal.Decimal`、基本面字段是 `float`，
`close / eps_ttm` 这种 `Decimal / float` 直接抛 `TypeError: unsupported operand type(s) for /: 'decimal.Decimal' and 'float'`。
该异常未被 `except EngineError` 捕获（类型不对），变成裸 500。

**修复**：在 `_compute_derived` 开头把 `close` 统一 `astype("float64")`（与 `Engine.__init__` 的处理一致）。
修复后这类因子返回 200（带真实值），基本面缺失时则返回干净的 503 并提示 `Field 'pb' not in panel`，前端会显示“字段未采集”友好提示。

> 注：feature-svc 用 `--reload` 启动，改 `.py` 文件后会**自动重载**，无需手动重启。

## 9. React 控制台告警 getServerSnapshot should be cached

**现象**：因子详情页 / K 线页控制台报
`The result of getServerSnapshot should be cached to avoid an infinite loop`
（来自 `useFavoriteFactors.ts` 的 `useSyncExternalStore`）。

**根因**：`useSyncExternalStore(subscribe, getFavorites, () => [])` 的第三个参数（SSR 快照）每次返回**新数组**，
React 在 SSR 阶段认为快照不稳定 → 告警（严重时会无限循环）。

**修复**：模块级定义一个稳定引用 `const SERVER_SNAPSHOT: string[] = []`，SSR 快照返回它即可。

## 10. 一句话总结

> 改代码认准 `/data/home/studyinguo/investdojo/`；前端经 `/svc/*`、`/sb/*` 同源代理访问 devcloud 服务；
> 全栈用**一个** `pnpm dev` 管理，重启前先 `killweb.sh` 清干净，启动用 `setsid ... &` 后台化。
> 因子 compute 500 看 `panel_loader.py` 的 Decimal/float 类型；SSR 快照要返回稳定引用。

---

## 11. PG 连接池并发坑（PoolError / server closed the connection）（2026-07-25）

### 现象
- `PoolError: trying to put unkeyed connection`（asyncio `run_in_executor` 并发调 DB 时）；
- `PoolError: connection pool exhausted`（单请求并发 DB 调用 > maxconn=10 时）；
- 偶发 `psycopg2.OperationalError: server closed the connection unexpectedly`（train-svc 500）。

### 根因
`python-services/common/supabase_client.py` 原来用 `pool.SimpleConnectionPool`——**非线程安全**
（psycopg2 文档明确要求多线程用 `ThreadedConnectionPool`），而 FastAPI 里大量
`run_in_executor` 会把查询分发到多个 worker 线程；池上限 10 偏低、死连接无探活。

### 修复
换 `ThreadedConnectionPool`（双重检查锁建池）+ DSN 加 `keepalives` 系列参数 + maxconn 10→20；
monitor-svc alerts 聚合用 `asyncio.Semaphore(6)` 限流 DB 并发（`_run_db`）。

### 防范
新写"并发调 DB"的代码（gather + run_in_executor）先估算并发度，>6 加 Semaphore；
连接归还必须在 `finally` 里。

---

## 12. uvicorn --reload 与 celery 进程管理坑（2026-07-25）

### 现象
- 改任意 `python-services/**` 文件，**全部 6 个微服务**一起 reload；
- feature-svc 对 `/health` 持续超时但进程还在，listen backlog 积压；
  kill 主 PID 后新进程报 `[Errno 98] Address already in use`；
- 改完 celery 任务代码，定时任务行为不变（旧代码继续跑）。

### 根因
1. `--reload` 的 watch 目录是 `python-services/` 整棵树 → 一改动全 reload；
2. reload 期间若有进行中的慢请求，优雅退出卡死：supervisor 不响应 SIGTERM，
   server 子进程残留占端口 → 新进程绑定失败；
3. celery worker/beat **不** auto-reload；`start-celery.sh` 每次新起 worker+beat，
   只杀旧 worker 不杀旧 beat → 两个 beat 重复调度。

### 修复
- 卡死服务：`ss -tlnp | grep :<port>` 拿 supervisor+server 两个 PID，`kill -9` 一起杀再重启；
- celery：`kill <旧 worker> <旧 beat>` 后再 `bash python-services/start-celery.sh`，
  起完 `ps aux | grep "celery.*beat"` 确认 beat 唯一。

### 防范
重启 uvicorn 服务前先看端口下所有 PID；celery 重启后必查 beat 唯一性；
生产/长稳环境建议去掉 `--reload`。

---

## 13. 前端构建发布与分页 422 坑（2026-07-25）

### 现象
- 训练页因子列表空白，feature-svc 日志 `GET /api/v1/factors?...&page_size=500 → 422`；
- 源码已修复但线上依旧发旧参数（"修复不生效"）；
- `pnpm build:web` 失败：`"FactorExplorerPage" is not a valid Page export field`（dev 正常）；
- dev server 跑 5 天后所有页面 500。

### 根因
1. feature-svc 分页上限 100，前端发 500 → 422 → catch 静默 `setFactors([])` → 空白；
2. 浏览器缓存旧 chunk / 旧 dev 进程未热更 → 判断修复是否生效要看**源文件 mtime vs 日志最后出现时间**；
3. Next.js 15 page.tsx 只允许 default + 配置导出，命名导出组件在生产构建类型校验才报错；
4. dev server 长稳运行不可靠。

### 修复
- 所有 `listFactors` 调用点 page_size ≤ 100；explorer 去命名导出、补 `Dispatch<SetStateAction>` 类型；
- 发布：`export PATH="/data/home/studyinguo/.workbuddy/binaries/node/versions/20.18.0/bin:$PATH"`
  → `pnpm build:web` → 杀旧进程 → `cd apps/web && nohup pnpm start > logs/frontend.log 2>&1 &`。

### 防范
- 改完 page.tsx 跑一次 `pnpm type-check`（dev 不报的错生产构建会报）；
- nohup/setsid 环境无 pnpm PATH，构建前先 export PATH；
- **补充（2026-07-25）**：`progress-data.json` 等静态 import 的 JSON 在 `next build` 时打包进
  bundle——改完必须重新 build + 重启；验证用 `grep -rl "关键字" apps/web/.next/static/chunks/`
  （curl 页面 HTML 是 loading 态，grep 不到属正常）。

---

## 14. 因子计算/数据的静默失败（2026-07-25）

### 现象
- 训练报"feature_values 为空"；celery 日志
  `batch_compute.done ... factors_computed=212 symbols=5201 records_written=0`。

### 根因
`batch_compute.py` 的 `date_mask` 把结果裁到目标区间，**目标区间无 K线时 mask 全 False →
静默 0 条**（原告警只在 errors 含特定字符串时触发）。典型诱因：增量任务按系统时钟算
"昨天/今天"，而 K线实际只更新到更早日期。

### 修复
- 告警放宽：只要 `records_written=0` 即 WARN `batch_compute.zero_records_written`（含排查 hint）；
- 排查先查覆盖：`SELECT MAX(dt) FROM klines_all WHERE timeframe='1d'` 与
  `SELECT MAX(date) FROM feature_values`；回填按**实际数据区间**跑；
- monitor-svc `/api/v1/monitor/alerts` 已把"K线陈旧 / 因子值落后 K线"纳入巡检。

### 防范
- `feature_values` 是 5000w+ 行分区表：**禁止全表 count / order desc 探最新日期**，
  用"逐天等值探测"（分区裁剪，见 monitor-svc/alerts.py `_latest_feature_value_date`）；
- 新增"按日期裁剪"的计算逻辑，裁剪前后各打一行数量日志，避免静默 0 条。

---

## 15. API 性能坑：select_all 大表做"是否存在"判断（2026-07-25）

### 现象
- 训练页因子列表持续空白（422 修复后依旧）；`/api/v1/factors` 单页 15s+/60s 超时；
  SDK（15s 超时）catch 静默置空 → "选不了因子"。

### 根因
`factors.py` 的 `has_values` 标注用 `select_all("feature_values", columns="factor_id",
filters={"factor_id": "in.(100个id)"})` 拉回**全部匹配行**（数百万行）再 Python 去重——
只为判断"有没有值"。第一页恰好都是无值因子（拉 0 行，17ms），掩盖了问题。

### 修复
逐因子 `select(..., filters={"factor_id": "eq.x"}, limit=1)` 走主键
`(factor_id, symbol, date)` 索引，每因子 ~1ms，100 因子 <150ms（~400 倍提升）；
同步支持 `value_start/value_end` 区间判定；同列多条件用 `"and": "(date.lte.x)"` 语法。

### 防范
大表"是否存在/有哪些 id 有值"判断一律 `LIMIT 1` 走索引，禁止 `select_all` 拉全量；
前端 SDK 一律设超时 + catch 后至少有日志/保底 UI。

---

## 16. BaoStock 限流与 seed 老脚本环境坑（2026-07-25）

### 现象
- `bs.login()` 返回 `10001011 黑名单用户`（重试几次又成功）；
- `scripts/seed_market_snapshots.py` 报 `KeyError: 'SUPABASE_URL'`（环境变量已 export）。

### 根因
1. "黑名单用户"是 BaoStock **间歇性限流**（频繁登录/拉取触发），非真封禁；
2. 老 seed 脚本**不读进程环境变量**，读 `apps/server/.env` 文件（Supabase Cloud 时代遗留）。

### 修复
- `update_5m_klines.py` 登录/拉取带退避重试；创建 `apps/server/.env`
  （SUPABASE_URL=http://localhost:8000 + SERVICE_ROLE_KEY 取自 `infra/supabase-lite/.env`）。

### 防范
新增 BaoStock 脚本一律带登录重试；引用老 seed 脚本先确认其 `load_env()` 读哪个文件。

---

## 17. 磁盘写满 → PG 崩溃循环（2026-07-25，最严重）

### 现象
- 各服务报 `server closed the connection unexpectedly`；`investdojo-db` 容器
  `Restarting (1)` 循环，日志 `FATAL: could not write to file "pg_wal/xlogtemp.29":
  No space left on device`；`df -h /data` 100%，但 `du -x /data` 只统计出 15G。

### 根因
- 磁盘大头是一个 **18.1GB 无容器引用的 TF CUDA 镜像**（`docker system df`：Images 19G/95% 可回收）；
- `du`/`df` 差值来源：① Docker Root Dir 在 `/data/docker/lib`（du 漏看）；
  ② **PG bind mount 数据目录属容器 uid（postgres/70），普通用户 du 无权限读，显示 4KB 假象**；
- 大批量回补 upsert 持续写 WAL，空间耗尽 → PG 启动恢复也写不了 → 崩溃循环。

### 修复
- 紧急：`docker rmi <18G 无引用镜像>` → PG 自动恢复（WAL redo）；
- 服务侧：连接池 keepalive（## 11）使 DB 连接自动重连，无需重启；
- 告警中心基础设施模块已加磁盘监控（/data ≥85% warning、≥95% critical）。

### 防范
- 排查"磁盘满了但 du 找不到"：`docker system df` + `lsof +L1`（deleted-open）+
  注意 bind mount 目录属容器 uid 时普通用户 du 不可见（用 `sudo du`）；
- 大批量数据任务期间盯 `df -h`；docker 镜像定期 prune；磁盘告警看 `/admin/alerts`。

---

## 18. devcloud 磁盘扩容 → 工作区快照回滚，代码丢失（2026-07-25）

### 现象
磁盘扩容操作后，**工作区被回滚到数小时前的快照**：当日全部代码修改丢失；
部分新建文件变 0 字节（`alerts.py`、`update_5m_klines.py`、`admin/alerts/page.tsx`、
`change-log.md`），部分文件内容回到旧版（`celery_worker.py`、`factors.py` 等）。

### 根因
devcloud 磁盘扩容基于快照重建环境，回滚到扩容前的快照点；
**项目没有 git 版本管理**，丢失的改动无任何备份，只能凭会话记录重建。

### 修复
当日全部改动按记录重建（后端/前端/文档/调度）；复盘时逐文件验证内容标记
（`grep -c <关键字>`）确认无漏。

### 防范
- **强烈建议 `git init` + 高频提交**（哪怕只本地）——有 git 则此类事故顶多丢未提交改动；
- 无 git 时，重要改动完成后立即打包备份（`tar czf /tmp/backup-$(date +%F).tgz <关键路径>`）；
- 云平台做磁盘扩容/快照类操作前，先确认工作区已提交或备份。
## 19. supabase_client filter 值含 "." 被误拆成操作符（2026-07-26）

### 现象
`GET /routine/runs?task_name=feature.compute_incremental` 返回空数组；
不带 `task_name` 过滤却能正常查到该任务的记录。

### 根因
`common/supabase_client.py` `_translate_one` 用 `val.partition(".")` 拆 `op.value`。
值本身含点号（celery 任务名 `feature.compute_incremental`）时，op 被解析成
`feature`、value 只剩 `compute_incremental`，落入「未知操作符降级等值」分支
→ `task_name = 'compute_incremental'` 恒不匹配，且只在日志里留一条
`pg.unknown_op` warning，接口表现是「静默查空」。

### 修复
调用方传显式操作符前缀 `eq.{value}`——`partition` 只切第一个点，
`feature.compute_incremental` 余下部分完整保留。

### 防范
- 凡是 filter 值可能含 `.`（任务名、文件路径、域名、版本号）**必须带显式
  `eq.`/`gte.`/`in.(...)` 前缀**，不要传裸值；裸值仅适用于无点号的纯值；
- 排查「过滤即空、不过滤有数」类问题时，先怀疑 filter 翻译层，直接看
  `pg.unknown_op` warning 日志。

## 20. 前端"改了没变化"第三形态：预渲染 HTML 被缓存一年（2026-07-26）

### 现象
重新 build + 重启后，服务端 HTML 已引用新 chunk、磁盘产物也正确，
但用户浏览器看到的还是旧页面。

### 根因
Next.js 静态预渲染页面默认响应头 `Cache-Control: s-maxage=31536000`
（`x-nextjs-prerender: 1`）——HTML 文档被浏览器/中间代理（远程访问的
端口转发/预览代理是 shared cache，会执行 s-maxage）缓存长达一年。
旧 HTML 引用旧 chunk 哈希，新旧产物替换后用户端毫无感知。

### 排查路径（"前端没变"三步定位）
1. `grep <特征串> .next/static/chunks/**` —— 产物里有没有（没有=没 build 进去）；
2. `curl -s localhost:3000/<page> | grep -o chunk哈希` 对比磁盘文件名 —— 服务端发的对不对；
3. `curl -sI localhost:3000/<page> | grep -i cache-control` —— 是不是被缓存了。
前两步对、第三步是 `s-maxage=31536000` → 本坑。

### 修复
`next.config.ts` 加 `headers()`：HTML 路由 `Cache-Control: no-cache, must-revalidate`
（排除 `_next/static` 等带哈希资源，保持 immutable）。
**注意**：已按旧头缓存的客户端需一次硬刷新（Ctrl+Shift+R）才能脱坑。

### 防范
内部工具/频繁重构建的前端，HTML 一律 no-cache；只让带内容哈希的静态资源长缓存。

## 21. 训练落库 "can't adapt type 'dict'"：列缺失 + 类型探测缓存毒化（2026-07-26）

### 现象
训练 fitting 完成、模型已传 MinIO 后，`client.insert("models", {...})` 抛
`psycopg2.ProgrammingError: can't adapt type 'dict'`，训练失败。

### 根因（双层）
1. **迁移漏执行**：`migrations/006_alter_models_training_result.sql`（models 加
   `feature_importance JSONB`）未应用到当前库（07-25 devcloud 恢复的 dump 早于 006）。
   `_col_type` 在 information_schema 查不到该列 → 返回空串 → dict 不经 `Json()` 适配，
   psycopg2 客户端侧直接报错（SQL 根本没发到 DB，所以不是"column does not exist"）。
2. **缓存毒化**：`_col_type` 把空结果也永久缓存，即使补上列，进程内依旧按
   非 jsonb 处理，必须重启才能恢复。

### 修复
- 应用 006 迁移补列（`ADD COLUMN IF NOT EXISTS`，幂等）；
- `_col_type` 空结果不缓存（列后补/探测瞬断可自愈）；
- 重启 celery worker 清掉已毒化的进程内缓存。

### 防范
- "can't adapt type 'X'" 先查**列是否存在**（`information_schema.columns`），
  再查类型探测日志 `pg.col_type.failed`；
- 恢复数据库 dump 后，按 `migrations/` 序号逐个核对已应用的迁移
  （`ls migrations/*.sql` vs 实际表结构抽查）；
- 会失败的临时探测结果一律不进永久缓存。

## 22. 训练模型退化为单叶常数（AUC=0.5、重要度全 0、零正类预测）（2026-07-27）

### 现象
训练"成功"但训练/验证 AUC 精确 0.5000、特征重要度全 0、模型文件仅几 KB、
混淆矩阵全判负类。

### 根因（两个叠加）
1. **整行 dropna 把样本饿死**：`train_lightgbm` 原来按「任一特征缺失」丢整行，
   70 个含稀疏因子的特征取交集后 1 年区间仅剩 ~1700 样本（早期每天 ~7 个）。
   ——LightGBM 原生支持 NaN（分裂自动学默认方向），根本不用整行丢。
2. **min_child_samples 不随样本量缩放**：默认 100 / 调参网格 200~400，
   464 个训练样本下叶子约束 ≥200 → 树无法分裂 → 单叶常数模型，
   且不报任何错。

### 修复
- dropna 改 `how="all"`（只丢全部特征缺失的行）；
- 默认与调参网格的 min_child_samples 都按训练样本量收缩
  （`min(原值, max(20, n//10))`，调参网格按最小训练折 40% 算）；
- 新增退化检测：双 AUC<0.52 → `metrics_table.degenerate=true` + 
  `train.degenerate` 告警日志 + 结果页红色告警；训练样本 <1000 黄色提示。

### 防范
- "成功但 AUC=0.5"必须视为事故而不是"模型不行"——先查样本量和叶子约束；
- 所有"最小样本"类超参（min_child_samples/min_samples_leaf）都要随 n 缩放；
- 涉及丢弃样本的逻辑，先想清楚引擎是否原生支持缺失值。

## 23. Booster.feature_name() 返回 Column_i：按模型内列名对齐特征 = 全 NaN 静默失效（2026-07-27）

### 现象
真实回测引擎 predict 报 `The number of features in data (273) is not equal to
the number of features in model (327)`；改成按 `booster.feature_name()` 对齐后
不报错了，但日志出现 `feature_missing_filled_nan n_missing=327`——**所有列全被
补成 NaN**，预测退化为基线概率，0 信号 0 交易，且不抛任何异常。

### 根因
训练时 `X = data[feature_cols].values` 传的是 **numpy 数组**，LightGBM Booster
内部记录的特征名是占位符 `Column_0...Column_326`，与真实因子列名毫无关系。
按 `feature_name()` 去 DataFrame 找列必然全 miss → 全 NaN。
273 vs 327 的差异另有原因：`models.input_features` 含 54 个 peer 衍生列
（`__rank_industry` 等），回测窗口内部分基础因子无数据导致缺列。

### 修复
`python-services/backtest-svc/real_engine.py`：按 `models.input_features` 的
**原始顺序**重建矩阵（这才是训练时 `feature_cols` 的真实快照），缺列补 NaN
（LightGBM 原生支持），最后 `.values` 传 numpy 与训练侧口径一致；并校验
`len(input_features) == booster.num_feature()`，不一致直接报错拒绝预测。

### 防范
- 训练用 numpy 喂 LightGBM 时，`feature_name()` 只有 `Column_i`，**跨服务复现
  预测必须依赖外部保存的列名快照**（本项目为 `models.input_features`）；
- "补 NaN 数量 == 特征总数"应视为致命错误而非 warning——对齐逻辑写反了；
- 冒烟验证不能只看"接口 200 + 结构齐全"，要看 n_signals/交易数是否合理。

## 24. select_all 的 LIMIT/OFFSET 深分页：真实回测 87s 超时（2026-07-27）

### 现象
模型回测（model 类型，run-fast 接口）前端报 `Request timeout after 15000ms`；
后端该请求实际耗时 ~85s，几乎全耗在 build_dataset 的 fetch_features 上。

### 根因
`python-services/common/supabase_client.py` 的 `select_all` 用
`LIMIT page_size OFFSET k` 循环分页拉全量。回测窗口内 feature_values 约 270 万行
（273 基础因子 × 同业池 ~80 × ~126 交易日），page_size=10000 → 约 270 次查询；
PostgreSQL 对大 OFFSET 需扫描并跳过前 N 行，最后一次 OFFSET 达 260 万 → 单次查询
就很慢，270 次叠加成 ~87s。训练时该耗时被异步 Celery 任务掩盖（用户无感），
同步的回测接口直接暴露。

### 修复
- `train-svc/pipeline.py`：fetch_features / build_dataset 增加 page_size 参数
  （默认 10000，训练行为不变，向后兼容）；
- `backtest-svc/real_engine.py`：调用 build_dataset 传 feature_page_size=1_000_000，
  每个 50 因子分块一次性拉完，分页从 ~270 次降到 ~6 次，且不再有深 OFFSET；
- `backtest-svc/main.py`：run-fast 真实引擎改由线程池
  `await loop.run_in_executor(None, run_real_backtest, ...)` 执行，避免 ~17s 阻塞
  event loop（否则整服务在回测期间无法响应其他请求）；
- `apps/web/src/lib/sdk.ts`：前端全局 timeoutMs 15_000 → 120_000。

### 防范
- 分页拉大表务必避免 OFFSET 深分页：优先 keyset/游标分页（基于有序主键），
  或在已知结果集有限时一次性大页拉完；
- 同步 HTTP 接口里跑重型数据拉取/特征工程，应放进线程池或改异步任务队列，
  否则会阻塞整个服务 event loop；
- 前端默认 15s 超时对「真实计算」类请求过短，应区分快速查询与重型任务超时。

### 验证
build_dataset 87.55s → 16.47s（提速 ~5.3×）；整体回测 ~17s 落在 120s 超时内；冒烟全绿。

---

## 25. backtest worker 模块名冲突：backtest.run_backtest 永不注册，任务卡 pending（2026-07-27）

### 现象
`POST /api/v1/backtests` 返回 200（bt_id + status=pending），但任务永远停在 pending，轮询 `GET /{id}` 一直是 pending、progress 始终 null；celery worker 进程在、日志 `Connected to redis` 且 `ready`，但 `backtest.run_backtest` 不消费。

### 根因
backtest worker 原本用 `celery -A celery_worker.celery_app` 启动（文件 `python-services/backtest-svc/celery_worker.py`），而 train-svc 也有同名 `celery_worker.py`。`start-celery.sh` 的 PYTHONPATH 把 train-svc 排在 backtest-svc 之前，import `celery_worker` 时**加载到 train-svc 的模块** → backtest worker 实际只注册了 `train.*` 任务，`backtest.run_backtest` 从未注册；`send_task` 把消息投进 `backtest` 队列，却无 worker 认领 → 永久 pending。（与 `task_routes` 把 `backtest.*` 路由到 `backtest` 队列无关，是 worker 本身没注册该任务。）

### 修复
- 把 backtest-svc 的 worker 模块重命名为 **`backtest_celery.py`**（唯一名，不再与 train-svc 冲突）；
- `start-celery.sh` 改为 `celery -A backtest_celery.celery_app worker --queues=backtest ...`；
- 重启 worker：`ps` 确认命令行是 `backtest_celery.celery_app`，启动日志 `[tasks]` 列表出现 `. backtest.run_backtest`。

### 防范
- 多服务共用 `common.celery_app` 时，**每个服务的 worker 模块名必须唯一**（不要都叫 `celery_worker`）；
- 新增 celery 任务后，启动 worker 必看 `[tasks]` 列表确认任务已注册，再投 task；
- PYTHONPATH 顺序敏感：同名模块谁在前谁被优先 import，跨服务重名是大雷。

### 验证
重命名并重启后重新 `POST`：`pending→running(30%)→completed(100%)`，summary 等指标落库。

---

## 26. feature_values 列是 value_num/value_bool 而非 value；Celery 缓存旧模块需重启 worker（2026-07-28）

### 现象
- 横截面回测读 `feature_values` 报 `UndefinedColumn: column feature_values.value does not exist`（原 mock 用 `value` 列名）；
- 改 `real_engine.py` 后跑回测，仍走旧逻辑（factor 走 mock、`meta` 为 null），源码改动不生效。

### 根因
- `feature_values` 表实际列是 `factor_id, symbol, date, value_num, value_bool`（数值因子落 `value_num`，布尔因子落 `value_bool`），并不存在 `value` 列；
- Celery worker 进程启动时就把 `real_engine` 等模块 import 进内存并缓存，**编辑源码不会自动重载**，必须重启 worker 才生效（即便 `main.py` 的 run-fast 走线程池即时加载，投进 Celery 队列的任务仍用旧模块）。

### 修复
- 读因子值按类型分流：`value_num`（数值，NaN 视为缺失）与 `value_bool`（布尔，None 视为缺失），不要读 `value`；
- 每次改动 `real_engine.py` / `backtest_celery.py` 后：`pkill -f backtest_celery` 再 `start-celery.sh` 重启 worker；确认启动日志 `[tasks]` 含 `backtest.run_backtest` 且时间戳为最新。

### 防范
- 改表结构/列名相关代码前，先 `SELECT` 确认列名，不要凭 mock 推断；
- 凡是经 Celery 执行的代码改动，**必须重启 worker**，不要指望热重载；本地 run-fast（线程池）改动能即时生效，但验证完整链路务必用重启后的 worker。

### 验证
factor / composite / signal_file 端到端跑通，`meta` 含 `engine: real_xsec`、holdings、in_sample 等，不再报 `UndefinedColumn`。

---

## 27. 回测净值曲线三序列量纲不一致导致组合线被压扁、左轴数值错乱（2026-07-28）

### 现象
模型回测结果页：组合净值曲线左轴显示 ~90 万量级、组合线被压到图底（看似净值 0.89），与 summary 的 total_return +18.51% 对不上；「指数K线」与「002662(buy&hold)」图例文字重叠。

### 根因
`real_engine` 对 model 回测返回的 `equity_curve` 三个数组量纲不同：
- `portfolio` = `equity / initial_capital` → 净值比（~1.0）
- `benchmark` = `initial_capital * price / b0` → 绝对资金（~100 万）
- `benchmark_price` = 原始收盘价（~10–20）

前端 `EquityChart` 原代码把三者直接画在同一坐标轴，`all = [...portfolio, ...benchmark, ...bpNorm]` 的 min/max 被资金量级（~100 万）主导，组合净值比（~1.0）被压到坐标轴底部，左轴刻度变成资金值而非净值，用户误以为数值错误。

### 修复
`EquityChart` 改为先归一成净值比：`toRatio(a) = a.map(v => v / a[0])`，三条序列起点统一为 1.0（=初始资金）后同图绘制；左轴标注「净值（起点 1.0 = 初始资金）」；图例精简为「组合净值 / 基准 / 指数K线」并拉开间距；图下加一行说明基准=目标股买入持有（被动对照，非模型交易）。

### 防范
绘制多序列对比图时，先确认各序列量纲，必须统一到同一可比尺度（净值比或统一货币）再画；不可直接拼不同量纲数组求 min/max。

### 验证
`tsc --noEmit` 通过；归一化后组合终点 1.185 与 total_return +18.51% 一致。
