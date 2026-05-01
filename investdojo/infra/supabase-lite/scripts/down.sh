#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$SCRIPT_DIR")"
echo "停止 Supabase 精简栈..."
docker compose down
echo "✓ 已停止（数据仍保留在 DATA_DIR）"
echo "  清空数据：rm -rf ./data  （不可逆！）"
