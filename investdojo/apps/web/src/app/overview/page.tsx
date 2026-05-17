"use client";

/**
 * 项目全景展示页 — 公开访问
 * 路由：/overview
 */

import React, { useState, useEffect, useCallback } from "react";
import progressData from "@/app/admin/progress/progress-data.json";

// ── 从 JSON 计算进度 ──
const epics = progressData.epics;
const totalDone = epics.reduce((s, e) => s.done + e.done, 0) || epics.reduce((s, e) => s + e.done, 0);
const totalAll = epics.reduce((s, e) => s + e.total, 0);
const overallPct = Math.round((totalDone / totalAll) * 100);

const SLIDES = [
  "cover", "vision", "arch", "stack", "data", "modules", "progress", "roadmap",
];

const SLIDE_LABELS = [
  "首页", "愿景", "架构", "技术栈", "数据", "模块", "进度", "路线图",
];

export default function OverviewPage() {
  const [current, setCurrent] = useState(0);

  const goTo = useCallback((idx: number) => {
    const clamped = Math.max(0, Math.min(idx, SLIDES.length - 1));
    setCurrent(clamped);
    document.getElementById(SLIDES[clamped])?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // 键盘导航
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === " ") {
        e.preventDefault();
        goTo(current + 1);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        goTo(current - 1);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [current, goTo]);

  // 滚动监听
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const idx = SLIDES.indexOf(entry.target.id);
            if (idx >= 0) setCurrent(idx);
          }
        }
      },
      { threshold: 0.5 },
    );
    SLIDES.forEach((id) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <style>{`
        :root {
          --ov-bg: #0a0a0a;
          --ov-card: #111;
          --ov-border: #1e1e1e;
          --ov-blue: #3b82f6;
          --ov-green: #22c55e;
          --ov-yellow: #eab308;
          --ov-purple: #a855f7;
          --ov-orange: #f97316;
          --ov-text-dim: rgba(255,255,255,0.45);
          --ov-text-sec: rgba(255,255,255,0.7);
        }
        .ov-slide {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          justify-content: center;
          padding: clamp(2rem, 6vw, 5rem);
          position: relative;
          border-bottom: 1px solid var(--ov-border);
        }
        .ov-nav {
          position: fixed; top: 0; left: 0; right: 0; z-index: 100;
          display: flex; align-items: center; justify-content: space-between;
          padding: 0.6rem 1.5rem;
          background: rgba(10,10,10,0.88); backdrop-filter: blur(12px);
          border-bottom: 1px solid var(--ov-border);
        }
        .ov-nav-link {
          color: var(--ov-text-dim); text-decoration: none; font-size: 0.72rem;
          cursor: pointer; transition: color 0.15s; padding: 0.3rem 0;
        }
        .ov-nav-link:hover, .ov-nav-link.active { color: #fff; }
        .ov-nav-link.active { border-bottom: 2px solid var(--ov-blue); }
        .ov-label {
          font-family: 'JetBrains Mono', monospace; font-size: 0.62rem;
          letter-spacing: 0.15em; text-transform: uppercase; color: var(--ov-text-dim);
        }
        .ov-num {
          position: absolute; top: 1.5rem; right: 2rem;
          font-family: monospace; font-size: 0.65rem; color: var(--ov-text-dim);
        }
        .ov-card {
          background: var(--ov-card); border: 1px solid var(--ov-border);
          border-radius: 10px; padding: 1.2rem; transition: background 0.2s;
        }
        .ov-card:hover { background: #161616; }
        .ov-bar { height: 5px; background: #1a1a1a; border-radius: 3px; overflow: hidden; }
        .ov-fill { height: 100%; border-radius: 3px; }
        .ov-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
        .ov-chip {
          display: inline-flex; align-items: center; gap: 0.35rem;
          padding: 0.35rem 0.7rem; border-radius: 5px;
          background: var(--ov-bg); border: 1px solid var(--ov-border);
          font-size: 0.72rem; margin: 0.15rem;
        }
        .ov-badge {
          display: inline-block; padding: 0.12rem 0.45rem; border-radius: 4px;
          font-family: monospace; font-size: 0.62rem; font-weight: 500;
        }
        .ov-layer {
          padding: 0.8rem 1.2rem; border-radius: 8px; border: 1px solid var(--ov-border);
        }
        .ov-tl-item { display: flex; gap: 0.8rem; position: relative; padding-bottom: 1.2rem; }
        .ov-tl-item:not(:last-child)::before {
          content: ''; position: absolute; left: 5px; top: 14px; bottom: 0;
          width: 1px; background: var(--ov-border);
        }
        @keyframes ov-pulse { 0%,100%{ opacity:1; } 50%{ opacity:0.35; } }
        .ov-pulse { animation: ov-pulse 2s infinite; }
      `}</style>

      {/* Nav */}
      <nav className="ov-nav">
        <span style={{ fontWeight: 700, fontSize: "0.85rem" }}>InvestDojo</span>
        <div style={{ display: "flex", gap: "1.2rem" }}>
          {SLIDES.map((id, i) => (
            <span
              key={id}
              className={`ov-nav-link ${current === i ? "active" : ""}`}
              onClick={() => goTo(i)}
            >
              {SLIDE_LABELS[i]}
            </span>
          ))}
        </div>
        <span style={{ fontSize: "0.65rem", color: "var(--ov-text-dim)", fontFamily: "monospace" }}>
          {current + 1} / {SLIDES.length}
        </span>
      </nav>

      {/* ═══ Slide 1: Cover ═══ */}
      <section className="ov-slide" id="cover" style={{ alignItems: "center", textAlign: "center" }}>
        <span className="ov-num">01 / 08</span>
        <div className="ov-label" style={{ marginBottom: "0.8rem" }}>QUANTITATIVE TRADING SIMULATION PLATFORM</div>
        <h1 style={{
          fontSize: "clamp(2.5rem,7vw,5rem)", fontWeight: 800, letterSpacing: "-0.03em",
          background: "linear-gradient(135deg,#3b82f6,#a855f7)",
          WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
        }}>
          InvestDojo
        </h1>
        <h1 style={{ fontSize: "clamp(2.5rem,7vw,5rem)", fontWeight: 800, letterSpacing: "-0.03em", marginTop: "-0.3rem" }}>
          投资道场
        </h1>
        <p style={{ fontSize: "clamp(0.9rem,1.5vw,1.2rem)", color: "var(--ov-text-sec)", lineHeight: 1.6, marginTop: "1rem", maxWidth: 600 }}>
          AI 驱动的量化交易学习平台<br />
          因子库 · 模型训练 · 历史回测 · AI 副驾 · 模拟炒股
        </p>
        <div style={{ marginTop: "2.5rem", display: "flex", gap: "2rem", flexWrap: "wrap", justifyContent: "center" }}>
          {[
            { n: "6", l: "微服务", c: "var(--ov-blue)" },
            { n: "560万+", l: "K 线数据", c: "var(--ov-green)" },
            { n: "63", l: "量化因子", c: "var(--ov-purple)" },
            { n: "5500+", l: "A 股覆盖", c: "var(--ov-orange)" },
          ].map((s) => (
            <div key={s.l}>
              <div style={{ fontSize: "clamp(1.5rem,4vw,3rem)", fontWeight: 800, fontFamily: "monospace", color: s.c }}>{s.n}</div>
              <div style={{ fontSize: "0.7rem", color: "var(--ov-text-dim)", marginTop: "0.2rem" }}>{s.l}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ═══ Slide 2: Vision ═══ */}
      <section className="ov-slide" id="vision">
        <span className="ov-num">02 / 08</span>
        <div className="ov-label" style={{ marginBottom: "0.4rem" }}>VISION & MISSION</div>
        <h2 style={{ fontSize: "clamp(1.8rem,4vw,3rem)", fontWeight: 700 }}>让每个人都能学会量化投资</h2>
        <p style={{ fontSize: "clamp(0.9rem,1.5vw,1.1rem)", color: "var(--ov-text-sec)", lineHeight: 1.6, maxWidth: 700, marginTop: "1rem" }}>
          InvestDojo 不是又一个交易软件。它是一个<strong>学习平台</strong>——通过历史模拟、
          AI 辅助决策、因子研究和模型训练，让普通投资者理解量化思维，提升投资决策能力。
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(250px,1fr))", gap: "1rem", marginTop: "2rem" }}>
          {[
            { t: "因子研究", c: "var(--ov-blue)", d: "浏览 200+ 内置因子，理解技术指标、基本面、情绪面的量化表达。自己动手写公式，即时验证。" },
            { t: "模型训练", c: "var(--ov-green)", d: "零代码一键训练 LightGBM 模型。选因子、定参数、跑回测，10 分钟内获得完整评估报告。" },
            { t: "AI 副驾", c: "var(--ov-purple)", d: "在历史模拟中，AI 实时给出买卖建议。你做决定，AI 做参谋。复盘时看看谁更准。" },
          ].map((v) => (
            <div key={v.t} className="ov-card">
              <h3 style={{ color: v.c, fontSize: "clamp(1rem,2vw,1.3rem)", fontWeight: 600 }}>{v.t}</h3>
              <p style={{ fontSize: "0.82rem", color: "var(--ov-text-sec)", marginTop: "0.5rem", lineHeight: 1.6 }}>{v.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ═══ Slide 3: Architecture ═══ */}
      <section className="ov-slide" id="arch">
        <span className="ov-num">03 / 08</span>
        <div className="ov-label" style={{ marginBottom: "0.4rem" }}>SYSTEM ARCHITECTURE</div>
        <h2 style={{ fontSize: "clamp(1.8rem,4vw,3rem)", fontWeight: 700 }}>系统架构</h2>
        <p style={{ fontSize: "0.9rem", color: "var(--ov-text-sec)", marginTop: "0.4rem" }}>Monorepo + 微服务 + 自托管 Supabase</p>
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem", marginTop: "2rem", maxWidth: 900 }}>
          {[
            { label: "Frontend", color: "var(--ov-blue)", chips: ["Next.js 15 :3000", "React 19", "Tailwind CSS 4", "@investdojo/api SDK"] },
            { label: "Python Microservices (FastAPI)", color: "var(--ov-green)", chips: ["data-svc :8006", "feature-svc :8001", "train-svc :8002", "infer-svc :8003", "backtest-svc :8004", "monitor-svc :8005"] },
            { label: "Infrastructure (Docker)", color: "var(--ov-purple)", chips: ["PostgreSQL 15 :5432", "PostgREST", "GoTrue (Auth)", "Kong Gateway :8000", "Redis :6379", "MinIO :9000"] },
          ].map((layer) => (
            <div key={layer.label} className="ov-layer" style={{ borderColor: layer.color, background: `${layer.color}08` }}>
              <div className="ov-label" style={{ color: layer.color, marginBottom: "0.6rem" }}>{layer.label}</div>
              <div style={{ display: "flex", flexWrap: "wrap" }}>
                {layer.chips.map((ch) => {
                  const parts = ch.split(" :");
                  return (
                    <span key={ch} className="ov-chip">
                      {parts[0]}
                      {parts[1] && <span style={{ fontFamily: "monospace", fontSize: "0.6rem", color: "var(--ov-purple)" }}>:{parts[1]}</span>}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ═══ Slide 4: Tech Stack ═══ */}
      <section className="ov-slide" id="stack">
        <span className="ov-num">04 / 08</span>
        <div className="ov-label" style={{ marginBottom: "0.4rem" }}>TECH STACK</div>
        <h2 style={{ fontSize: "clamp(1.8rem,4vw,3rem)", fontWeight: 700 }}>技术选型</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: "1rem", marginTop: "2rem" }}>
          {[
            { t: "前端", items: ["Next.js 15 (App Router)", "React 19 + TypeScript", "Tailwind CSS 4 · Raycast 设计系统", "@supabase/ssr · Supabase Auth", "pnpm + Turborepo monorepo"] },
            { t: "后端", items: ["Python 3.12 + FastAPI", "6 个独立微服务", "Celery + Redis (异步任务)", "structlog 结构化日志", "uv 依赖管理"] },
            { t: "数据库 & 存储", items: ["PostgreSQL 15 (Supabase Lite)", "42 张表 + 17 年分区表", "PostgREST API + RLS", "MinIO S3 对象存储"] },
            { t: "量化引擎", items: ["DSL 因子公式语言（自研）", "Pandas 向量化计算引擎", "LightGBM 模型训练", "向量化回测引擎", "BaoStock + AKShare 数据源"] },
          ].map((s) => (
            <div key={s.t} className="ov-card">
              <h3 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.5rem" }}>{s.t}</h3>
              {s.items.map((it) => (
                <div key={it} style={{ fontSize: "0.78rem", color: "var(--ov-text-sec)", lineHeight: 1.9 }}>{it}</div>
              ))}
            </div>
          ))}
        </div>
      </section>

      {/* ═══ Slide 5: Data ═══ */}
      <section className="ov-slide" id="data">
        <span className="ov-num">05 / 08</span>
        <div className="ov-label" style={{ marginBottom: "0.4rem" }}>DATA ASSETS</div>
        <h2 style={{ fontSize: "clamp(1.8rem,4vw,3rem)", fontWeight: 700 }}>数据资产</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: "1rem", marginTop: "2rem" }}>
          {[
            { n: "5,603,772", l: "日 K 线", sub: "2020-01 ~ 2026-04", c: "var(--ov-blue)" },
            { n: "108,144", l: "5 分钟 K 线", sub: "4 场景真实数据", c: "var(--ov-green)" },
            { n: "5,528", l: "A 股覆盖", sub: "含退市股", c: "var(--ov-purple)" },
            { n: "2,995", l: "市场快照", sub: "2014 ~ 2026", c: "var(--ov-orange)" },
          ].map((d) => (
            <div key={d.l} className="ov-card" style={{ textAlign: "center" }}>
              <div style={{ fontSize: "clamp(1.3rem,3vw,2.2rem)", fontWeight: 800, fontFamily: "monospace", color: d.c }}>{d.n}</div>
              <div style={{ fontSize: "0.7rem", color: "var(--ov-text-dim)", marginTop: "0.2rem" }}>{d.l}</div>
              <div style={{ fontSize: "0.6rem", color: "var(--ov-text-dim)", marginTop: "0.2rem" }}>{d.sub}</div>
            </div>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: "1rem", marginTop: "1.5rem" }}>
          <div className="ov-card">
            <h3 style={{ fontSize: "0.95rem", fontWeight: 600, marginBottom: "0.4rem" }}>数据采集</h3>
            {["BaoStock: 股票代码、日K、5mK、基本面", "AKShare: 北向资金、行业资金流", "断点续传 + 自动重试", "增量更新脚本（每日 17:00）"].map((t) => (
              <div key={t} style={{ fontSize: "0.78rem", color: "var(--ov-text-sec)", lineHeight: 1.8 }}>{t}</div>
            ))}
          </div>
          <div className="ov-card">
            <h3 style={{ fontSize: "0.95rem", fontWeight: 600, marginBottom: "0.4rem" }}>场景数据</h3>
            {["covid_2020 — 新冠熔断", "new_energy_2020 — 新能源牛市", "crisis_2022 — 多重冲击", "ai_boom_2023 — AI 概念疯牛"].map((t) => (
              <div key={t} style={{ fontSize: "0.78rem", color: "var(--ov-text-sec)", lineHeight: 1.8 }}>{t}</div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ Slide 6: Modules ═══ */}
      <section className="ov-slide" id="modules">
        <span className="ov-num">06 / 08</span>
        <div className="ov-label" style={{ marginBottom: "0.4rem" }}>MODULE STATUS</div>
        <h2 style={{ fontSize: "clamp(1.8rem,4vw,3rem)", fontWeight: 700 }}>模块进度</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem", marginTop: "2rem", maxWidth: 800 }}>
          <div className="ov-label" style={{ color: "var(--ov-green)" }}>后端服务</div>
          {[
            { name: "data-svc", desc: "数据 API + 管理后台", pct: 100, s: "done" },
            { name: "feature-svc", desc: "因子库 · DSL · 计算引擎", pct: 75, s: "active" },
            { name: "train-svc", desc: "模型训练（骨架完成）", pct: 20, s: "partial" },
            { name: "backtest-svc", desc: "回测引擎（骨架完成）", pct: 20, s: "partial" },
            { name: "monitor-svc", desc: "监控 · Prometheus", pct: 100, s: "done" },
          ].map((m) => (
            <SvcRow key={m.name} {...m} />
          ))}
          <div className="ov-label" style={{ color: "var(--ov-blue)", marginTop: "1rem" }}>前端页面</div>
          {[
            { name: "K 线图", desc: "/kline", pct: 100, s: "done" },
            { name: "因子库", desc: "/factors · 浏览/详情/创建/发布", pct: 80, s: "active" },
            { name: "历史模拟", desc: "/simulation · 盲测框架 v1", pct: 30, s: "partial" },
            { name: "数据管理", desc: "/admin/data · SQL/任务管理", pct: 100, s: "done" },
          ].map((m) => (
            <SvcRow key={m.name} {...m} />
          ))}
        </div>
      </section>

      {/* ═══ Slide 7: Progress ═══ */}
      <section className="ov-slide" id="progress">
        <span className="ov-num">07 / 08</span>
        <div className="ov-label" style={{ marginBottom: "0.4rem" }}>OVERALL PROGRESS</div>
        <h2 style={{ fontSize: "clamp(1.8rem,4vw,3rem)", fontWeight: 700 }}>
          总体进度 <span style={{ fontFamily: "monospace", color: "var(--ov-blue)", fontSize: "0.6em" }}>{overallPct}%</span>
        </h2>
        <div className="ov-bar" style={{ height: 8, maxWidth: 600, marginTop: "1rem" }}>
          <div className="ov-fill" style={{ width: `${overallPct}%`, background: "var(--ov-blue)" }} />
        </div>
        <div style={{ fontSize: "0.72rem", color: "var(--ov-text-dim)", marginTop: "0.4rem" }}>{totalDone} / {totalAll} 任务完成</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: "0.8rem", marginTop: "2rem" }}>
          {epics.map((e) => {
            const pct = e.total > 0 ? Math.round((e.done / e.total) * 100) : 0;
            const dotCls = e.status === "done" ? "var(--ov-green)" : e.status === "active" ? "var(--ov-blue)" : "#444";
            const barBg = e.status === "done" ? "var(--ov-green)" : e.status === "active" ? "var(--ov-blue)" : "#333";
            return (
              <div key={e.id} className="ov-card">
                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  <span className="ov-dot" style={{ background: dotCls, ...(e.status === "active" ? { animation: "ov-pulse 2s infinite" } : {}) }} />
                  <span style={{ fontSize: "0.78rem" }}>Epic {e.id} {e.name}</span>
                </div>
                <div className="ov-bar" style={{ marginTop: "0.5rem" }}>
                  <div className="ov-fill" style={{ width: `${pct}%`, background: barBg }} />
                </div>
                <div style={{ fontFamily: "monospace", fontSize: "0.62rem", color: "var(--ov-text-dim)", marginTop: "0.25rem" }}>{e.done}/{e.total}</div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ═══ Slide 8: Roadmap ═══ */}
      <section className="ov-slide" id="roadmap">
        <span className="ov-num">08 / 08</span>
        <div className="ov-label" style={{ marginBottom: "0.4rem" }}>ROADMAP</div>
        <h2 style={{ fontSize: "clamp(1.8rem,4vw,3rem)", fontWeight: 700 }}>里程碑路线图</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(350px,1fr))", gap: "2rem", marginTop: "2rem" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
            {[
              { date: "已完成", title: "M0 · 基础设施 + 数据层", desc: "Supabase Lite 自托管、560万行数据、6个微服务骨架、TypeScript SDK", c: "var(--ov-green)" },
              { date: "进行中", title: "M1 · 因子库上线", desc: "200 因子可浏览、DSL 公式、实时计算、发布/订阅、数据管理工具", c: "var(--ov-blue)" },
              { date: "下一步", title: "M2 · 训练与回测", desc: "一键训练 LightGBM、向量化回测引擎、训练报告页、回测对比", c: "#444" },
              { date: "计划中", title: "M3 · AI 副驾 MVP", desc: "会话编排、时钟推进、实时推理、副驾面板、复盘页", c: "#444" },
            ].map((m, i) => (
              <div key={i} className="ov-tl-item">
                <div style={{ width: 11, height: 11, borderRadius: "50%", marginTop: 4, flexShrink: 0, background: m.c }} />
                <div>
                  <div style={{ fontFamily: "monospace", fontSize: "0.68rem", color: "var(--ov-blue)" }}>{m.date}</div>
                  <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>{m.title}</div>
                  <div style={{ fontSize: "0.78rem", color: "var(--ov-text-sec)" }}>{m.desc}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="ov-card">
            <h3 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.8rem" }}>MVP 交付目标</h3>
            {[
              { done: true, t: "200+ 因子可浏览、可搜索" },
              { done: true, t: "因子详情页 + 历史表现" },
              { done: false, t: "一键训练 → 10 分钟出报告" },
              { done: false, t: "回测 → 净值曲线 + 指标" },
              { done: false, t: "官方模型「动量追踪者」" },
              { done: false, t: "盲测 + AI 副驾实时信号" },
              { done: false, t: "会话复盘 + 事件时间线" },
              { done: false, t: "端到端测试 + 性能优化" },
            ].map((item) => (
              <div key={item.t} style={{ fontSize: "0.78rem", color: "var(--ov-text-sec)", lineHeight: 2 }}>
                {item.done ? "✅" : "⬜"} {item.t}
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

// ── Helper component ──
function SvcRow({ name, desc, pct, s }: { name: string; desc: string; pct: number; s: string }) {
  const dotBg = s === "done" ? "var(--ov-green)" : s === "active" ? "var(--ov-blue)" : s === "partial" ? "var(--ov-yellow)" : "#444";
  const barBg = s === "done" ? "var(--ov-green)" : s === "active" ? "var(--ov-blue)" : s === "partial" ? "var(--ov-yellow)" : "#333";
  return (
    <div className="ov-card" style={{ display: "flex", alignItems: "center", gap: "0.8rem", padding: "0.8rem 1rem" }}>
      <span className="ov-dot" style={{ background: dotBg, ...(s === "active" ? { animation: "ov-pulse 2s infinite" } : {}) }} />
      <span style={{ minWidth: 100, fontWeight: 600, fontSize: "0.82rem" }}>{name}</span>
      <span style={{ flex: 1, fontSize: "0.72rem", color: "var(--ov-text-dim)" }}>{desc}</span>
      <div className="ov-bar" style={{ width: 100 }}>
        <div className="ov-fill" style={{ width: `${pct}%`, background: barBg }} />
      </div>
      <span style={{ fontFamily: "monospace", fontSize: "0.68rem", color: "var(--ov-text-dim)", width: 36, textAlign: "right" }}>{pct}%</span>
    </div>
  );
}
