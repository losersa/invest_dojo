"use client";

// ============================================================
// 因子库列表页 — Raycast Design System
// 分类侧栏 + 搜索 + 标签筛选 + 因子卡片网格 + 分页
// ============================================================

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ApiError, type Factor, type FactorCategory, type FactorCategoryCount } from "@investdojo/api";
import { sdk } from "@/lib/sdk";
import { UserNav } from "@/components/UserNav";

const PAGE_SIZE = 24;

const CATEGORY_META: Record<FactorCategory | "all", { label: string; icon: string }> = {
  all: { label: "全部", icon: "🗂️" },
  technical: { label: "技术面", icon: "📈" },
  valuation: { label: "估值", icon: "💰" },
  growth: { label: "成长", icon: "🌱" },
  sentiment: { label: "情绪", icon: "🔥" },
  fundamental: { label: "基本面", icon: "🏛️" },
  macro: { label: "宏观", icon: "🌐" },
  custom: { label: "自定义", icon: "⚙️" },
};

const OUTPUT_TYPE_LABEL: Record<string, string> = {
  boolean: "信号",
  scalar: "数值",
  rank: "排名",
};

export function FactorsPage() {
  // 筛选状态
  const [activeCategory, setActiveCategory] = useState<FactorCategory | "all">("all");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [owner, setOwner] = useState<"all" | "platform" | "user">("all");
  const [sort, setSort] = useState("-updated_at");
  const [page, setPage] = useState(1);

  // 数据
  const [factors, setFactors] = useState<Factor[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<FactorCategoryCount[]>([]);

  // 首次加载 categories
  useEffect(() => {
    sdk.factors
      .listCategories()
      .then((res) => setCategories(res.data))
      .catch(() => {
        /* 分类加载失败不致命 */
      });
  }, []);

  // 搜索防抖
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // 取因子列表
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    sdk.factors
      .listFactors({
        category: activeCategory === "all" ? undefined : activeCategory,
        owner,
        visibility: "public",
        search: search || undefined,
        sort,
        include_stats: false,
        page,
        page_size: PAGE_SIZE,
      })
      .then((res) => {
        if (!alive) return;
        setFactors(res.data);
        setTotal(res.pagination.total);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof ApiError ? `[${e.code}] ${e.message}` : String(e));
        setFactors([]);
        setTotal(0);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [activeCategory, search, owner, sort, page]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const categoryList = useMemo(() => {
    const totalCount = categories.reduce((s, c) => s + c.count, 0);
    return [
      { category: "all" as const, label: "全部", count: totalCount },
      ...categories,
    ];
  }, [categories]);

  return (
    <div className="min-h-screen bg-rc-bg">
      {/* Nav */}
      <nav className="sticky top-0 z-50 bg-rc-bg border-b border-rc-border">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-[20px] font-semibold text-white tracking-[0.2px]">
              InvestDojo
            </Link>
            <span className="text-rc-text-dark">/</span>
            <span className="text-[14px] text-rc-text-muted tracking-[0.2px]">因子库</span>
          </div>
          <UserNav />
        </div>
      </nav>

      {/* Hero */}
      <section className="text-center px-6 pt-[60px] pb-[40px]">
        <h1 className="text-section-display text-white">量化因子库</h1>
        <p className="mt-3 text-body-lg text-rc-text-secondary max-w-[640px] mx-auto">
          {total > 0 ? `${total} 个` : "200+"} 可计算因子 · 技术面 / 基本面 / 估值 / 成长 / 情绪全覆盖
        </p>
      </section>

      {/* Main */}
      <section className="max-w-[1400px] mx-auto px-6 pb-[100px]">
        <div className="grid grid-cols-[220px_1fr] gap-8">
          {/* ── Sidebar ── */}
          <aside className="sticky top-[80px] self-start">
            <h3 className="text-[12px] uppercase tracking-[0.3px] text-rc-text-dim font-rc-mono mb-3">
              分类
            </h3>
            <div className="flex flex-col gap-1">
              {categoryList.map((c) => {
                const meta =
                  CATEGORY_META[(c.category as FactorCategory | "all") ?? "custom"] ??
                  CATEGORY_META.custom;
                const active = activeCategory === c.category;
                return (
                  <button
                    key={c.category}
                    onClick={() => {
                      setActiveCategory(c.category as FactorCategory | "all");
                      setPage(1);
                    }}
                    className={`text-left px-3 py-2 rounded-[6px] flex items-center justify-between transition-colors duration-150 ${
                      active
                        ? "bg-rc-surface-card text-white"
                        : "text-rc-text-muted hover:text-white hover:bg-rc-surface-100"
                    }`}
                  >
                    <span className="flex items-center gap-2 text-[14px] tracking-[0.2px]">
                      <span>{meta.icon}</span>
                      {meta.label}
                    </span>
                    <span className="text-[12px] font-rc-mono text-rc-text-dim">{c.count}</span>
                  </button>
                );
              })}
            </div>

            <h3 className="text-[12px] uppercase tracking-[0.3px] text-rc-text-dim font-rc-mono mt-6 mb-3">
              来源
            </h3>
            <div className="flex flex-col gap-1">
              {(
                [
                  { key: "all" as const, label: "全部" },
                  { key: "platform" as const, label: "官方因子" },
                  { key: "user" as const, label: "用户贡献" },
                ]
              ).map((o) => {
                const active = owner === o.key;
                return (
                  <button
                    key={o.key}
                    onClick={() => {
                      setOwner(o.key);
                      setPage(1);
                    }}
                    className={`text-left px-3 py-2 rounded-[6px] text-[14px] tracking-[0.2px] transition-colors duration-150 ${
                      active
                        ? "bg-rc-surface-card text-white"
                        : "text-rc-text-muted hover:text-white hover:bg-rc-surface-100"
                    }`}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          </aside>

          {/* ── Content ── */}
          <div>
            {/* Toolbar */}
            <div className="flex items-center gap-3 mb-5">
              <div className="flex-1 relative">
                <input
                  type="text"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="🔎 搜索因子名 / 描述（如 双均线、ROE、放量）"
                  className="w-full bg-rc-surface-input border border-rc-border-input rounded-[8px] px-4 py-2.5 text-[14px] text-rc-text-primary placeholder:text-rc-text-dim focus:outline-none focus:border-rc-blue transition-colors"
                />
              </div>
              <select
                value={sort}
                onChange={(e) => {
                  setSort(e.target.value);
                  setPage(1);
                }}
                className="bg-rc-surface-input border border-rc-border-input rounded-[8px] px-3 py-2.5 text-[14px] text-rc-text-secondary focus:outline-none focus:border-rc-blue"
              >
                <option value="-updated_at">最近更新</option>
                <option value="-created_at">最新创建</option>
                <option value="name">名称 A→Z</option>
                <option value="-version">版本高→低</option>
              </select>
            </div>

            {/* State */}
            {error && (
              <div className="rc-card border-rc-red/40 text-rc-red text-[14px] mb-5">
                加载失败：{error}
              </div>
            )}

            {loading ? (
              <FactorGridSkeleton />
            ) : factors.length === 0 ? (
              <div className="rc-card text-center py-16 text-rc-text-dim">
                {search ? `未找到匹配 "${search}" 的因子` : "暂无因子"}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {factors.map((f) => (
                  <FactorCard key={f.id} factor={f} />
                ))}
              </div>
            )}

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 mt-8">
                <button
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="px-3 py-1.5 rounded-[6px] border border-rc-border-btn text-[14px] text-rc-text-secondary disabled:opacity-30 hover:bg-rc-surface-100"
                >
                  ← 上一页
                </button>
                <span className="text-[13px] font-rc-mono text-rc-text-muted px-3">
                  {page} / {totalPages}
                </span>
                <button
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="px-3 py-1.5 rounded-[6px] border border-rc-border-btn text-[14px] text-rc-text-secondary disabled:opacity-30 hover:bg-rc-surface-100"
                >
                  下一页 →
                </button>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

// ────────────────────────────────────────────
// Card
// ────────────────────────────────────────────

function FactorCard({ factor }: { factor: Factor }) {
  const meta = CATEGORY_META[factor.category] ?? CATEGORY_META.custom;
  const isPlatform = factor.owner === "platform";

  return (
    <Link
      href={`/factors/${encodeURIComponent(factor.id)}`}
      className="group rc-card-feature p-5 transition-all duration-150 hover:translate-y-[-2px] hover:border-rc-blue/40"
    >
      {/* Row 1: 分类 + output_type + 版本 */}
      <div className="flex items-center justify-between mb-3">
        <span className="rc-badge text-[11px] tracking-[0.2px] inline-flex items-center gap-1">
          <span>{meta.icon}</span>
          {meta.label}
        </span>
        <div className="flex items-center gap-2 text-[11px] font-rc-mono">
          <span className="text-rc-blue">{OUTPUT_TYPE_LABEL[factor.output_type] ?? factor.output_type}</span>
          <span className="text-rc-text-dim">v{factor.version}</span>
        </div>
      </div>

      {/* Name */}
      <h3 className="text-[16px] font-medium text-white leading-snug mb-1 tracking-[0.2px] group-hover:text-rc-blue transition-colors">
        {factor.name}
      </h3>
      {factor.name_en && (
        <p className="text-[11px] font-rc-mono text-rc-text-dim mb-2">{factor.name_en}</p>
      )}

      {/* Description */}
      <p className="text-[13px] text-rc-text-secondary leading-relaxed line-clamp-2 min-h-[34px]">
        {factor.description || <span className="text-rc-text-dim">（无描述）</span>}
      </p>

      {/* Formula preview */}
      <pre className="mt-3 px-3 py-2 rounded-[6px] bg-rc-surface-input border border-rc-border-subtle text-[11px] font-rc-mono text-rc-text-tertiary overflow-hidden whitespace-nowrap text-ellipsis">
        {factor.formula}
      </pre>

      {/* Footer */}
      <div className="flex items-center justify-between mt-3 text-[11px] text-rc-text-muted">
        <div className="flex items-center gap-2 min-w-0">
          {factor.tags.slice(0, 2).map((tag) => (
            <span
              key={tag}
              className="px-1.5 py-0.5 rounded-[4px] bg-rc-surface-card text-rc-text-muted border border-rc-border-subtle truncate max-w-[80px]"
            >
              #{tag}
            </span>
          ))}
        </div>
        <span className="font-rc-mono text-rc-text-dim shrink-0">
          {isPlatform ? "⭐ 官方" : factor.owner.slice(0, 8)}
        </span>
      </div>
    </Link>
  );
}

function FactorGridSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {Array.from({ length: 9 }).map((_, i) => (
        <div key={i} className="rc-card h-[200px] animate-pulse" />
      ))}
    </div>
  );
}
