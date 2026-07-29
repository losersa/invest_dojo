// ============================================================
// 自建轻量鉴权模块（前端侧）
// 对应后端：data-svc /api/v1/auth/*（common/auth.py）
// 登录态以 httpOnly Cookie(id_session) 保存，由后端 Set-Cookie，
// 经 Next 中间件代理落到 localhost:3000 域。
// ============================================================

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: string; // "admin" | "staff" | "employee" | "user"
  provider: string;
  createdAt?: string;
}

const AUTH_BASE = "/svc/data/api/v1/auth";

// ── 内存缓存 + 订阅（替代 supabase onAuthStateChange）──
let cached: AuthUser | null = null;
const listeners = new Set<(u: AuthUser | null) => void>();

function setCached(u: AuthUser | null) {
  cached = u;
  listeners.forEach((cb) => cb(u));
}

export function onAuthChange(cb: (u: AuthUser | null) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getCachedUser(): AuthUser | null {
  return cached;
}

async function fetchMe(): Promise<AuthUser | null> {
  try {
    const res = await fetch(`${AUTH_BASE}/me`, { credentials: "include" });
    if (!res.ok) return null;
    const data = (await res.json()) as { user: AuthUser };
    return data.user ?? null;
  } catch {
    return null;
  }
}

/** 确保已拿到当前用户（首屏调用），并填充缓存 */
export async function ensureUser(): Promise<AuthUser | null> {
  if (cached) return cached;
  cached = await fetchMe();
  return cached;
}

export async function getUserId(): Promise<string | undefined> {
  const u = await ensureUser();
  return u?.id;
}

async function postJson(
  path: string,
  body: unknown,
): Promise<AuthUser> {
  const res = await fetch(`${AUTH_BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as {
      detail?: { error?: { message?: string } };
    };
    throw new Error(err.detail?.error?.message ?? "请求失败");
  }
  const data = (await res.json()) as { user: AuthUser };
  const u = data.user;
  setCached(u);
  return u;
}

export async function login(email: string, password: string): Promise<AuthUser> {
  return postJson("/login", { email, password });
}

export async function register(
  email: string,
  password: string,
  displayName?: string,
): Promise<AuthUser> {
  return postJson("/register", { email, password, display_name: displayName });
}

export async function logout(): Promise<void> {
  try {
    await fetch(`${AUTH_BASE}/logout`, {
      method: "POST",
      credentials: "include",
    });
  } finally {
    setCached(null);
  }
}
