#!/usr/bin/env python3
"""InvestDojo 数据库迁移工具

通过 Supabase Management API 执行 SQL 迁移，不需要数据库直连密码。
需要 Supabase access token（classic token）。

前置条件：
    先执行 000_bootstrap.sql 创建 _exec_migration RPC 函数。
    （首次可通过 --bootstrap 自动执行）

用法:
    python scripts/migrate.py                    # 执行所有未执行的迁移
    python scripts/migrate.py --dry-run          # 只打印，不执行
    python scripts/migrate.py --file 001         # 只执行指定文件
    python scripts/migrate.py --status           # 查看迁移状态
    python scripts/migrate.py --bootstrap        # 仅执行 bootstrap

环境变量:
    SUPABASE_ACCESS_TOKEN   — Supabase classic token (sbp_xxx)
    SUPABASE_PROJECT_REF    — 项目 ID (adqznqsciqtepzimcvsg)
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).parent.parent / "migrations"


def _load_config() -> tuple[str, str]:
    token = os.environ.get("SUPABASE_ACCESS_TOKEN", "")
    ref = os.environ.get("SUPABASE_PROJECT_REF", "")

    if not ref:
        # 尝试从 supabase link 读取
        temp_ref = Path(__file__).parent.parent / "supabase" / ".temp" / "project-ref"
        if temp_ref.exists():
            ref = temp_ref.read_text().strip()

    if not ref:
        ref = "adqznqsciqtepzimcvsg"

    if not token:
        # 尝试从环境读
        for env_file in [
            Path(__file__).parent.parent / "apps" / "server" / ".env",
            Path(__file__).parent.parent / "python-services" / ".env",
        ]:
            if env_file.exists():
                for line in env_file.read_text().splitlines():
                    line = line.strip()
                    if line.startswith("SUPABASE_ACCESS_TOKEN="):
                        token = line.split("=", 1)[1].strip()
                        break
                if token:
                    break

    if not token:
        print("❌ 需要 SUPABASE_ACCESS_TOKEN 环境变量")
        print("   export SUPABASE_ACCESS_TOKEN=sbp_xxxx")
        sys.exit(1)

    return token, ref


def exec_sql(token: str, ref: str, sql: str) -> tuple[bool, str, int]:
    """通过 Management API 执行 SQL"""
    api_url = f"https://api.supabase.com/v1/projects/{ref}/database/query"
    start = time.monotonic()

    result = subprocess.run(
        ["curl", "-sS", "-X", "POST", api_url,
         "-H", f"Authorization: Bearer {token}",
         "-H", "Content-Type: application/json",
         "-d", json.dumps({"query": sql}),
         "--max-time", "120"],
        capture_output=True, text=True,
    )

    elapsed = int((time.monotonic() - start) * 1000)
    body = result.stdout.strip()

    if result.returncode != 0:
        return False, f"curl error: {result.stderr}", elapsed
    if body.startswith("[") or body == "":
        return True, body[:300] if body else "OK", elapsed
    try:
        err = json.loads(body)
        if "message" in err:
            return False, err["message"][:500], elapsed
    except json.JSONDecodeError:
        pass
    return True, body[:300], elapsed


def get_migration_files() -> list[Path]:
    if not MIGRATIONS_DIR.exists():
        print(f"❌ 迁移目录不存在: {MIGRATIONS_DIR}")
        sys.exit(1)
    files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    return [f for f in files if not f.name.startswith("_")]


def file_checksum(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def get_applied(token: str, ref: str) -> set[str]:
    ok, body, _ = exec_sql(token, ref, "SELECT filename FROM _migration_history")
    if not ok:
        return set()
    try:
        rows = json.loads(body)
        return {r["filename"] for r in rows}
    except (json.JSONDecodeError, TypeError):
        return set()


def record_applied(token: str, ref: str, filename: str, checksum: str, duration_ms: int):
    sql = (
        f"INSERT INTO _migration_history (filename, checksum, duration_ms) "
        f"VALUES ('{filename}', '{checksum}', {duration_ms}) "
        f"ON CONFLICT (filename) DO UPDATE "
        f"SET checksum = '{checksum}', applied_at = NOW(), duration_ms = {duration_ms}"
    )
    exec_sql(token, ref, sql)


def cmd_migrate(args):
    token, ref = _load_config()

    files = get_migration_files()
    applied = get_applied(token, ref) if not args.dry_run else set()

    if args.file:
        files = [f for f in files if args.file in f.name]
        if not files:
            print(f"❌ 找不到包含 '{args.file}' 的迁移文件")
            sys.exit(1)

    pending = [f for f in files if f.name not in applied]

    if not pending:
        print("✅ 所有迁移已执行，无需操作")
        return

    mode = " [DRY-RUN]" if args.dry_run else ""
    print(f"\n🔄 待执行 {len(pending)} 个迁移{mode}:\n")

    success = failed = 0
    for f in pending:
        checksum = file_checksum(f)
        sql = f.read_text(encoding="utf-8")

        if args.dry_run:
            print(f"  📋 {f.name} ({checksum}) — {len(sql)} 字符")
            success += 1
            continue

        print(f"  ▶ {f.name} ({checksum})...", end=" ", flush=True)
        ok, msg, elapsed = exec_sql(token, ref, sql)

        if ok:
            print(f"✅ {elapsed}ms")
            record_applied(token, ref, f.name, checksum, elapsed)
            success += 1
        else:
            print(f"❌ {elapsed}ms")
            print(f"    {msg}")
            failed += 1
            if not args.force:
                print("\n⛔ 停止。--force 跳过错误。")
                break

    print(f"\n{'📋 DRY-RUN' if args.dry_run else '🏁 完成'}: {success} 成功, {failed} 失败")


def cmd_status(args):
    token, ref = _load_config()
    files = get_migration_files()
    applied = get_applied(token, ref)

    print(f"\n📊 迁移状态（{len(files)} 个文件）:\n")
    for f in files:
        icon = "🟢" if f.name in applied else "⚪️"
        print(f"  {icon}  {f.name}")

    pending = sum(1 for f in files if f.name not in applied)
    print(f"\n  已执行: {len(applied)}, 待执行: {pending}")


def main():
    parser = argparse.ArgumentParser(description="InvestDojo 数据库迁移工具")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--file", type=str)
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    if args.status:
        cmd_status(args)
    else:
        cmd_migrate(args)


if __name__ == "__main__":
    main()
