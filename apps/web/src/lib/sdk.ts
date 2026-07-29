/**
 * 全局 SDK 单例
 *
 * Base URL 按环境变量解析：
 * - NEXT_PUBLIC_FEATURE_SVC_URL  (因子服务)
 * - NEXT_PUBLIC_DATA_SVC_URL     (K 线 / 场景)
 * - ...
 *
 * 本地 dev 时默认走 localhost:10001~10006
 */
import { createInvestDojoClient } from "@investdojo/api";
import { ensureUser, onAuthChange } from "@/lib/auth/auth";
import { proxyFetch } from "@/lib/proxy-fetch";

// ── 用户 ID 缓存 ──────────────────────────────
let _cachedUserId: string | undefined;
let _initialized = false;
let _readyPromise: Promise<void> | null = null;

/** 模块加载时立即初始化，确保首次调 ensureUserId() 就有值 */
function _initAuth() {
  if (_initialized || typeof window === "undefined") return;
  _initialized = true;

  // 经由自建鉴权模块 /api/v1/auth/me 取当前用户（Cookie 携带，异步就绪）
  _readyPromise = ensureUser().then((u) => {
    _cachedUserId = u?.id;
  });

  // 登录/登出时实时更新
  onAuthChange((u) => {
    _cachedUserId = u?.id;
  });
}

// 模块加载时立即触发
_initAuth();

/** 等待用户 ID 就绪（用于写操作前 await，保证 header 不会为空） */
export async function ensureUserId(): Promise<string | undefined> {
  if (_readyPromise) await _readyPromise;
  return _cachedUserId;
}

export const sdk = createInvestDojoClient({
  baseURLs: {
    data: process.env.NEXT_PUBLIC_DATA_SVC_URL ?? "http://localhost:10006",
    feature: process.env.NEXT_PUBLIC_FEATURE_SVC_URL ?? "http://localhost:10001",
    train: process.env.NEXT_PUBLIC_TRAIN_SVC_URL ?? "http://localhost:10002",
    infer: process.env.NEXT_PUBLIC_INFER_SVC_URL ?? "http://localhost:10003",
    backtest: process.env.NEXT_PUBLIC_BACKTEST_SVC_URL ?? "http://localhost:10004",
    monitor: process.env.NEXT_PUBLIC_MONITOR_SVC_URL ?? "http://localhost:10005",
  },
  // 用 await 就绪的 ensureUserId，避免首屏在会话 resolve 前以「匿名」发请求
  userId: () => ensureUserId(),
  // 真实引擎回测（model 类型）需复现训练特征工程，重拉因子可能耗时数十秒，
  // 故全局超时放宽到 120s；其余快速接口通常几百毫秒内返回，不会因此变慢。
  timeoutMs: 120_000,
  fetchImpl: proxyFetch,
});
