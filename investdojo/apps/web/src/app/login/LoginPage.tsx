"use client";

// ============================================================
// 登录/注册页面 — 邮箱密码 + OAuth（GitHub/Google 需配置后启用）
// ============================================================

import React, { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type AuthMode = "login" | "register";

// OAuth 提供者是否已在 Supabase 后台配置
// 配置好后改为 true 即可启用按钮
const OAUTH_PROVIDERS = {
  github: false,  // 需在 Supabase Dashboard → Auth → Providers → GitHub 中配置
  google: false,  // 需在 Supabase Dashboard → Auth → Providers → Google 中配置
};

export function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirect = searchParams.get("redirect") ?? "/";

  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const supabase = createClient();

  // ====== 邮箱登录 ======
  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError(error.message === "Invalid login credentials"
        ? "邮箱或密码错误"
        : error.message);
      setLoading(false);
      return;
    }

    router.push(redirect);
    router.refresh();
  };

  // ====== 邮箱注册 ======
  const handleEmailRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    if (password.length < 6) {
      setError("密码至少 6 位");
      setLoading(false);
      return;
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          display_name: nickname || email.split("@")[0],
        },
      },
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    // 如果邮箱已自动确认（开发模式），直接跳转
    if (data.session) {
      router.push(redirect);
      router.refresh();
      return;
    }

    // 否则提示验证邮件
    setSuccess("注册成功！请查收验证邮件，验证后即可登录。");
    setLoading(false);
  };

  // ====== OAuth 登录（通用） ======
  const handleOAuthLogin = async (provider: "github" | "google") => {
    if (!OAUTH_PROVIDERS[provider]) {
      setError(`${provider === "github" ? "GitHub" : "Google"} 登录尚未配置，请先使用邮箱登录。配置方法见 docs/开发指南.md`);
      return;
    }

    setError(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/auth/callback?redirect=${redirect}`,
      },
    });
    if (error) setError(error.message);
  };

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <Link href="/" className="inline-block">
            <h1 className="text-3xl font-bold">
              <span className="text-4xl mr-2">🥋</span>
              <span className="bg-gradient-to-r from-blue-400 to-violet-400 bg-clip-text text-transparent">
                InvestDojo
              </span>
            </h1>
          </Link>
          <p className="text-sm text-gray-500 mt-2">
            {mode === "login" ? "登录你的投资道场" : "创建投资道场账号"}
          </p>
        </div>

        {/* 卡片 */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 space-y-5">
          {/* 第三方登录 */}
          <div className="space-y-3">
            <button
              onClick={() => handleOAuthLogin("github")}
              className={`w-full flex items-center justify-center gap-3 px-4 py-2.5 border rounded-lg text-sm font-medium transition-colors ${
                OAUTH_PROVIDERS.github
                  ? "bg-gray-800 hover:bg-gray-700 border-gray-700"
                  : "bg-gray-800/50 border-gray-700/50 text-gray-500 cursor-not-allowed"
              }`}
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
              使用 GitHub 登录
              {!OAUTH_PROVIDERS.github && (
                <span className="text-[10px] px-1.5 py-0.5 bg-gray-700 rounded text-gray-400">待配置</span>
              )}
            </button>

            <button
              onClick={() => handleOAuthLogin("google")}
              className={`w-full flex items-center justify-center gap-3 px-4 py-2.5 border rounded-lg text-sm font-medium transition-colors ${
                OAUTH_PROVIDERS.google
                  ? "bg-gray-800 hover:bg-gray-700 border-gray-700"
                  : "bg-gray-800/50 border-gray-700/50 text-gray-500 cursor-not-allowed"
              }`}
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
              </svg>
              使用 Google 登录
              {!OAUTH_PROVIDERS.google && (
                <span className="text-[10px] px-1.5 py-0.5 bg-gray-700 rounded text-gray-400">待配置</span>
              )}
            </button>
          </div>

          {/* 分割线 */}
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-700" />
            </div>
            <div className="relative flex justify-center text-xs">
              <span className="bg-gray-900 px-3 text-gray-500">
                或使用邮箱
              </span>
            </div>
          </div>

          {/* 邮箱登录/注册表单 */}
          <form onSubmit={mode === "login" ? handleEmailLogin : handleEmailRegister}>
            <div className="space-y-3">
              {mode === "register" && (
                <div>
                  <label className="block text-xs text-gray-400 mb-1">昵称</label>
                  <input
                    type="text"
                    value={nickname}
                    onChange={(e) => setNickname(e.target.value)}
                    placeholder="你的投资道场名号"
                    className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs text-gray-400 mb-1">邮箱</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  required
                  className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-1">密码</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === "register" ? "至少 6 位" : "输入密码"}
                  required
                  minLength={6}
                  className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors"
                />
              </div>
            </div>

            {/* 错误提示 */}
            {error && (
              <div className="mt-3 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
                {error}
              </div>
            )}

            {/* 成功提示 */}
            {success && (
              <div className="mt-3 px-3 py-2 bg-green-500/10 border border-green-500/20 rounded-lg text-sm text-green-400">
                {success}
              </div>
            )}

            {/* 提交按钮 */}
            <button
              type="submit"
              disabled={loading}
              className="w-full mt-4 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
            >
              {loading ? "处理中..." : mode === "login" ? "登录" : "注册"}
            </button>
          </form>

          {/* 切换登录/注册 */}
          <div className="text-center text-sm text-gray-500">
            {mode === "login" ? (
              <>
                还没有账号？{" "}
                <button
                  onClick={() => { setMode("register"); setError(null); setSuccess(null); }}
                  className="text-blue-400 hover:text-blue-300 transition-colors"
                >
                  立即注册
                </button>
              </>
            ) : (
              <>
                已有账号？{" "}
                <button
                  onClick={() => { setMode("login"); setError(null); setSuccess(null); }}
                  className="text-blue-400 hover:text-blue-300 transition-colors"
                >
                  去登录
                </button>
              </>
            )}
          </div>
        </div>

        {/* 底部信息 */}
        <p className="mt-6 text-center text-xs text-gray-600">
          登录即表示你同意{" "}
          <span className="text-gray-500">服务条款</span> 和{" "}
          <span className="text-gray-500">隐私政策</span>
        </p>
      </div>
    </div>
  );
}
