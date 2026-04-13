// ============================================================
// @investdojo/core — 撮合引擎
// 简化版 A 股撮合逻辑，纯前端运行
// ============================================================

import { nanoid } from "nanoid";
import {
  type Order,
  type Portfolio,
  type Position,
  type KLine,
  type FeeConfig,
  DEFAULT_FEE_CONFIG,
  TRADING_RULES,
} from "./types";

export interface MatchResult {
  order: Order;
  updatedPortfolio: Portfolio;
  message: string;
}

export class SimulationEngine {
  private feeConfig: FeeConfig;

  constructor(feeConfig: FeeConfig = DEFAULT_FEE_CONFIG) {
    this.feeConfig = feeConfig;
  }

  // ============================================================
  // 核心交易方法
  // ============================================================

  /**
   * 执行买入订单
   */
  buy(
    portfolio: Portfolio,
    symbol: string,
    symbolName: string,
    quantity: number,
    currentKline: KLine,
    date: string,
  ): MatchResult {
    // 1. 验证交易数量
    if (quantity <= 0 || quantity % TRADING_RULES.LOT_SIZE !== 0) {
      return this.rejectOrder(portfolio, symbol, symbolName, "buy", quantity, currentKline.close, date, `交易数量必须是 ${TRADING_RULES.LOT_SIZE} 的整数倍`);
    }

    // 2. 检查涨跌停
    const priceLimit = this.getPriceLimit(symbol);
    const upperLimit = this.roundPrice(currentKline.preClose * (1 + priceLimit));
    const isLimitUp = currentKline.close >= upperLimit;

    if (isLimitUp) {
      return this.rejectOrder(portfolio, symbol, symbolName, "buy", quantity, currentKline.close, date, "涨停无法买入（封板）");
    }

    // 3. 计算费用
    const executedPrice = this.simulateSlippage(currentKline, "buy", quantity);
    const amount = executedPrice * quantity;
    const commission = this.calcCommission(amount);
    const transferFee = this.calcTransferFee(amount);
    const totalCost = amount + commission + transferFee;

    // 4. 检查资金
    if (totalCost > portfolio.cash) {
      return this.rejectOrder(portfolio, symbol, symbolName, "buy", quantity, executedPrice, date, `资金不足，需要 ¥${totalCost.toFixed(2)}，可用 ¥${portfolio.cash.toFixed(2)}`);
    }

    // 5. 执行买入
    const order: Order = {
      id: nanoid(),
      symbol,
      symbolName,
      direction: "buy",
      quantity,
      price: currentKline.close,
      orderDate: date,
      status: "filled",
      executedPrice,
      executedQuantity: quantity,
      commission,
      stampTax: 0,
      createdAt: Date.now(),
    };

    // 6. 更新持仓
    const newPortfolio = this.updatePortfolioAfterBuy(
      portfolio,
      symbol,
      symbolName,
      quantity,
      executedPrice,
      commission + transferFee,
      date,
      currentKline.close,
    );

    return {
      order,
      updatedPortfolio: newPortfolio,
      message: `✅ 买入 ${symbolName}(${symbol}) ${quantity}股 @ ¥${executedPrice.toFixed(2)}，花费 ¥${totalCost.toFixed(2)}`,
    };
  }

