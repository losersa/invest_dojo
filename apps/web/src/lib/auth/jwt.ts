// ============================================================
// JWT 校验（仅用于 Next 中间件，Edge Runtime）
// 与后端 common/auth.py 使用同一 HS256 密钥（AUTH_JWT_SECRET）。
// ============================================================

const DEFAULT_SECRET = "investdojo-dev-jwt-secret-v1";

function b64urlDecode(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export interface JwtClaims {
  sub?: string;
  email?: string;
  role?: string;
}

export async function verifyJwt(token: string): Promise<JwtClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h64, p64, s64] = parts;

  const secret = process.env.AUTH_JWT_SECRET ?? DEFAULT_SECRET;
  const data = new TextEncoder().encode(`${h64}.${p64}`);

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    return null;
  }

  let sig: Uint8Array;
  try {
    sig = b64urlDecode(s64);
  } catch {
    return null;
  }

  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", key, sig as BufferSource, data);
  } catch {
    return null;
  }
  if (!ok) return null;

  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p64)));
    if (payload.exp && Date.now() / 1000 >= payload.exp) return null;
    return payload as JwtClaims;
  } catch {
    return null;
  }
}
