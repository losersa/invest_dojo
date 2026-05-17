"use client";

/**
 * 创建自定义因子页面
 *
 * 功能：
 * - DSL 公式编辑器 + 实时校验
 * - 预览计算结果
 * - 分类/标签选择
 * - 保存为私有因子
 *
 * 路由：/factors/new
 */

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { sdk, ensureUserId } from "@/lib/sdk";
import { MainNav } from "@/components/MainNav";

const CATEGORIES = [
  { value: "technical", label: "技术面", icon: "📈" },
  { value: "valuation", label: "估值", icon: "💰" },
  { value: "growth", label: "成长", icon: "🌱" },
  { value: "sentiment", label: "情绪", icon: "🔥" },
  { value: "fundamental", label: "基本面", icon: "🏛️" },
  { value: "macro", label: "宏观", icon: "🌐" },
  { value: "custom", label: "自定义", icon: "⚙️" },
];

const COMMON_TAGS = ["趋势", "短线", "中线", "动量", "反转", "量能", "突破", "经典", "风控", "估值", "成长", "ROE"];

const FORMULA_EXAMPLES = [
  { label: "均线金叉", formula: "MA(close,5) cross_up MA(close,20)" },
  { label: "RSI 超卖", formula: "RSI(14) cross_up 30" },
  { label: "放量上涨", formula: "volume > MA(volume,20) * 2 AND close > open" },
  { label: "布林突破", formula: "close > MA(close,20) + STD(close,20) * 2" },
  { label: "PE 低估", formula: "pe_ttm < 15" },
  { label: "ROE 优秀", formula: "roe > 15" },
];

const DSL_FUNCTIONS = [
  "MA(field, N)", "EMA(field, N)", "STD(field, N)",
  "MAX(field, N)", "MIN(field, N)", "RSI(N)",
  "DIFF(field, N)", "PCT(field, N)", "RANK(field)",
  "cross_up", "cross_down", "AND", "OR", "NOT",
];

const DSL_FIELDS = [
  "close", "open", "high", "low", "volume", "turnover",
  "pe_ttm", "roe", "gp_margin", "np_margin", "yoy_ni",
  "market_cap", "debt_asset_ratio", "current_ratio",
];

// DSL 帮助文档内容
const DSL_HELP = {
  functions: [
    { name: "MA(field, N)", desc: "N 日简单移动平均", example: "MA(close, 20)" },
    { name: "EMA(field, N)", desc: "N 日指数移动平均", example: "EMA(close, 12)" },
    { name: "STD(field, N)", desc: "N 日滚动标准差", example: "STD(close, 20)" },
    { name: "MAX(field, N)", desc: "N 日滚动最大值", example: "MAX(high, 60)" },
    { name: "MIN(field, N)", desc: "N 日滚动最小值", example: "MIN(low, 60)" },
    { name: "RSI(N)", desc: "N 日相对强弱指数（0~100）", example: "RSI(14)" },
    { name: "DIFF(field, N)", desc: "与 N 日前的差值", example: "DIFF(close, 1)" },
    { name: "PCT(field, N)", desc: "与 N 日前的涨跌幅", example: "PCT(close, 5)" },
    { name: "RANK(field)", desc: "横截面排名（0~1）", example: "RANK(close)" },
  ],
  operators: [
    { name: "cross_up", desc: "左边从下方穿越右边（金叉）", example: "MA(close,5) cross_up MA(close,20)" },
    { name: "cross_down", desc: "左边从上方穿越右边（死叉）", example: "MA(close,5) cross_down MA(close,20)" },
    { name: "> < >= <= == !=", desc: "比较运算", example: "close > MA(close,60)" },
    { name: "AND", desc: "逻辑与（两个条件同时满足）", example: "RSI(14) < 30 AND volume > MA(volume,20)" },
    { name: "OR", desc: "逻辑或（任一条件满足）", example: "RSI(14) < 20 OR RSI(14) > 80" },
    { name: "NOT", desc: "逻辑非", example: "NOT (close > open)" },
    { name: "+ - * /", desc: "四则运算", example: "MA(close,20) + STD(close,20) * 2" },
  ],
  fields: {
    "行情字段": ["close（收盘价）", "open（开盘价）", "high（最高价）", "low（最低价）", "volume（成交量）", "turnover（换手率）", "preclose（昨收）"],
    "基本面字段": ["pe_ttm（滚动PE）", "roe（ROE）", "gp_margin（毛利率%）", "np_margin（净利率%）", "eps_ttm（滚动EPS）", "revenue（营收）", "net_profit（净利润）"],
    "成长字段": ["yoy_ni（净利润同比%）", "yoy_pni（归母净利同比%）", "yoy_eps（EPS同比%）"],
    "财务字段": ["debt_asset_ratio（资产负债率%）", "current_ratio（流动比率）", "quick_ratio（速动比率）", "cfo_to_np（经营现金流/净利润）"],
    "衍生字段": ["market_cap（总市值）"],
  },
  examples: [
    { name: "均线金叉", formula: "MA(close,5) cross_up MA(close,20)", desc: "5日均线上穿20日均线" },
    { name: "MACD 金叉（上穿零轴）", formula: "MACD() cross_up 0", desc: "MACD柱由负转正" },
    { name: "RSI 超卖反弹", formula: "RSI(14) cross_up 30", desc: "RSI从30以下突破30" },
    { name: "布林突破", formula: "close > MA(close,20) + STD(close,20) * 2", desc: "价格突破布林上轨" },
    { name: "放量上涨", formula: "volume > MA(volume,20) * 3 AND close > open", desc: "成交量3倍且收阳" },
    { name: "创60日新高", formula: "close >= MAX(close,60)", desc: "收盘价创60日新高" },
    { name: "PE低估+ROE优秀", formula: "pe_ttm < 20 AND roe > 15", desc: "兼具估值和盈利能力" },
    { name: "恐慌性抛售", formula: "close < open * 0.93 AND volume > MA(volume,20) * 2", desc: "跌7%+放量" },
  ],
};

