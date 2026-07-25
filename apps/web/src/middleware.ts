// ============================================================
// Next.js Middleware
// 1) 同源代理：浏览器只能访问同源的 Web(:3000)，无法直接访问
//    devcloud 宿主机上的微服务(localhost:8001~8006)与 Kong(:8000)。
//    前端把 http://localhost:<port>/... 改写成同源的 /svc/<name>/...
//    或 /sb/...，由本中间件转发到真实上游。
// 2) Supabase Auth Session 续期（原有逻辑）。
// ============================================================

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// 同源前缀 -> 上游 baseURL
const TARGETS: Record<string, string> = {
  "/svc/data": "http://localhost:8006",
  "/svc/feature": "http://localhost:8001",
  "/svc/train": "http://localhost:8002",
  "/svc/infer": "http://localhost:8003",
  "/svc/backtest": "http://localhost:8004",
  "/svc/monitor": "http://localhost:8005",
  "/sb": "http://localhost:8000",
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

export async function middleware(request: NextRequest) {
  // 1) 同源代理优先
  const proxied = await tryProxy(request);
  if (proxied) return proxied;

  // 2) Supabase Auth 续期
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const protectedPaths = ["/profile", "/settings"];
  const isProtected = protectedPaths.some((path) =>
    request.nextUrl.pathname.startsWith(path),
  );

  if (isProtected && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirect", request.nextUrl.pathname);
    return NextResponse.redirect(url);
  }

  if (user && request.nextUrl.pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