  /**
   * 执行卖出订单
   */
  sell(
    portfolio: Portfolio,
    symbol: string,
    symbolName: string,
    quantity: number,
    currentKline: KLine,
    date: string,
  ): MatchResult {
    // 1. 验证交易数量
    if (quantity <= 0 || quantity % TRADING_RULES.LOT_SIZE !== 0) {
      return this.rejectOrder(portfolio, symbol, symbolName, "sell", quantity, currentKline.close, date, `交易数量必须是 ${TRADING_RULES.LOT_SIZE} 的整数倍`);
    }

    // 2. 检查持仓
    const position = portfolio.positions.find((p) => p.symbol === symbol);
    if (!position) {
      return this.rejectOrder(portfolio, symbol, symbolName, "sell", quantity, currentKline.close, date, "没有该股票持仓");
    }

    if (quantity > position.availableQuantity) {
      return this.rejectOrder(portfolio, symbol, symbolName, "sell", quantity, currentKline.close, date, `可卖数量不足，可卖 ${position.availableQuantity} 股`);
    }

    // 3. 检查跌停
    const priceLimit = this.getPriceLimit(symbol);
    const lowerLimit = this.roundPrice(currentKline.preClose * (1 - priceLimit));
    const isLimitDown = currentKline.close <= lowerLimit;

    if (isLimitDown) {
      return this.rejectOrder(portfolio, symbol, symbolName, "sell", quantity, currentKline.close, date, "跌停无法卖出（封板）");
    }

    // 4. 计算费用
    const executedPrice = this.simulateSlippage(currentKline, "sell", quantity);
    const amount = executedPrice * quantity;
    const commission = this.calcCommission(amount);
    const stampTax = this.calcStampTax(amount);
    const transferFee = this.calcTransferFee(amount);
    const netProceeds = amount - commission - stampTax - transferFee;

    // 5. 执行卖出
    const order: Order = {
      id: nanoid(),
      symbol,
      symbolName,
      direction: "sell",
      quantity,
      price: currentKline.close,
      orderDate: date,
      status: "filled",
      executedPrice,
      executedQuantity: quantity,
      commission,
      stampTax,
      createdAt: Date.now(),
    };

    // 6. 更新持仓
    const newPortfolio = this.updatePortfolioAfterSell(
      portfolio,
      symbol,
      quantity,
      executedPrice,
      commission + stampTax + transferFee,
      currentKline.close,
    );

    return {
      order,
      updatedPortfolio: newPortfolio,
      message: `✅ 卖出 ${symbolName}(${symbol}) ${quantity}股 @ ¥${executedPrice.toFixed(2)}，收入 ¥${netProceeds.toFixed(2)}`,
    };
  }

  // ============================================================
  // 日终处理
  // ============================================================

  /**
   * 推进到新的一天
   * - 更新所有持仓的当前价格
   * - 昨日买入的股票变为可卖（T+1）
   * - 重新计算组合指标
   */
  advanceDay(
    portfolio: Portfolio,
    klines: Record<string, KLine>, // symbol → 当日 KLine
    previousDayBuys: string[], // 昨日买入的 symbol 列表
  ): Portfolio {
    const updatedPositions = portfolio.positions.map((pos) => {
      const todayKline = klines[pos.symbol];
      const currentPrice = todayKline ? todayKline.close : pos.currentPrice;
      const marketValue = currentPrice * pos.quantity;
      const profitLoss = marketValue - pos.avgCost * pos.quantity;
      const profitLossPercent = pos.avgCost > 0
        ? ((currentPrice - pos.avgCost) / pos.avgCost) * 100
        : 0;

      // T+1: 昨日买入的股票今天可卖
      const isNewlyAvailable = previousDayBuys.includes(pos.symbol);
      const availableQuantity = isNewlyAvailable
        ? pos.quantity // 全部变为可卖
        : pos.availableQuantity;

      return {
        ...pos,
        currentPrice,
        marketValue,
        profitLoss,
        profitLossPercent,
        availableQuantity,
      };
    });

    const totalMarketValue = updatedPositions.reduce((sum, p) => sum + p.marketValue, 0);
    const totalAssets = portfolio.cash + totalMarketValue;
    const totalProfitLoss = totalAssets - portfolio.initialCapital;
    const totalProfitLossPercent = (totalProfitLoss / portfolio.initialCapital) * 100;

    return {
      ...portfolio,
      positions: updatedPositions,
      totalMarketValue,
      totalAssets,
      totalProfitLoss,
      totalProfitLossPercent,
    };
  }

  // ============================================================
  // 绩效计算
  // ============================================================

  /**
   * 计算完整绩效指标
   */
  calcPerformanceMetrics(
    tradeHistory: Order[],
    dailyPortfolioValues: { date: string; totalAssets: number }[],
    initialCapital: number,
  ) {
    // 每日收益率
    const dailyReturns: { date: string; return: number; cumReturn: number }[] = [];
    let prevValue = initialCapital;

    for (const day of dailyPortfolioValues) {
      const dayReturn = (day.totalAssets - prevValue) / prevValue;
      const cumReturn = (day.totalAssets - initialCapital) / initialCapital;
      dailyReturns.push({
        date: day.date,
        return: dayReturn * 100,
        cumReturn: cumReturn * 100,
      });
      prevValue = day.totalAssets;
    }

    // 总收益率
    const finalValue = dailyPortfolioValues.at(-1)?.totalAssets ?? initialCapital;
    const totalReturn = ((finalValue - initialCapital) / initialCapital) * 100;

    // 年化收益率（假设 250 个交易日/年）
    const tradingDays = dailyPortfolioValues.length;
    const annualizedReturn = tradingDays > 0
      ? (Math.pow(finalValue / initialCapital, 250 / tradingDays) - 1) * 100
      : 0;

    // 最大回撤
    let peak = initialCapital;
    let maxDrawdown = 0;
    let maxDrawdownDate = "";

    for (const day of dailyPortfolioValues) {
      if (day.totalAssets > peak) peak = day.totalAssets;
      const drawdown = ((peak - day.totalAssets) / peak) * 100;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
        maxDrawdownDate = day.date;
      }
    }

