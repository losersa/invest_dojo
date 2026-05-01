/**
 * 全局 SDK 单例
 *
 * Base URL 按环境变量解析：
 * - NEXT_PUBLIC_FEATURE_SVC_URL  (因子服务)
 * - NEXT_PUBLIC_DATA_SVC_URL     (K 线 / 场景)
 * - ...
 *
 * 本地 dev 时默认走 localhost:8000~8005
 */
import { createInvestDojoClient } from "@investdojo/api";

export const sdk = createInvestDojoClient({
  baseURLs: {
    data: process.env.NEXT_PUBLIC_DATA_SVC_URL ?? "http://localhost:8000",
    feature: process.env.NEXT_PUBLIC_FEATURE_SVC_URL ?? "http://localhost:8001",
    train: process.env.NEXT_PUBLIC_TRAIN_SVC_URL ?? "http://localhost:8002",
    infer: process.env.NEXT_PUBLIC_INFER_SVC_URL ?? "http://localhost:8003",
    backtest: process.env.NEXT_PUBLIC_BACKTEST_SVC_URL ?? "http://localhost:8004",
    monitor: process.env.NEXT_PUBLIC_MONITOR_SVC_URL ?? "http://localhost:8005",
  },
  timeoutMs: 15_000,
});
