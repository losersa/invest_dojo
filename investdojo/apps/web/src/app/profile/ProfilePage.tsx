"use client";

// ============================================================
// 个人中心页面 — 用户信息 + 模拟历史 + 设置
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

  // 解析用户信息
  const displayName =
    user.user_metadata?.display_name ??
    user.user_metadata?.full_name ??
    user.user_metadata?.name ??
    user.email?.split("@")[0] ??
    "投资者";

  const avatarUrl =
    user.user_metadata?.avatar_url ??
    user.user_metadata?.picture ??
    null;

  const provider = user.app_metadata?.provider ?? "email";
  const createdAt = new Date(user.created_at).toLocaleDateString("zh-CN");

  // 登出
  const handleSignOut = async () => {
    setLoading(true);
    await supabase.auth.signOut();
    router.push("/");
    router.refresh();
  };

  return (
    <div className="min-h-screen bg-gray-950">
      {/* 顶部导航 */}
      <header className="sticky top-0 z-40 bg-gray-900/95 backdrop-blur-sm border-b border-gray-800">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-gray-500 hover:text-gray-300 text-sm">
              ← 返回首页
            </Link>
            <h1 className="text-sm font-bold text-white">个人中心</h1>
          </div>
          <button
            onClick={handleSignOut}
            disabled={loading}
            className="px-3 py-1.5 text-sm text-gray-400 hover:text-white border border-gray-700 hover:border-gray-600 rounded-lg transition-colors"
          >
            {loading ? "退出中..." : "退出登录"}
          </button>
        </div>
      </header>

      {/* 主体内容 */}
      <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">
        {/* 用户信息卡片 */}
        <section className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
          <div className="flex items-start gap-5">
            {/* 头像 */}
            <div className="flex-shrink-0">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt={displayName}
                  className="w-20 h-20 rounded-full border-2 border-gray-700"
                />
              ) : (
                <div className="w-20 h-20 rounded-full bg-gradient-to-br from-blue-500 to-violet-500 flex items-center justify-center text-3xl font-bold text-white">
                  {displayName.charAt(0).toUpperCase()}
                </div>
              )}
            </div>

            {/* 信息 */}
            <div className="flex-1 min-w-0">
              <h2 className="text-xl font-bold text-white">{displayName}</h2>
              <p className="text-sm text-gray-400 mt-1">{user.email}</p>
              <div className="flex items-center gap-4 mt-3 text-xs text-gray-500">
                <span className="flex items-center gap-1">
                  {provider === "github" && "🐙 GitHub 登录"}
                  {provider === "google" && "🔍 Google 登录"}
                  {provider === "email" && "📧 邮箱登录"}
                </span>
                <span>📅 注册于 {createdAt}</span>
              </div>
            </div>
          </div>
        </section>

        {/* 快捷入口 */}
        <section>
          <h3 className="text-sm font-medium text-gray-400 mb-4">快捷入口</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Link
              href="/simulation"
              className="flex items-center gap-4 p-4 bg-gray-900 border border-gray-800 rounded-xl hover:border-blue-500/40 transition-colors group"
            >
              <span className="text-2xl">🎮</span>
              <div>
                <div className="text-sm font-medium text-white group-hover:text-blue-400 transition-colors">
                  历史情景模拟
                </div>
                <div className="text-xs text-gray-500">继续你的模拟交易</div>
              </div>
            </Link>

            <div className="flex items-center gap-4 p-4 bg-gray-900/50 border border-gray-800 rounded-xl opacity-60 cursor-not-allowed">
              <span className="text-2xl">📊</span>
              <div>
                <div className="text-sm font-medium text-gray-400">AI 量化回测</div>
                <div className="text-xs text-gray-600">即将推出</div>
              </div>
            </div>

            <div className="flex items-center gap-4 p-4 bg-gray-900/50 border border-gray-800 rounded-xl opacity-60 cursor-not-allowed">
              <span className="text-2xl">📋</span>
              <div>
                <div className="text-sm font-medium text-gray-400">AI 财报分析</div>
                <div className="text-xs text-gray-600">即将推出</div>
              </div>
            </div>
          </div>
        </section>

        {/* 模拟历史（占位） */}
        <section>
          <h3 className="text-sm font-medium text-gray-400 mb-4">最近模拟记录</h3>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center">
            <div className="text-4xl mb-3">📭</div>
            <p className="text-sm text-gray-500">
              暂无模拟记录
            </p>
            <Link
              href="/simulation"
              className="inline-block mt-3 text-sm text-blue-400 hover:text-blue-300 transition-colors"
            >
              开始你的第一场模拟 →
            </Link>
          </div>
        </section>

        {/* 账户信息 */}
        <section>
          <h3 className="text-sm font-medium text-gray-400 mb-4">账户信息</h3>
          <div className="bg-gray-900 border border-gray-800 rounded-xl divide-y divide-gray-800">
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-gray-400">用户 ID</span>
              <span className="text-xs text-gray-600 font-mono">{user.id.slice(0, 8)}...</span>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-gray-400">邮箱</span>
              <span className="text-sm text-gray-300">{user.email}</span>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-gray-400">登录方式</span>
              <span className="text-sm text-gray-300 capitalize">{provider}</span>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-gray-400">订阅计划</span>
              <span className="text-xs px-2 py-0.5 bg-gray-800 text-gray-400 rounded">免费版</span>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-gray-400">注册时间</span>
              <span className="text-sm text-gray-300">{createdAt}</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
