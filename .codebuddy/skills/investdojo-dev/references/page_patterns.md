# InvestDojo 前端页面开发模式

## 目录约定

```
apps/web/src/
├── app/                    ← Next.js App Router 页面
│   ├── kline/
│   │   └── page.tsx        ← 路由入口（"use client" 或 server component）
│   ├── factors/
│   │   ├── FactorsPage.tsx ← 客户端组件（业务逻辑）
│   │   ├── page.tsx        ← 路由入口，渲染 <FactorsPage />
│   │   ├── new/
│   │   │   └── page.tsx    ← 创建因子页
│   │   └── [factorId]/
│   │       ├── page.tsx
│   │       └── FactorDetailPage.tsx
│   └── layout.tsx          ← 根布局
├── components/
│   └── MainNav.tsx         ← 全局导航栏
├── hooks/
│   └── useFavoriteFactors.ts  ← 自定义 hook（useSyncExternalStore）
└── lib/
    ├── sdk.ts              ← SDK 单例（含 userId 缓存）
    └── supabase/
        └── client.ts       ← Supabase 浏览器端客户端
```

## 新页面脚手架

### 1. 创建路由文件

```
apps/web/src/app/<page-name>/page.tsx
```

### 2. 页面组件模板

```tsx
"use client";

import React, { useEffect, useState } from "react";
import { MainNav } from "@/components/MainNav";
import { sdk, ensureUserId } from "@/lib/sdk";

export default function MyPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    // 加载数据...
    sdk.someClient.someMethod()
      .then((res) => alive && setData(res.data))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  return (
    <div className="min-h-screen bg-rc-bg">
      <MainNav />
      <main className="max-w-[1200px] mx-auto px-6 py-6">
        {loading ? (
          <div className="rc-card h-[300px] animate-pulse" />
        ) : (
          // 页面内容
          <div>{/* ... */}</div>
        )}
      </main>
    </div>
  );
}
```

## 设计系统（Raycast-inspired）

### CSS 变量前缀 `rc-`

| 类名 | 说明 |
|------|------|
| `bg-rc-bg` | 页面背景 |
| `text-rc-text-primary` | 主文字 |
| `text-rc-text-secondary` | 次要文字 |
| `text-rc-text-dim` | 暗淡文字 |
| `text-rc-blue` | 强调蓝 |
| `text-rc-red` / `text-rc-green` | 涨/跌色 |
| `rc-card` | 标准卡片 |
| `rc-card-feature` | 特色卡片（有边框高亮） |
| `rc-badge` | 徽章标签 |
| `rc-btn-primary` | 主按钮 |
| `font-rc-mono` | 等宽字体 |
| `border-rc-border-subtle` | 细微边框 |
| `bg-rc-surface-input` | 输入框背景 |
| `bg-rc-surface-card` | 卡片表面 |

### 字体系统

- 正文: `text-[13px]` ~ `text-[14px]`
- 标题: `text-[16px]` ~ `text-[28px]`
- 标签/badge: `text-[11px]` ~ `text-[12px]`
- 等宽数据: `font-rc-mono`

## SDK 使用模式

### 读操作

```tsx
import { sdk } from "@/lib/sdk";
const res = await sdk.factors.listFactors({ category: "technical", page: 1 });
```

### 写操作（需要 userId）

```tsx
import { sdk, ensureUserId } from "@/lib/sdk";

// 写操作前先确保 userId 已缓存
await ensureUserId();
await sdk.factors.publishFactor(factorId);
```

### 获取当前用户

```tsx
import { createClient } from "@/lib/supabase/client";

const supabase = createClient();
const { data: { user } } = await supabase.auth.getUser();
// 或更快的本地 session：
const { data: { session } } = await supabase.auth.getSession();
```

## 因子 DSL 公式系统

### 支持的函数

```
SMA(period)    EMA(period)    RSI(period)
MACD()         BOLL(period)   ATR(period)
RANK(field)    ZSCORE(field)  MAX(field,period)
MIN(field,period) STDDEV(field,period) DELTA(field,period)
```

### 支持的比较运算符

```
>  <  >=  <=  ==  !=  cross_up  cross_down  and  or
```

### 支持的字段

```
close  open  high  low  volume  amount  pct_chg  turn
```

### 示例

```
RSI(14) < 30                     # Boolean 信号
SMA(5) cross_up SMA(20)          # 均线金叉
(close - SMA(20)) / SMA(20)      # 偏离率 Scalar
RANK(volume)                     # 排名
```
