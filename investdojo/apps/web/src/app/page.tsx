import Link from "next/link";
import { UserNav } from "@/components/UserNav";

export default function HomePage() {
  return (
    <div className="min-h-screen bg-rc-bg">
      {/* ---- Navigation ---- */}
      <nav className="rc-nav max-w-[1200px] mx-auto">
        <Link href="/" className="text-[20px] font-semibold text-rc-text-primary tracking-[0.2px]">
          InvestDojo
        </Link>
        <div className="hidden md:flex items-center gap-6">
          <Link href="/simulation" className="rc-nav-link">历史模拟</Link>
          <Link href="/factors" className="rc-nav-link">因子库</Link>
          <span className="text-rc-text-dim cursor-not-allowed text-[16px] tracking-[0.3px]">财报分析</span>
          <Link href="/sdk-demo" className="rc-nav-link text-[14px] opacity-70 hover:opacity-100">
            SDK Demo
          </Link>
        </div>
        <UserNav />
      </nav>

      {/* ---- Hero Section ---- */}
      <section className="relative overflow-hidden py-[100px] md:py-[140px] px-6">
        {/* Decorative red diagonal stripe — Raycast signature */}
        <div
          className="absolute top-0 right-0 w-[400px] h-[600px] opacity-[0.04] pointer-events-none"
          style={{
            background: "repeating-linear-gradient(-45deg, #FF6363, #FF6363 2px, transparent 2px, transparent 20px)",
          }}
        />

        <div className="relative z-10 max-w-[1200px] mx-auto text-center">
          <h1 className="text-display-hero text-white max-w-[800px] mx-auto">
            在历史的关键时刻
            <br />
            重新做出投资决策
          </h1>
          <p className="mt-6 text-body-lg text-rc-text-secondary max-w-[560px] mx-auto">
            模拟炒股 × 量化回测 × 财报分析 — 用真实历史数据训练你的投资直觉
          </p>
          <div className="flex items-center gap-4 justify-center mt-10">
            <Link href="/simulation" className="rc-btn-primary text-[16px] px-8 py-3">
              开始模拟
            </Link>
            <Link href="#modules" className="rc-btn-secondary text-[16px] px-6 py-3">
              了解更多
            </Link>
          </div>
        </div>
      </section>

      {/* ---- Module Cards Section ---- */}
      <section id="modules" className="max-w-[1200px] mx-auto px-6 pb-[120px]">
        <h2 className="text-section-heading text-rc-text-secondary mb-10">三大核心模块</h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Card 1: 历史模拟 — Active */}
          <Link
            href="/simulation"
            className="group rc-card-feature transition-all duration-150 hover:translate-y-[-2px]"
          >
            <div className="text-3xl mb-5">🎮</div>
            <h3 className="text-[20px] font-medium text-white mb-2 tracking-[0.2px] group-hover:text-rc-blue transition-colors duration-150">
              历史情景模拟
            </h3>
            <p className="text-caption text-rc-text-secondary leading-relaxed">
              回到 2020 年新冠、2015 年牛熊转换等关键时刻，用真实历史数据模拟交易
            </p>
            <span className="inline-block mt-4 text-caption text-rc-blue group-hover:underline">
              立即体验 →
            </span>
          </Link>

          {/* Card 2: 量化因子库 — Active (T-3.07) */}
          <Link
            href="/factors"
            className="group rc-card-feature transition-all duration-150 hover:translate-y-[-2px]"
          >
            <div className="text-3xl mb-5">📊</div>
            <h3 className="text-[20px] font-medium text-white mb-2 tracking-[0.2px] group-hover:text-rc-blue transition-colors duration-150">
              AI 量化因子库
            </h3>
            <p className="text-caption text-rc-text-secondary leading-relaxed">
              200+ 内置因子，实时计算 & 历史回溯，构建你的量化策略
            </p>
            <span className="inline-block mt-4 text-caption text-rc-blue group-hover:underline">
              浏览因子 →
            </span>
          </Link>

          {/* Card 3: 财报分析 — Coming Soon */}
          <div className="rc-card opacity-50">
            <div className="text-3xl mb-5">📋</div>
            <h3 className="text-[20px] font-medium text-rc-text-dim mb-2 tracking-[0.2px]">
              AI 财报分析
            </h3>
            <p className="text-caption text-rc-text-dim leading-relaxed">
              输入股票代码，秒出六维分析 + 同行对比
            </p>
            <span className="rc-badge rc-badge-info mt-4 text-[12px]">COMING SOON</span>
          </div>
        </div>
      </section>

      {/* ---- Footer ---- */}
      <footer className="border-t border-rc-border py-16 px-6">
        <div className="max-w-[1200px] mx-auto text-center">
          <p className="text-caption text-rc-text-muted leading-relaxed max-w-lg mx-auto">
            本平台仅为教育工具，不构成任何投资建议。模拟交易使用历史数据，不涉及真实资金。
          </p>
          <p className="text-[12px] text-rc-text-dim mt-4 font-rc-mono">
            © 2026 INVESTDOJO. ALL RIGHTS RESERVED.
          </p>
        </div>
      </footer>
    </div>
  );
}
