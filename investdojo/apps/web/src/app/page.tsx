import Link from "next/link";

export default function HomePage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-950">
      {/* Hero */}
      <div className="text-center mb-12">
        <h1 className="text-5xl font-bold mb-4">
          <span className="text-6xl mr-3">🥋</span>
          <span className="bg-gradient-to-r from-blue-400 to-violet-400 bg-clip-text text-transparent">
            InvestDojo
          </span>
        </h1>
        <p className="text-xl text-gray-400 mb-2">投资道场</p>
        <p className="text-sm text-gray-500 max-w-md mx-auto">
          在历史的关键时刻重新做出投资决策 — 模拟炒股 × 量化回测 × 财报分析
        </p>
      </div>

      {/* 三大模块入口 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-4xl w-full px-4">
        <Link
          href="/simulation"
          className="group rounded-xl border border-gray-800 bg-gray-900/50 p-6 hover:border-blue-500/50 hover:bg-gray-900 transition-all"
        >
          <div className="text-3xl mb-3">🎮</div>
          <h2 className="text-lg font-bold text-white mb-1 group-hover:text-blue-400 transition-colors">
            历史情景模拟
          </h2>
          <p className="text-sm text-gray-500">
            回到2020年新冠、2015年牛熊转换等关键时刻，用真实历史数据模拟交易
          </p>
        </Link>

        <div className="rounded-xl border border-gray-800 bg-gray-900/30 p-6 opacity-60 cursor-not-allowed">
          <div className="text-3xl mb-3">📊</div>
          <h2 className="text-lg font-bold text-gray-400 mb-1">AI 量化回测</h2>
          <p className="text-sm text-gray-600">
            用自然语言描述策略，AI 生成代码并回测 — 即将推出
          </p>
        </div>

        <div className="rounded-xl border border-gray-800 bg-gray-900/30 p-6 opacity-60 cursor-not-allowed">
          <div className="text-3xl mb-3">📋</div>
          <h2 className="text-lg font-bold text-gray-400 mb-1">AI 财报分析</h2>
          <p className="text-sm text-gray-600">
            输入股票代码，秒出六维分析 + 同行对比 — 即将推出
          </p>
        </div>
      </div>

      {/* 免责声明 */}
      <p className="mt-12 text-xs text-gray-700 max-w-md text-center">
        本平台仅为教育工具，不构成任何投资建议。模拟交易使用历史数据，不涉及真实资金。
      </p>
    </div>
  );
}