function DslHelpSidebar({ onInsert }: { onInsert: (formula: string) => void }) {
  const [tab, setTab] = useState<"functions" | "operators" | "fields" | "examples">("examples");

  return (
    <div className="w-[320px] shrink-0 border border-[#1a1a1a] rounded-lg bg-[#050505] overflow-hidden flex flex-col">
      {/* Tab 切换 */}
      <div className="flex border-b border-[#1a1a1a] shrink-0">
        {([
          ["examples", "示例"],
          ["functions", "函数"],
          ["operators", "运算符"],
          ["fields", "字段"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex-1 px-2 py-2 text-[10px] transition ${
              tab === key
                ? "text-white bg-[#111] border-b border-[#7fa8e3]"
                : "text-[#666] hover:text-white"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 内容 */}
      <div className="flex-1 overflow-y-auto p-3">
        {tab === "examples" && (
          <div className="space-y-1">
            {DSL_HELP.examples.map((ex) => (
              <button
                key={ex.name}
                onClick={() => onInsert(ex.formula)}
                className="w-full text-left p-2 rounded hover:bg-[#111] transition group"
              >
                <div className="text-[11px] text-white font-medium">{ex.name}</div>
                <code className="text-[10px] text-[#7fa8e3] font-mono block mt-0.5 truncate">{ex.formula}</code>
                <div className="text-[10px] text-[#555] mt-0.5">{ex.desc}</div>
              </button>
            ))}
          </div>
        )}

        {tab === "functions" && (
          <div className="space-y-2">
            {DSL_HELP.functions.map((f) => (
              <div key={f.name} className="text-[11px] p-1.5 rounded hover:bg-[#111]">
                <code className="text-[#7fa8e3] font-mono">{f.name}</code>
                <div className="text-[#666] mt-0.5">{f.desc}</div>
                <div className="text-[#555] font-mono mt-0.5">→ {f.example}</div>
              </div>
            ))}
          </div>
        )}

        {tab === "operators" && (
          <div className="space-y-2">
            {DSL_HELP.operators.map((op) => (
              <div key={op.name} className="text-[11px] p-1.5 rounded hover:bg-[#111]">
                <code className="text-[#e8d44d] font-mono font-bold">{op.name}</code>
                <div className="text-[#666] mt-0.5">{op.desc}</div>
                <code className="text-[#555] font-mono block mt-0.5 text-[10px]">{op.example}</code>
              </div>
            ))}
            <div className="mt-3 p-2 bg-[#0a0a0a] rounded border border-[#1a1a1a] text-[#666] text-[10px]">
              <strong className="text-[#888]">优先级：</strong> OR → AND → 比较 → 加减 → 乘除
              <br />用 <code className="text-[#7fa8e3]">()</code> 改变优先级
            </div>
          </div>
        )}

        {tab === "fields" && (
          <div className="space-y-3">
            {Object.entries(DSL_HELP.fields).map(([group, fields]) => (
              <div key={group}>
                <h4 className="text-[10px] text-[#888] font-medium mb-1 uppercase">{group}</h4>
                <div className="space-y-0.5">
                  {fields.map((f) => {
                    const match = f.match(/^(\w+)（(.+)）$/);
                    return (
                      <div key={f} className="text-[11px] flex gap-2 py-0.5">
                        <code className="text-[#7fa8e3] font-mono min-w-[100px]">{match?.[1] || f}</code>
                        {match && <span className="text-[#666]">{match[2]}</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function NewFactorPage() {
  const router = useRouter();

  // 表单状态
  const [name, setName] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("custom");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [formula, setFormula] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");

  // 校验状态
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<{
    valid: boolean;
    output_type?: string;
    lookback?: number;
    error?: string;
    preview?: Array<{ symbol: string; date: string; value: unknown }>;
  } | null>(null);

  // 保存状态
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // 校验公式
  const handleValidate = useCallback(async () => {
    if (!formula.trim()) return;
    setValidating(true);
    setValidation(null);
    try {
      const result = await sdk.factors.validateFormula({
        formula: formula.trim(),
        formula_type: "dsl",
        preview: { symbols: ["600519"], start: "2026-02-01", end: "2026-02-28" },
      });
      const d = result.data;
      setValidation({
        valid: d.valid,
        output_type: d.inferred_output_type,
        lookback: d.inferred_lookback,
        error: d.error ? `${d.error.code}: ${d.error.message}` : undefined,
        preview: d.preview_result,
      });
    } catch (e: unknown) {
      setValidation({
        valid: false,
        error: e instanceof Error ? e.message : "校验请求失败",
      });
    } finally {
      setValidating(false);
    }
  }, [formula]);

  // 保存因子
  const handleSave = useCallback(async () => {
    if (!name.trim() || !formula.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      // 确保 userId 已缓存到 SDK
      const userId = await ensureUserId();
      if (!userId) {
        setSaveError("请先登录后再保存因子");
        setSaving(false);
        return;
      }

      await sdk.factors.createFactor({
        name: name.trim(),
        name_en: nameEn.trim() || undefined,
        description: description.trim() || undefined,
        category,
        tags,
        formula: formula.trim(),
        formula_type: "dsl",
        visibility,
      });
      router.push("/factors");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "保存失败";
      setSaveError(msg);
    } finally {
      setSaving(false);
    }
  }, [name, nameEn, description, category, tags, formula, visibility, router]);

  // 添加标签
  const addTag = (tag: string) => {
    const t = tag.trim();
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setTagInput("");
  };

  return (
    <div className="min-h-screen bg-black text-white">
      <MainNav />

      <div className="max-w-[1200px] mx-auto px-6 py-8">
        {/* 面包屑 */}
        <div className="flex items-center gap-2 text-sm text-[#888] mb-6">
          <Link href="/factors" className="hover:text-white transition">因子库</Link>
          <span>/</span>
          <span className="text-white">创建自定义因子</span>
        </div>

        <h1 className="text-2xl font-semibold mb-8">创建自定义因子</h1>

        <div className="space-y-6">
          {/* 基本信息 */}
          <section className="border border-[#1a1a1a] rounded-lg bg-[#0a0a0a] p-6">
            <h2 className="text-sm font-medium text-[#888] mb-4">基本信息</h2>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-[#666] mb-1">因子名称 *</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例：我的均线策略"
                  className="w-full bg-[#111] border border-[#333] rounded px-3 py-2 text-sm text-white focus:border-[#555] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-[#666] mb-1">英文名（可选）</label>
                <input
                  value={nameEn}
                  onChange={(e) => setNameEn(e.target.value)}
                  placeholder="My MA Strategy"
                  className="w-full bg-[#111] border border-[#333] rounded px-3 py-2 text-sm text-white font-mono focus:border-[#555] focus:outline-none"
                />
              </div>
            </div>
            <div className="mt-4">
              <label className="block text-xs text-[#666] mb-1">描述</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="简要描述因子的策略逻辑和适用场景..."
                rows={2}
                className="w-full bg-[#111] border border-[#333] rounded px-3 py-2 text-sm text-white focus:border-[#555] focus:outline-none resize-none"
              />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-[#666] mb-1">分类</label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full bg-[#111] border border-[#333] rounded px-3 py-2 text-sm text-white focus:border-[#555] focus:outline-none"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>{c.icon} {c.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#666] mb-1">可见性</label>
                <select
                  value={visibility}
                  onChange={(e) => setVisibility(e.target.value as "private" | "public")}
                  className="w-full bg-[#111] border border-[#333] rounded px-3 py-2 text-sm text-white focus:border-[#555] focus:outline-none"
                >
                  <option value="private">🔒 仅自己可见</option>
                  <option value="public">🌐 公开</option>
                </select>
              </div>
            </div>
            {/* 标签 */}
            <div className="mt-4">
              <label className="block text-xs text-[#666] mb-1">标签</label>
              <div className="flex flex-wrap gap-1 mb-2">
                {tags.map((t) => (
                  <span
                    key={t}
                    className="px-2 py-0.5 rounded text-xs bg-[#1e3a5a] text-[#7fa8e3] border border-[#2c5580] cursor-pointer hover:bg-red-900/30 hover:text-red-300 hover:border-red-700/50 transition"
                    onClick={() => setTags(tags.filter((x) => x !== t))}
                    title="点击移除"
                  >
                    #{t} ×
                  </span>
                ))}
              </div>
              <div className="flex gap-2 items-center">
                <input
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(tagInput); } }}
                  placeholder="输入标签回车添加"
                  className="bg-[#111] border border-[#333] rounded px-2 py-1 text-xs text-white w-32 focus:border-[#555] focus:outline-none"
                />
                <div className="flex flex-wrap gap-1">
                  {COMMON_TAGS.filter((t) => !tags.includes(t)).slice(0, 6).map((t) => (
                    <button
                      key={t}
                      onClick={() => addTag(t)}
                      className="px-1.5 py-0.5 rounded text-[10px] bg-[#111] text-[#666] border border-[#222] hover:text-white hover:border-[#444] transition"
                    >
                      +{t}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>

          {/* 公式编辑器 — 左右布局 */}
          <section className="border border-[#1a1a1a] rounded-lg bg-[#0a0a0a] p-6">
            <h2 className="text-sm font-medium text-[#888] mb-4">DSL 公式</h2>
            <div className="flex gap-4">
              {/* 左侧：编辑器 + 校验 */}
              <div className="flex-1 min-w-0">
                <textarea
                  value={formula}
                  onChange={(e) => { setFormula(e.target.value); setValidation(null); }}
                  placeholder="输入 DSL 公式，例：MA(close,5) cross_up MA(close,20)"
                  rows={4}
                  className="w-full bg-[#111] border border-[#333] rounded px-4 py-3 text-sm text-white font-mono focus:border-[#7fa8e3] focus:outline-none resize-none"
                  spellCheck={false}
                />

                {/* 快捷示例 */}
                <div className="flex flex-wrap gap-1 mt-3">
                  <span className="text-[10px] text-[#555]">快捷：</span>
                  {FORMULA_EXAMPLES.map((ex) => (
                    <button
                      key={ex.label}
                      onClick={() => { setFormula(ex.formula); setValidation(null); }}
                      className="px-2 py-0.5 rounded text-[10px] bg-[#111] text-[#888] border border-[#222] hover:text-white hover:border-[#444] transition"
                    >
                      {ex.label}
                    </button>
                  ))}
                </div>

                {/* 校验按钮 */}
                <div className="flex items-center gap-3 mt-4">
                  <button
                    onClick={handleValidate}
                    disabled={!formula.trim() || validating}
                    className="bg-[#1e3a5a] text-[#7fa8e3] border border-[#2c5580] px-4 py-2 rounded text-sm hover:bg-[#254a6e] transition disabled:opacity-40"
                  >
                    {validating ? "校验中..." : "校验公式"}
                  </button>

                  {validation && (
                    <div className={`text-sm ${validation.valid ? "text-green-400" : "text-red-400"}`}>
                      {validation.valid ? (
                        <>
                          ✅ 有效 · <code className="text-[#7fa8e3]">{validation.output_type}</code>
                          {validation.lookback !== undefined && <> · {validation.lookback}天</>}
                        </>
                      ) : (
                        <>❌ {validation.error}</>
                      )}
                    </div>
                  )}
                </div>

                {/* 预览结果 */}
                {validation?.valid && validation.preview && validation.preview.length > 0 && (
                  <div className="mt-4 border border-[#1a1a1a] rounded p-3 bg-[#050505]">
                    <div className="text-xs text-[#666] mb-2">预览（600519，最近 {validation.preview.length} 条）</div>
                    <div className="max-h-32 overflow-y-auto">
                      <table className="w-full text-xs font-mono">
                        <thead>
                          <tr className="text-[#555]">
                            <th className="text-left py-1 px-2">日期</th>
                            <th className="text-left py-1 px-2">值</th>
                          </tr>
                        </thead>
                        <tbody>
                          {validation.preview.slice(-10).map((r, i) => (
                            <tr key={i} className="border-t border-[#111]">
                              <td className="py-1 px-2 text-[#888]">{r.date}</td>
                              <td className={`py-1 px-2 ${r.value === true ? "text-red-400" : r.value === false ? "text-[#555]" : "text-[#7fa8e3]"}`}>
                                {String(r.value)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>

              {/* 右侧：帮助侧边栏 */}
              <DslHelpSidebar onInsert={(f) => { setFormula(f); setValidation(null); }} />
            </div>
          </section>

          {/* 保存 */}
          <div className="flex items-center justify-between">
            <Link href="/factors" className="text-[#888] text-sm hover:text-white transition">
              ← 返回因子库
            </Link>
            <div className="flex items-center gap-3">
              {saveError && <span className="text-red-400 text-sm">{saveError}</span>}
              <button
                onClick={handleSave}
                disabled={!name.trim() || !formula.trim() || saving}
                className="bg-white text-black px-6 py-2 rounded text-sm font-medium hover:bg-[#ddd] transition disabled:opacity-40"
              >
                {saving ? "保存中..." : "保存因子"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
