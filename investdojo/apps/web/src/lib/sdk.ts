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
import { createClient } from "@/lib/supabase/client";

// ── 用户 ID 缓存 ──────────────────────────────
let _cachedUserId: string | undefined;
let _initialized = false;
let _readyPromise: Promise<void> | null = null;

/** 模块加载时立即初始化，确保首次调 getCurrentUserId() 就有值 */
function _initAuth() {
  if (_initialized || typeof window === "undefined") return;
  _initialized = true;

  const supabase = createClient();

  // getSession 从 localStorage 读取，很快返回
  _readyPromise = supabase.auth.getSession().then(({ data: { session } }) => {
    _cachedUserId = session?.user?.id ?? undefined;
  });

  // 监听登录/登出事件，实时更新
  supabase.auth.onAuthStateChange((_event, session) => {
    _cachedUserId = session?.user?.id ?? undefined;
  });
}

// 模块加载时立即触发
_initAuth();

function getCurrentUserId(): string | undefined {
  return _cachedUserId;
}

/** 等待用户 ID 就绪（用于写操作前 await，保证 header 不会为空） */
export async function ensureUserId(): Promise<string | undefined> {
  if (_readyPromise) await _readyPromise;
  return _cachedUserId;
}

export const sdk = createInvestDojoClient({
  baseURLs: {
    data: process.env.NEXT_PUBLIC_DATA_SVC_URL ?? "http://192.168.1.3:8006",
    feature: process.env.NEXT_PUBLIC_FEATURE_SVC_URL ?? "http://192.168.1.3:8001",
    train: process.env.NEXT_PUBLIC_TRAIN_SVC_URL ?? "http://192.168.1.3:8002",
    infer: process.env.NEXT_PUBLIC_INFER_SVC_URL ?? "http://192.168.1.3:8003",
    backtest: process.env.NEXT_PUBLIC_BACKTEST_SVC_URL ?? "http://192.168.1.3:8004",
    monitor: process.env.NEXT_PUBLIC_MONITOR_SVC_URL ?? "http://192.168.1.3:8005",
  },
  userId: () => getCurrentUserId(),
  timeoutMs: 15_000,
});
