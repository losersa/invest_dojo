#!/usr/bin/env python3
"""
生成 Supabase 兼容的 anon / service_role JWT

用法:
    python3 generate-keys.py <JWT_SECRET>

输出（可直接 source 到 shell）：
    ANON_KEY=eyJhbGci...
    SERVICE_ROLE_KEY=eyJhbGci...

注意：没用 PyJWT 库（避免外部依赖），手写 HS256 签名。
"""

import base64
import hashlib
import hmac
import json
import sys
import time


def b64url(data: bytes) -> str:
    """RFC 7515 base64url（无 padding）"""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def sign_jwt(secret: str, role: str, exp_years: int = 10) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {
        "role": role,
        "iss": "investdojo-supabase-lite",
        "iat": int(time.time()),
        "exp": int(time.time()) + exp_years * 365 * 24 * 3600,
    }

    h = b64url(json.dumps(header, separators=(",", ":")).encode())
    p = b64url(json.dumps(payload, separators=(",", ":")).encode())
    signing_input = f"{h}.{p}".encode()
    sig = hmac.new(secret.encode(), signing_input, hashlib.sha256).digest()
    return f"{h}.{p}.{b64url(sig)}"


def main() -> None:
    if len(sys.argv) < 2 or not sys.argv[1]:
        print("用法: python3 generate-keys.py <JWT_SECRET>", file=sys.stderr)
        sys.exit(2)

    secret = sys.argv[1]
    if len(secret) < 32:
        print("⚠️  JWT_SECRET 建议至少 32 字节", file=sys.stderr)

    print(f"ANON_KEY={sign_jwt(secret, 'anon')}")
    print(f"SERVICE_ROLE_KEY={sign_jwt(secret, 'service_role')}")


if __name__ == "__main__":
    main()