    // 夏普比率 (无风险利率 = 3%)
    const riskFreeDaily = 0.03 / 250;
    const returns = dailyReturns.map((d) => d.return / 100);
    const meanReturn = returns.reduce((s, r) => s + r, 0) / (returns.length || 1);
    const stdDev = Math.sqrt(
      returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / (returns.length || 1),
    );
    const sharpeRatio = stdDev > 0 ? ((meanReturn - riskFreeDaily) / stdDev) * Math.sqrt(250) : 0;

    // 胜率
    const filledSells = tradeHistory.filter(
      (t) => t.direction === "sell" && t.status === "filled",
    );
    const wins = filledSells.filter((t) => {
      const buyOrders = tradeHistory.filter(
        (b) => b.symbol === t.symbol && b.direction === "buy" && b.status === "filled",
      );
      const avgBuyCost = buyOrders.length > 0
        ? buyOrders.reduce((s, b) => s + (b.executedPrice ?? 0), 0) / buyOrders.length
        : 0;
      return (t.executedPrice ?? 0) > avgBuyCost;
    });

    const winRate = filledSells.length > 0
      ? (wins.length / filledSells.length) * 100
      : 0;

    return {
      totalReturn: this.round(totalReturn, 2),
      annualizedReturn: this.round(annualizedReturn, 2),
      maxDrawdown: this.round(maxDrawdown, 2),
      maxDrawdownDate,
      sharpeRatio: this.round(sharpeRatio, 2),
      winRate: this.round(winRate, 1),
      profitFactor: 0, // 简化版暂不计算
      totalTrades: tradeHistory.filter((t) => t.status === "filled").length,
      winTrades: wins.length,
      lossTrades: filledSells.length - wins.length,
      avgWin: 0,
      avgLoss: 0,
      holdingDays: 0,
      dailyReturns,
    };
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /** 模拟滑点：基于当日量价模拟成交价 */
  private simulateSlippage(
    kline: KLine,
    direction: "buy" | "sell",
    _quantity: number,
  ): number {
    // 简化版：在 close 附近 ±0.2% 随机
    const slippage = (Math.random() - 0.5) * 0.004; // ±0.2%
    const adjustment = direction === "buy" ? Math.abs(slippage) : -Math.abs(slippage);
    const price = kline.close * (1 + adjustment);
    return this.roundPrice(price);
  }

  /** 获取涨跌停幅度 */
  private getPriceLimit(symbol: string): number {
    // 科创板 688xxx, 创业板 300xxx → 20%
    if (symbol.startsWith("688") || symbol.startsWith("300")) {
      return TRADING_RULES.PRICE_LIMIT_STAR;
    }
    return TRADING_RULES.PRICE_LIMIT;
  }

  /** 计算佣金 */
  private calcCommission(amount: number): number {
    const commission = amount * this.feeConfig.commissionRate;
    return Math.max(commission, this.feeConfig.minCommission);
  }

  /** 计算印花税（仅卖出） */
  private calcStampTax(amount: number): number {
    return this.round(amount * this.feeConfig.stampTaxRate, 2);
  }

  /** 计算过户费 */
  private calcTransferFee(amount: number): number {
    return this.round(amount * this.feeConfig.transferFeeRate, 2);
  }

