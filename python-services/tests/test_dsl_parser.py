"""因子 DSL 解析器单元测试（T-3.01）

覆盖：
- 词法：数字、标识符、运算符、括号、关键字
- 语法：函数调用、嵌套、运算符优先级、一元运算、中缀 cross_up
- 语义：未知函数、未知字段、参数个数
- 推断：lookback_days / output_type
- 错误：INVALID_FORMULA / UNKNOWN_FUNCTION + position
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

SVC_DIR = Path(__file__).parent.parent / "feature-svc"


def _load_module(path: Path, name: str):
    if name in sys.modules:
        del sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# 加载 factors 包
# 由于 factors/__init__.py 内部用相对 import，需要先加载子模块到 sys.modules
def _load_factors():
    """把 factors 包加载到 sys.modules，让 from factors import ... 能工作"""
    factors_dir = SVC_DIR / "factors"

    # 先清理可能的缓存
    for key in list(sys.modules.keys()):
        if key.startswith("factors") or key == "factors":
            del sys.modules[key]

    # 作为包加载
    spec = importlib.util.spec_from_file_location(
        "factors",
        factors_dir / "__init__.py",
        submodule_search_locations=[str(factors_dir)],
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules["factors"] = mod
    spec.loader.exec_module(mod)
    return mod


_factors = _load_factors()
parse_formula = _factors.parse_formula
DSLError = _factors.DSLError
UnknownFunctionError = _factors.UnknownFunctionError
dump_ast = _factors.dump_ast
lookup_function = _factors.lookup_function


# ═══════════════════════════════════════════════════════════════
#   合法表达式：能解析
# ═══════════════════════════════════════════════════════════════


class TestValidFormulas:
    """合法 DSL 表达式必须能成功解析"""

    @pytest.mark.parametrize(
        "formula",
        [
            "MA(close, 20)",
            "EMA(close, 10)",
            "STD(close, 30)",
            "MAX(high, 20)",
            "MIN(low, 20)",
            "DIFF(close, 1)",
            "PCT(close, 5)",
            "RSI(14)",
            "MACD()",
            "BOLL(close, 20)",
            "RANK(close)",
            "cross_up(MA(close,5), MA(close,20))",
            "cross_down(MA(close,5), MA(close,20))",
        ],
    )
    def test_single_function_call(self, formula: str):
        r = parse_formula(formula)
        assert r.ast.type == "call"

    @pytest.mark.parametrize(
        "formula",
        [
            "MA(close, 20) cross_up MA(close, 60)",
            "volume > MA(volume, 20) * 1.5",
            "close > open AND volume > MA(volume, 20)",
            "RSI(14) < 30 OR RSI(14) > 70",
            "(close + open) / 2",
            "NOT (close > open)",
            "-close",
            "close > 10 AND close < 20",
            "RANK(PCT(close, 20)) > 0.8",
            "MAX(high, 20) - MIN(low, 20)",
        ],
    )
    def test_compound_expression(self, formula: str):
        r = parse_formula(formula)
        assert r.ast is not None


# ═══════════════════════════════════════════════════════════════
#   非法表达式：必须抛特定错误码
# ═══════════════════════════════════════════════════════════════


class TestInvalidFormulas:
    @pytest.mark.parametrize(
        "formula, expected_pos",
        [
            ("MA(close, 20", 12),  # 缺 )
            ("MA close, 20)", 3),  # 缺 (（after name）
            ("MA()", 0),  # 参数不够（MA 需要 2 个）
            ("MA(close)", 0),  # 参数不够
            ("MA(close, 20, 30)", 0),  # 参数太多
            ("close @ 100", 6),  # 非法字符
            ("", 0),  # 空
            ("   ", 0),  # 全空白
        ],
    )
    def test_invalid_formula_raises(self, formula: str, expected_pos: int):
        with pytest.raises(DSLError) as exc_info:
            parse_formula(formula)
        assert exc_info.value.code == "INVALID_FORMULA"
        assert exc_info.value.pos == expected_pos

    @pytest.mark.parametrize(
        "formula, fn_name",
        [
            ("UNKNOWN_FN(close, 20)", "UNKNOWN_FN"),
            ("FakeFunc(close)", "FakeFunc"),
            ("SIGMA(close, 10)", "SIGMA"),
        ],
    )
    def test_unknown_function(self, formula: str, fn_name: str):
        with pytest.raises(UnknownFunctionError) as exc_info:
            parse_formula(formula)
        assert exc_info.value.code == "UNKNOWN_FUNCTION"
        assert exc_info.value.extra.get("function_name") == fn_name

    def test_unknown_field(self):
        """字段名必须是内置字段"""
        with pytest.raises(DSLError) as exc_info:
            parse_formula("unknown_field > 10")
        assert exc_info.value.code == "INVALID_FORMULA"

    def test_error_detail_has_position_and_hint(self):
        """错误 detail 必须带 position 和 hint（API §8.3 约定）"""
        with pytest.raises(DSLError) as exc_info:
            parse_formula("MA(close, 20")
        detail = exc_info.value.to_detail()
        assert "position" in detail
        assert "hint" in detail
        assert isinstance(detail["position"], int)


# ═══════════════════════════════════════════════════════════════
#   lookback_days 推断
# ═══════════════════════════════════════════════════════════════


class TestLookbackInference:
    @pytest.mark.parametrize(
        "formula, expected",
        [
            ("MA(close, 20)", 20),
            ("MA(close, 60)", 60),
            ("EMA(close, 10)", 10),
            ("STD(close, 30)", 30),
            ("MA(close, 20) cross_up MA(close, 60)", 60),  # 取 max
            ("MA(close, 5) + MA(close, 10)", 10),  # 取 max
            ("RSI(14)", 14),
            ("BOLL(close, 25)", 25),
            ("MACD()", 26),  # default_lookback
            ("close > 10", 0),  # 纯字段无窗口
            ("volume > MA(volume, 20) * 1.5 AND close > MAX(high, 50)", 50),
        ],
    )
    def test_lookback(self, formula: str, expected: int):
        r = parse_formula(formula)
        assert r.lookback_days == expected


# ═══════════════════════════════════════════════════════════════
#   output_type 推断
# ═══════════════════════════════════════════════════════════════


class TestOutputTypeInference:
    @pytest.mark.parametrize(
        "formula, expected",
        [
            ("MA(close, 20)", "scalar"),
            ("MA(close, 20) cross_up MA(close, 60)", "boolean"),
            ("close > open", "boolean"),
            ("close < 10", "boolean"),
            ("close >= open", "boolean"),
            ("close == open", "boolean"),
            ("RSI(14)", "scalar"),
            ("RSI(14) < 30", "boolean"),
            ("close + open", "scalar"),
            ("close * 2", "scalar"),
            ("NOT (close > open)", "boolean"),
            ("-close", "scalar"),
            ("close > open AND volume > 0", "boolean"),
            ("RSI(14) < 30 OR RSI(14) > 70", "boolean"),
            ("cross_up(MA(close,5), MA(close,20))", "boolean"),
        ],
    )
    def test_output_type(self, formula: str, expected: str):
        r = parse_formula(formula)
        assert r.output_type == expected


# ═══════════════════════════════════════════════════════════════
#   运算符优先级（Pratt 解析是否正确）
# ═══════════════════════════════════════════════════════════════


class TestOperatorPrecedence:
    def test_mul_before_add(self):
        """2 + 3 * 4  →  2 + (3 * 4)"""
        r = parse_formula("close + open * 2")
        assert r.ast.type == "binop"
        assert r.ast.op == "+"  # 顶层是 +
        assert r.ast.right.type == "binop"
        assert r.ast.right.op == "*"  # 右子树是 *

    def test_comparison_before_and(self):
        """a > b AND c > d  →  (a > b) AND (c > d)"""
        r = parse_formula("close > open AND volume > 0")
        assert r.ast.type == "binop"
        assert r.ast.op == "AND"
        assert r.ast.left.type == "binop" and r.ast.left.op == ">"
        assert r.ast.right.type == "binop" and r.ast.right.op == ">"

    def test_and_before_or(self):
        """a AND b OR c  →  (a AND b) OR c"""
        r = parse_formula("close > 10 AND close < 20 OR close == 15")
        assert r.ast.op == "OR"
        assert r.ast.left.op == "AND"

    def test_paren_overrides_precedence(self):
        """(a + b) * c  →  顶层 *"""
        r = parse_formula("(close + open) * 2")
        assert r.ast.op == "*"

    def test_unary_minus(self):
        r = parse_formula("-close")
        assert r.ast.type == "unary" and r.ast.op == "-"

    def test_unary_not(self):
        r = parse_formula("NOT (close > open)")
        assert r.ast.type == "unary" and r.ast.op == "NOT"


# ═══════════════════════════════════════════════════════════════
#   AST 结构：序列化给前端可视化用
# ═══════════════════════════════════════════════════════════════


class TestAstSerialization:
    def test_dump_ast_returns_dict(self):
        r = parse_formula("MA(close, 20)")
        d = dump_ast(r.ast)
        assert isinstance(d, dict)
        assert d["type"] == "call"
        assert d["name"] == "MA"
        assert len(d["args"]) == 2
        assert d["args"][0]["type"] == "field"
        assert d["args"][0]["name"] == "close"
        assert d["args"][1]["type"] == "number"
        assert d["args"][1]["value"] == 20.0

    def test_dump_ast_nested_call(self):
        r = parse_formula("RANK(PCT(close, 20))")
        d = dump_ast(r.ast)
        assert d["name"] == "RANK"
        assert d["args"][0]["name"] == "PCT"

    def test_dump_ast_position_preserved(self):
        """AST 里应该保留位置信息，给前端高亮用"""
        r = parse_formula("MA(close, 20) cross_up MA(close, 60)")
        d = dump_ast(r.ast)
        assert "pos" in d
        # cross_up 在位置 14
        assert d["pos"] == 14


# ═══════════════════════════════════════════════════════════════
#   Registry 一致性
# ═══════════════════════════════════════════════════════════════


class TestRegistry:
    def test_known_functions_nonempty(self):
        # 确保 MA 能解析 + 能从 registry 查到
        parse_formula("MA(close, 20)")
        assert lookup_function("MA") is not None

    def test_function_arity_check(self):
        spec = lookup_function("RSI")
        assert spec is not None
        assert spec.arity == (1, 1)
        assert spec.output_type == "scalar"
