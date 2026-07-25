// ============================================================
// @investdojo/api — Supabase 客户端初始化
// ============================================================

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let supabaseInstance: SupabaseClient | null = null;

function readEnv(): { url?: string; key?: string } {
  const env = (globalThis as unknown as { process?: { env?: Record<string, string> } })?.process?.env;
  return {
    url: env?.NEXT_PUBLIC_SUPABASE_URL,
    key: env?.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  };
}

/**
 * 获取 Supabase 客户端单例
 */
export function getSupabase(): SupabaseClient {
  if (supabaseInstance) return supabaseInstance;

  const { url, key } = readEnv();

  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
      "Set them in .env.local"
    );
  }

  supabaseInstance = createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
    realtime: {
      params: {
        eventsPerSecond: 10,
      },
    },
  });

  return supabaseInstance;
}

export type { SupabaseClient };
