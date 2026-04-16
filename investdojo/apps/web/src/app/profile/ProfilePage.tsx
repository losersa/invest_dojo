"use client";

// ============================================================
// 个人中心页面 — Raycast Design System
// Near-black bg + elevated cards + blue accent
// ============================================================

import React, { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";

interface ProfilePageProps {
  user: User;
}

export function ProfilePage({ user }: ProfilePageProps) {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(false);

  const displayName =
    user.user_metadata?.display_name ??
    user.user_metadata?.full_name ??
    user.email?.split("@")[0] ??
    "投资者";

  const avatarUrl = user.user_metadata?.avatar_url ?? user.user_metadata?.picture ?? null;
  const provider = user.app_metadata?.provider ?? "email";
  const createdAt = new Date(user.created_at).toLocaleDateString("zh-CN");

  const handleSignOut = async () => {
    setLoading(true);
    await supabase.auth.signOut();
    router.push("/");
    router.refresh();
  };

  return (
    <div className="min-h-screen bg-rc-bg">
      {/* Nav */}
      <nav className="sticky top-0 z-50 bg-rc-bg border-b border-rc-border">
        <div className="max-w-[1200px] mx-auto flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-4">
            <Link href="/" className="rc-nav-link text-[14px]">← 返回首页</Link>
            <span className="text-[16px] font-medium text-white tracking-[0.2px]">个人中心</span>
          </div>
          <button
            onClick={handleSignOut}
            disabled={loading}
            className="text-[14px] text-rc-text-muted hover:text-white transition-opacity duration-150 hover:opacity-60 tracking-[0.2px]"
          >
            {loading ? "退出中..." : "退出登录"}
          </button>
        </div>
      </nav>

      <div className="max-w-3xl mx-auto px-6 py-12 space-y-8">
        {/* User Card */}
        <section className="rc-card-elevated p-8">
          <div className="flex items-start gap-5">
            {avatarUrl ? (
              <img src={avatarUrl} alt={displayName} className="w-20 h-20 rounded-[12px] border border-rc-border-subtle" />
            ) : (
              <div className="w-20 h-20 rounded-[12px] bg-rc-blue flex items-center justify-center text-[28px] font-semibold text-rc-btn-fg">
                {displayName.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <h2 className="text-section-heading text-white">{displayName}</h2>
              <p className="text-caption text-rc-text-secondary mt-1">{user.email}</p>
              <div className="flex items-center gap-4 mt-3">
                <span className="rc-badge text-[12px]">
                  {provider.toUpperCase()}
                </span>
                <span className="text-[12px] text-rc-text-muted tracking-[0.2px]">📅 {createdAt}</span>
              </div>
            </div>
          </div>
        </section>

        {/* Quick Links */}
        <section>
          <h3 className="rc-label text-[13px] mb-3">快速入口</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Link
              href="/simulation"
              className="group rc-card p-5 transition-all duration-150 hover:translate-y-[-1px]"
            >
              <span className="text-2xl">🎮</span>
              <div className="mt-3">
                <div className="text-[14px] font-medium text-white group-hover:text-rc-blue transition-colors duration-150 tracking-[0.2px]">历史情景模拟</div>
                <div className="text-[12px] text-rc-text-muted mt-1">继续你的模拟交易</div>
              </div>
            </Link>
            <div className="rc-card p-5 opacity-40">
              <span className="text-2xl">📊</span>
              <div className="mt-3">
                <div className="text-[14px] font-medium text-rc-text-dim tracking-[0.2px]">AI 量化回测</div>
                <span className="rc-badge rc-badge-info text-[10px] mt-1">COMING SOON</span>
              </div>
            </div>
            <div className="rc-card p-5 opacity-40">
              <span className="text-2xl">📋</span>
              <div className="mt-3">
                <div className="text-[14px] font-medium text-rc-text-dim tracking-[0.2px]">AI 财报分析</div>
                <span className="rc-badge rc-badge-info text-[10px] mt-1">COMING SOON</span>
              </div>
            </div>
          </div>
        </section>

        {/* Recent Simulations */}
        <section>
          <h3 className="rc-label text-[13px] mb-3">近期模拟</h3>
          <div className="rc-card p-10 text-center">
            <div className="text-4xl mb-3">📭</div>
            <p className="text-caption text-rc-text-muted">暂无模拟记录</p>
            <Link href="/simulation" className="inline-block mt-3 text-caption text-rc-blue hover:underline transition-opacity duration-150">
              开始你的第一场模拟 →
            </Link>
          </div>
        </section>

        {/* Account Info */}
        <section>
          <h3 className="rc-label text-[13px] mb-3">账户信息</h3>
          <div className="rc-card p-0 divide-y divide-rc-border-subtle overflow-hidden">
            {[
              { label: "用户 ID", value: <span className="text-[12px] font-rc-mono text-rc-text-muted">{user.id.slice(0, 8)}...</span> },
              { label: "邮箱", value: <span className="text-[14px] text-white tracking-[0.2px]">{user.email}</span> },
              { label: "登录方式", value: <span className="rc-badge text-[12px]">{provider.toUpperCase()}</span> },
              { label: "套餐", value: <span className="rc-badge text-[12px]">FREE</span> },
              { label: "注册时间", value: <span className="text-[14px] text-white tracking-[0.2px]">{createdAt}</span> },
            ].map(({ label, value }) => (
              <div key={label} className="flex items-center justify-between px-6 py-4">
                <span className="text-[13px] text-rc-text-muted tracking-[0.2px]">{label}</span>
                {value}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