  /** 买入后更新持仓 */
  private updatePortfolioAfterBuy(
    portfolio: Portfolio,
    symbol: string,
    symbolName: string,
    quantity: number,
    executedPrice: number,
    totalFee: number,
    date: string,
    currentPrice: number,
  ): Portfolio {
    const totalCost = executedPrice * quantity + totalFee;
    const newCash = portfolio.cash - totalCost;

    const existingIdx = portfolio.positions.findIndex((p) => p.symbol === symbol);
    let newPositions: Position[];

    if (existingIdx >= 0) {
      // 加仓 — 更新均价
      newPositions = [...portfolio.positions];
      const existing = newPositions[existingIdx];
      const totalQuantity = existing.quantity + quantity;
      const newAvgCost =
        (existing.avgCost * existing.quantity + executedPrice * quantity) / totalQuantity;

      newPositions[existingIdx] = {
        ...existing,
        quantity: totalQuantity,
        avgCost: this.roundPrice(newAvgCost),
        availableQuantity: existing.availableQuantity, // 新买入的今日不可卖
        currentPrice,
        marketValue: currentPrice * totalQuantity,
        profitLoss: (currentPrice - newAvgCost) * totalQuantity,
        profitLossPercent: ((currentPrice - newAvgCost) / newAvgCost) * 100,
      };
    } else {
      // 新建仓位
      const marketValue = currentPrice * quantity;
      newPositions = [
        ...portfolio.positions,
        {
          symbol,
          symbolName,
          quantity,
          availableQuantity: 0, // T+1: 今日买入不可卖
          avgCost: executedPrice,
          currentPrice,
          marketValue,
          profitLoss: (currentPrice - executedPrice) * quantity,
          profitLossPercent: ((currentPrice - executedPrice) / executedPrice) * 100,
          buyDate: date,
        },
      ];
    }

    const totalMarketValue = newPositions.reduce((s, p) => s + p.marketValue, 0);
    const totalAssets = newCash + totalMarketValue;
    const totalProfitLoss = totalAssets - portfolio.initialCapital;

    return {
      ...portfolio,
      cash: this.round(newCash, 2),
      positions: newPositions,
      totalMarketValue: this.round(totalMarketValue, 2),
      totalAssets: this.round(totalAssets, 2),
      totalProfitLoss: this.round(totalProfitLoss, 2),
      totalProfitLossPercent: this.round((totalProfitLoss / portfolio.initialCapital) * 100, 2),
    };
  }

  /** 卖出后更新持仓 */
  private updatePortfolioAfterSell(
    portfolio: Portfolio,
    symbol: string,
    quantity: number,
    executedPrice: number,
    totalFee: number,
    currentPrice: number,
  ): Portfolio {
    const netProceeds = executedPrice * quantity - totalFee;
    const newCash = portfolio.cash + netProceeds;

    let newPositions = portfolio.positions.map((pos) => {
      if (pos.symbol !== symbol) return pos;

      const newQuantity = pos.quantity - quantity;
      const newAvailable = Math.max(0, pos.availableQuantity - quantity);

      if (newQuantity <= 0) return null; // 清仓

      return {
        ...pos,
        quantity: newQuantity,
        availableQuantity: newAvailable,
        currentPrice,
        marketValue: currentPrice * newQuantity,
        profitLoss: (currentPrice - pos.avgCost) * newQuantity,
        profitLossPercent: ((currentPrice - pos.avgCost) / pos.avgCost) * 100,
      };
    }).filter(Boolean) as Position[];

    const totalMarketValue = newPositions.reduce((s, p) => s + p.marketValue, 0);
    const totalAssets = newCash + totalMarketValue;
    const totalProfitLoss = totalAssets - portfolio.initialCapital;

    return {
      ...portfolio,
      cash: this.round(newCash, 2),
      positions: newPositions,
      totalMarketValue: this.round(totalMarketValue, 2),
      totalAssets: this.round(totalAssets, 2),
      totalProfitLoss: this.round(totalProfitLoss, 2),
      totalProfitLossPercent: this.round((totalProfitLoss / portfolio.initialCapital) * 100, 2),
    };
  }

  /** 拒绝订单 */
  private rejectOrder(
    portfolio: Portfolio,
    symbol: string,
    symbolName: string,
    direction: "buy" | "sell",
    quantity: number,
    price: number,
    date: string,
    reason: string,
  ): MatchResult {
    return {
      order: {
        id: nanoid(),
        symbol,
        symbolName,
        direction,
        quantity,
        price,
        orderDate: date,
        status: "rejected",
        createdAt: Date.now(),
      },
      updatedPortfolio: portfolio,
      message: `❌ ${direction === "buy" ? "买入" : "卖出"}被拒绝：${reason}`,
    };
  }

  /** 价格精度（保留 2 位小数） */
  private roundPrice(price: number): number {
    return Math.round(price * 100) / 100;
  }

  /** 通用四舍五入 */
  private round(value: number, decimals: number): number {
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
  }
}
