"""Builtin 因子 YAML 加载器 + 批量注册（T-3.03）

职责：
- 读 `factors/builtin/*.yaml`
- 对每个因子：
  1. 解析 DSL（T-3.01 parser）
  2. 推断 lookback_days / output_type（覆盖 YAML 里的手填值）
  3. 可选：用真实面板跑一次 engine 确保可执行
  4. 转成 factor_definitions 表 schema

使用：
    from factors.builtin_loader import load_all_builtins, validate_builtin
    factors = load_all_builtins()        # 解析 + 推断
    validate_builtin(factors, panel)     # 每个都跑 engine 过一遍
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from .dsl_parser import DSLError, UnknownFunctionError, parse_formula
from .engine import EngineError, eval_ast

BUILTIN_DIR = Path(__file__).parent / "builtin"


def load_builtin_file(path: Path) -> list[dict[str, Any]]:
    """读一个 YAML 文件，返回 factor 记录列表（已补齐 lookback/output_type）"""
    with path.open("r", encoding="utf-8") as f:
        doc = yaml.safe_load(f)
    raw_factors = doc.get("factors", [])
    category = path.stem  # technical.yaml → technical

    out = []
    for idx, f in enumerate(raw_factors):
        if not isinstance(f, dict):
            raise ValueError(f"{path.name} factor #{idx}: must be a mapping, got {type(f)}")
        if "id" not in f or "formula" not in f:
            raise ValueError(f"{path.name} factor #{idx}: missing required id/formula")

        # 解析公式 → 推断
        try:
            parsed = parse_formula(f["formula"])
        except (DSLError, UnknownFunctionError) as e:
            raise ValueError(
                f"{path.name} {f['id']}: formula parse failed: {e.code} @pos={e.pos} {e.message}"
            ) from e

        record = {
            "id": f["id"],
            "name": f["name"],
            "name_en": f.get("name_en"),
            "description": f.get("description", ""),
            "long_description": f.get("long_description"),
            "category": f.get("category", category),
            "tags": f.get("tags", []),
            "formula": f["formula"],
            "formula_type": f.get("formula_type", "dsl"),
            "output_type": f.get("output_type") or parsed.output_type,
            "output_range": f.get("output_range"),
            "lookback_days": f.get("lookback_days") or parsed.lookback_days,
            "update_frequency": f.get("update_frequency", "daily"),
            "version": f.get("version", 1),
            "owner": "platform",
            "visibility": "public",
        }
        out.append(record)

    return out


def load_all_builtins() -> list[dict[str, Any]]:
    """扫描 builtin/ 下所有 *.yaml 并合并"""
    if not BUILTIN_DIR.exists():
        return []
    all_factors: list[dict[str, Any]] = []
    for path in sorted(BUILTIN_DIR.glob("*.yaml")):
        all_factors.extend(load_builtin_file(path))
    return all_factors


def check_no_duplicate_ids(factors: list[dict[str, Any]]) -> None:
    """因子 id 必须唯一"""
    seen: dict[str, int] = {}
    for f in factors:
        seen[f["id"]] = seen.get(f["id"], 0) + 1
    dups = {k: v for k, v in seen.items() if v > 1}
    if dups:
        raise ValueError(f"Duplicate factor ids: {dups}")


def validate_with_engine(factors: list[dict[str, Any]], panel: dict) -> list[tuple[str, str]]:
    """逐一对真实面板跑 engine，返回失败列表 [(id, error_msg), ...]"""
    failures: list[tuple[str, str]] = []
    for f in factors:
        try:
            parsed = parse_formula(f["formula"])
            eval_ast(parsed.ast, panel)
        except EngineError as e:
            failures.append((f["id"], f"engine: {e.message}"))
        except Exception as e:  # noqa: BLE001
            failures.append((f["id"], f"{e.__class__.__name__}: {e}"))
    return failures
