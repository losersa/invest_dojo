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
