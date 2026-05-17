# InvestDojo 测试流程参考

## 自动化测试体系

### Python 后端测试

**测试框架**: pytest + pytest-asyncio
**测试目录**: `python-services/tests/`
**已有测试**:
- `test_factor_crud.py` — 因子 CRUD 模型验证、公式推断、辅助函数
- `test_builtin_factors.py` — 内置因子 DSL 解析

**运行方式**:
```powershell
cd investdojo/python-services
$env:PYTHONPATH = "."

# 运行全部测试
python -m pytest tests/ -v

# 只跑单元测试
python -m pytest tests/ -v -m "unit"

# 只跑集成测试（需要 Supabase 运行）
python -m pytest tests/ -v -m "integration"

# 跑特定文件
python -m pytest tests/test_factor_crud.py -v

# 带覆盖率
python -m pytest tests/ -v --cov=feature-svc --cov=data-svc --cov=common --cov-report=term-missing
```

**标记约定**:
- `@pytest.mark.unit` — 纯单元测试，不依赖外部服务
- `@pytest.mark.integration` — 需要 Supabase/Redis/MinIO

### 前端测试

**测试框架**: vitest + @testing-library/react
**配置文件**: `apps/web/vitest.config.ts`

**运行方式**:
```powershell
cd investdojo
pnpm --filter @investdojo/web test        # 运行测试
pnpm --filter @investdojo/web test -- --run   # CI 模式（不 watch）
```

**测试文件命名**:
- `src/**/*.test.ts` 或 `src/**/*.test.tsx`
- 放在被测文件同目录或 `__tests__/` 目录下

**测试模板**:
```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
// import { ComponentToTest } from './ComponentToTest';

describe('ComponentName', () => {
  it('renders correctly', () => {
    // render(<ComponentToTest />);
    // expect(screen.getByText('...')).toBeInTheDocument();
  });
});
```

### API 接口测试（curl/httpx）

**健康检查**:
```powershell
# 检查所有服务
@(8001,8002,8003,8004,8005,8006) | ForEach-Object {
  try { $r = Invoke-WebRequest "http://localhost:$_/health" -TimeoutSec 3; "  :$_ OK" }
  catch { "  :$_ FAIL" }
}
```

**因子 API 测试**:
```powershell
# 列表
curl http://localhost:8001/api/v1/factors?page_size=3

# 创建
curl -X POST http://localhost:8001/api/v1/factors `
  -H "Content-Type: application/json" `
  -H "X-User-Id: test-user-001" `
  -d '{"name":"test_factor","formula":"RSI(14) < 30","category":"technical"}'

# 发布
curl -X POST http://localhost:8001/api/v1/factors/{factor_id}/publish `
  -H "X-User-Id: test-user-001"

# 撤销发布
curl -X POST http://localhost:8001/api/v1/factors/{factor_id}/unpublish `
  -H "X-User-Id: test-user-001"

# 删除
curl -X DELETE http://localhost:8001/api/v1/factors/{factor_id} `
  -H "X-User-Id: test-user-001"
```

**K 线 API 测试**:
```powershell
curl "http://localhost:8006/api/v1/klines?symbols=600519&start=2024-10-01&end=2024-10-05&timeframe=5m"
```

**数据库直查**:
```powershell
# 通过 PostgREST
curl "http://localhost:8000/rest/v1/symbols?select=symbol,name&limit=5" `
  -H "apikey: <ANON_KEY>"

# 通过 docker exec
docker exec -it investdojo-db psql -U postgres -d postgres -c "SELECT count(*) FROM klines_all;"
```

## E2E 浏览器测试

使用 `agent-browser` skill 进行浏览器自动化测试。

### 测试清单模板

#### 因子库功能

| # | 测试项 | 步骤 | 预期结果 |
|---|--------|------|----------|
| 1 | 因子列表加载 | 打开 /factors | 显示因子卡片网格，有分类侧栏 |
| 2 | 分类筛选 | 点击「技术面」 | 只显示 technical 因子 |
| 3 | 来源筛选-官方 | 点击「官方因子」 | 只显示 owner=platform 的因子 |
| 4 | 来源筛选-用户发布 | 点击「用户发布」 | 只显示 visibility=public 的用户因子 |
| 5 | 来源筛选-我的 | 登录后点击「我的因子」 | 显示当前用户所有因子（含私有） |
| 6 | 搜索 | 输入关键词 | 实时筛选匹配的因子 |
| 7 | 因子详情 | 点击因子卡片 | 跳转详情页，显示公式、表现统计 |
| 8 | 创建因子 | 填写表单，点保存 | 成功创建，跳转详情页 |
| 9 | 发布因子 | 在详情页点「发布」 | visibility 变为 public |
| 10 | 撤销发布 | 在详情页点「撤销发布」 | visibility 变回 private |
| 11 | 删除因子 | 在详情页点「删除」 | 因子被删除，跳转列表 |
| 12 | 收藏 | 点击收藏按钮 | 按钮变红，收藏状态持久化 |

#### K 线页面

| # | 测试项 | 步骤 | 预期结果 |
|---|--------|------|----------|
| 1 | 默认加载 | 打开 /kline | 显示默认股票的 K 线图 |
| 2 | 搜索股票 | 输入 600519 | 显示贵州茅台 K 线 |
| 3 | 切换周期 | 点击 15m/1h/1d/1w | K 线数据正确切换 |
| 4 | 状态持久化 | 切换到其他页面再回来 | 股票和周期保持不变 |

#### 认证

| # | 测试项 | 步骤 | 预期结果 |
|---|--------|------|----------|
| 1 | 注册 | 填写邮箱密码注册 | 注册成功 |
| 2 | 登录 | 填写邮箱密码登录 | 登录成功，导航栏显示用户 |
| 3 | 登出 | 点击登出 | 回到未登录状态 |
| 4 | 未登录限制 | 未登录创建因子 | 提示需要登录 |

## 变更类型 → 测试范围映射

| 变更类型 | 自动化测试 | API 验证 | E2E 浏览器 |
|----------|-----------|---------|-----------|
| Python 后端逻辑 | pytest 单元测试 | curl 接口验证 | - |
| 数据库 Schema / RLS | pytest 集成测试 | PostgREST 查询 | - |
| 前端组件 | vitest 组件测试 | - | agent-browser 页面验证 |
| 前端页面（新页面） | - | - | agent-browser 完整流程 |
| API SDK (packages/api) | pytest + vitest | curl 端到端 | agent-browser |
| 数据种子脚本 | 脚本直接运行 | DB 查询验证行数 | - |
| Docker/基础设施 | health_check.ps1 | 端口探测 | - |
| 全栈功能（跨层） | 全部 | 全部 | agent-browser |
