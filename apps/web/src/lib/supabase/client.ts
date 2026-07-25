// ============================================================
// Supabase 浏览器端客户端 — 用于 "use client" 组件
// ============================================================

import { createBrowserClient } from "@supabase/ssr";
import { proxyFetch } from "@/lib/proxy-fetch";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { fetch: proxyFetch } },
  );
}
