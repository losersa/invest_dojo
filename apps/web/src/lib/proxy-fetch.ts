// ── 浏览器端同源代理 ──────────────────────────────
// devcloud 上微服务跑在宿主机 localhost:800x，
// 但浏览器（远端）无法直接访问宿主机的 localhost，只能访问同源的 Web(:3000)。
// 因此浏览器内把 http://localhost:<port>/... 改写成 /svc/<name>/... 同源路径，
// 由 middleware.ts 转发到真实服务。
// 服务端（Node）仍直连 localhost，无需代理。

const SVC_PROXY: Record<string, string> = {
  "8001": "/svc/feature",
  "8002": "/svc/train",
  "8003": "/svc/infer",
  "8004": "/svc/backtest",
  "8005": "/svc/monitor",
  "8006": "/svc/data",
};

export function proxyFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (typeof window === "undefined") {
    // 服务端（Node）直接访问宿主机 localhost，无需代理
    return fetch(input as RequestInfo, init);
  }
  let url: string;
  if (typeof input === "string") url = input;
  else if (input instanceof URL) url = input.toString();
  else url = (input as Request).url;
  const m = url.match(/^https?:\/\/localhost:(\d+)\/(.*)$/s);
  if (m && SVC_PROXY[m[1]]) {
    // m[2] 不含前导斜杠（正则 (.*) 在末尾 / 之后），故手动补 /
    url = SVC_PROXY[m[1]] + "/" + m[2];
  }
  return fetch(url, init);
}
