// ============================================================
// Next.js Middleware
// 1) 同源代理：浏览器只能访问同源的 Web(:3000)，无法直接访问
//    devcloud 宿主机上的微服务(localhost:8001~8006)。前端把请求改写为
//    /svc/<name>/...，由本中间件转发到真实上游。
// 2) 自建鉴权：基于 id_session Cookie 中的 JWT 做路由保护（替代原 Supabase）。
// ============================================================

import { NextResponse, type NextRequest } from "next/server";
import { verifyJwt } from "@/lib/auth/jwt";

// 同源前缀 -> 上游 baseURL
const TARGETS: Record<string, string> = {
  "/svc/data": "http://localhost:8006",
  "/svc/feature": "http://localhost:8001",
  "/svc/train": "http://localhost:8002",
  "/svc/infer": "http://localhost:8003",
  "/svc/backtest": "http://localhost:8004",
  "/svc/monitor": "http://localhost:8005",
};

function resolvePrefix(pathname: string): string | undefined {
  let best: string | undefined;
  for (const key of Object.keys(TARGETS)) {
    if (pathname === key || pathname.startsWith(key + "/")) {
      if (!best || key.length > best.length) best = key;
    }
  }
  return best;
}

export async function tryProxy(request: NextRequest): Promise<NextResponse | null> {
  const { pathname, search } = request.nextUrl;
  const prefix = resolvePrefix(pathname);
  if (!prefix) return null;

  const upstream = TARGETS[prefix] + pathname.slice(prefix.length) + search;

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(upstream, init);
  } catch {
    return new NextResponse("Bad Gateway: " + upstream, { status: 502 });
  }

  const respHeaders = new Headers(upstreamResp.headers);
  // 移除 hop-by-hop / 会导致浏览器解析出错的头（fetch 已透明解压）
  respHeaders.delete("transfer-encoding");
  respHeaders.delete("connection");
  respHeaders.delete("content-encoding");
  respHeaders.delete("content-length");

  return new NextResponse(upstreamResp.body, {
    status: upstreamResp.status,
    headers: respHeaders,
  });
}

const SESSION_COOKIE = "id_session";
const PROTECTED_PATHS = ["/profile", "/settings"];

export async function middleware(request: NextRequest) {
  // 1) 同源代理优先
  const proxied = await tryProxy(request);
  if (proxied) return proxied;

  const { pathname } = request.nextUrl;

  // 2) 鉴权：校验 id_session Cookie 中的 JWT
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const claims = token ? await verifyJwt(token) : null;
  const isAuthed = !!claims?.sub;

  const isProtected = PROTECTED_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );

  if (isProtected && !isAuthed) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirect", pathname);
    return NextResponse.redirect(url);
  }

  if (isAuthed && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
