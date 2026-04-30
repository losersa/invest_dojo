"""因子 DSL 解析器（T-3.01）。

设计：
1. **Tokenizer**：字符流 → Token 流（带 position）
2. **Pratt Parser**（top-down operator precedence）：比递归下降更好处理优先级
3. **语义校验**：函数名必须已注册，参数个数必须匹配，字段名必须是内置
4. **lookback 推断**：遍历 AST，从 MA/EMA/... 的窗口参数里取 max

为什么用 Pratt 而不是 PEG/ANTLR：
- 表达式语言足够简单（函数+运算符+字面量）
- 没有生成工具依赖，纯 Python
- 好出错定位（每个 token 带 pos）
- 容易扩展（加新运算符只改 OPERATORS 表）

错误语义：
- 词法错（非法字符）→ INVALID_FORMULA + position
- 语法错（括号不配、缺参数）→ INVALID_FORMULA + position + hint
- 未知函数 → UNKNOWN_FUNCTION + function_name
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from .ast_nodes import BinOp, BoolLit, Call, FieldRef, Node, NumberLit, UnaryOp
from .registry import (
    OPERATORS,
    is_builtin_field,
    known_functions,
    lookup_function,
)

# ═══════════════════════════════════════════════════════════════
#   异常
# ═══════════════════════════════════════════════════════════════


class DSLError(Exception):
    """DSL 解析/校验错误基类"""

    code: str = "INVALID_FORMULA"

    def __init__(self, message: str, pos: int = 0, hint: str = "", **extra: Any) -> None:
        super().__init__(message)
        self.message = message
        self.pos = pos
        self.hint = hint
        self.extra = extra

    def to_detail(self) -> dict[str, Any]:
        d: dict[str, Any] = {"position": self.pos}
        if self.hint:
            d["hint"] = self.hint
        d.update(self.extra)
        return d


class UnknownFunctionError(DSLError):
    code = "UNKNOWN_FUNCTION"


# ═══════════════════════════════════════════════════════════════
#   Token
# ═══════════════════════════════════════════════════════════════


@dataclass
class Token:
    kind: str  # NUM / IDENT / OP / LPAREN / RPAREN / COMMA / EOF / KW
    value: str
    pos: int


# Token 规则（顺序重要：长匹配优先）
# 注意 ">= <= == != > < + - * / ( ) ," 的顺序
_TOKEN_RE = re.compile(
    r"""
    (?P<WS>\s+)
  | (?P<NUM>\d+\.\d+|\d+)
  | (?P<OP_MULTI>>=|<=|==|!=)
  | (?P<OP_SINGLE>[+\-*/<>])
  | (?P<LPAREN>\()
  | (?P<RPAREN>\))
  | (?P<COMMA>,)
  | (?P<IDENT>[A-Za-z_][A-Za-z0-9_]*)
  | (?P<BAD>.)
    """,
    re.VERBOSE,
)


# 关键字（从 IDENT 升级）
_KEYWORDS = {"AND", "OR", "NOT", "true", "false", "True", "False"}


def tokenize(src: str) -> list[Token]:
    tokens: list[Token] = []
    for m in _TOKEN_RE.finditer(src):
        kind = m.lastgroup
        value = m.group()
        pos = m.start()
        if kind == "WS":
            continue
        if kind == "BAD":
            raise DSLError(
                f"Unexpected character {value!r}",
                pos=pos,
                hint=f"字符 {value!r} 不属于 DSL 合法字符集",
            )
        if kind == "IDENT" and value in _KEYWORDS:
            tokens.append(Token("KW", value, pos))
        elif kind in ("OP_MULTI", "OP_SINGLE"):
            tokens.append(Token("OP", value, pos))
        elif kind == "NUM":
            tokens.append(Token("NUM", value, pos))
        else:
            tokens.append(Token(kind or "?", value, pos))
    tokens.append(Token("EOF", "", len(src)))
    return tokens


# ═══════════════════════════════════════════════════════════════
#   Parser（Pratt）
# ═══════════════════════════════════════════════════════════════


class Parser:
    def __init__(self, src: str) -> None:
        self.src = src
        self.tokens = tokenize(src)
        self.idx = 0

    # ── 基础操作 ──
    @property
    def cur(self) -> Token:
        return self.tokens[self.idx]

    def _advance(self) -> Token:
        tok = self.tokens[self.idx]
        self.idx += 1
        return tok

    def _expect(self, kind: str, value: str | None = None) -> Token:
        tok = self.cur
        if tok.kind != kind or (value is not None and tok.value != value):
            expected = f"{kind}" + (f" {value!r}" if value else "")
            raise DSLError(
                f"Expected {expected}, got {tok.kind} {tok.value!r}",
                pos=tok.pos,
                hint=f"期望 {expected}",
            )
        return self._advance()

    # ── 入口 ──
    def parse(self) -> Node:
        node = self._parse_expr(0)
        if self.cur.kind != "EOF":
            raise DSLError(
                f"Unexpected token {self.cur.value!r} after expression",
                pos=self.cur.pos,
                hint="表达式解析完毕后仍有多余 token，检查括号或运算符",
            )
        return node

    # ── Pratt 核心：按优先级折叠 ──
    def _parse_expr(self, min_prec: int) -> Node:
        left = self._parse_prefix()
        while True:
            op_info = self._peek_binop()
            if op_info is None:
                break
            op_name, prec = op_info
            if prec < min_prec:
                break
            op_tok = self._advance()  # 吃掉运算符
            # 所有中缀都左结合，所以右边用 prec+1
            right = self._parse_expr(prec + 1)
            left = BinOp(op=op_name, left=left, right=right, pos=op_tok.pos)
        return left

    def _peek_binop(self) -> tuple[str, int] | None:
        """窥视当前 token 是否为二元运算符；返回 (op_name, precedence)"""

        tok = self.cur
        # 符号运算符
        if tok.kind == "OP" and tok.value in OPERATORS:
            return tok.value, OPERATORS[tok.value][0]
        # 关键字运算符 AND/OR
        if tok.kind == "KW" and tok.value in OPERATORS:
            return tok.value, OPERATORS[tok.value][0]
        # 中缀形式的 cross_up / cross_down（`a cross_up b`）
        if tok.kind == "IDENT" and tok.value in OPERATORS:
            # 但要排除 `cross_up(a,b)` 这种函数调用 —— 看下一个 token 是不是 (
            next_tok = self.tokens[self.idx + 1] if self.idx + 1 < len(self.tokens) else None
            if next_tok is None or next_tok.kind != "LPAREN":
                return tok.value, OPERATORS[tok.value][0]
        return None

    # ── 前缀：字面量 / 字段 / 函数 / 括号 / 一元 ──
    def _parse_prefix(self) -> Node:
        tok = self.cur
        # 一元：- 或 NOT
        if tok.kind == "OP" and tok.value == "-":
            self._advance()
            operand = self._parse_expr(100)  # 一元最高优先级
            return UnaryOp(op="-", operand=operand, pos=tok.pos)
        if tok.kind == "KW" and tok.value == "NOT":
            self._advance()
            operand = self._parse_expr(100)
            return UnaryOp(op="NOT", operand=operand, pos=tok.pos)

        # 数字
        if tok.kind == "NUM":
            self._advance()
            return NumberLit(value=float(tok.value), pos=tok.pos)

        # 布尔字面量
        if tok.kind == "KW" and tok.value in ("true", "True", "false", "False"):
            self._advance()
            return BoolLit(value=tok.value.lower() == "true", pos=tok.pos)

        # 括号
        if tok.kind == "LPAREN":
            self._advance()
            node = self._parse_expr(0)
            self._expect("RPAREN")
            return node

        # 标识符：字段 or 函数调用
        if tok.kind == "IDENT":
            name_tok = self._advance()
            # 后跟 `(`  → 函数调用
            if self.cur.kind == "LPAREN":
                return self._parse_call(name_tok)
            # 否则 → 字段引用
            return FieldRef(name=name_tok.value, pos=name_tok.pos)

        raise DSLError(
            f"Unexpected token {tok.value!r}",
            pos=tok.pos,
            hint=f"无法作为表达式开头的 {tok.kind}",
        )

    def _parse_call(self, name_tok: Token) -> Call:
        self._expect("LPAREN")
        args: list[Node] = []
        if self.cur.kind != "RPAREN":
            args.append(self._parse_expr(0))
            while self.cur.kind == "COMMA":
                self._advance()
                args.append(self._parse_expr(0))
        self._expect("RPAREN")
        return Call(name=name_tok.value, args=args, pos=name_tok.pos)


# ═══════════════════════════════════════════════════════════════
#   语义校验（函数存在性、参数个数、字段合法性）
# ═══════════════════════════════════════════════════════════════


def validate(node: Node) -> None:
    """递归校验 AST：未知函数 / 参数数量不匹配 / 未知字段 → 抛错"""

    if node.type == "field":
        if not is_builtin_field(node.name):
            raise DSLError(
                f"Unknown field {node.name!r}",
                pos=node.pos,
                hint=f"已知字段: {', '.join(sorted(['close', 'open', 'high', 'low', 'volume']))} ...",
            )
        return

    if node.type == "call":
        spec = lookup_function(node.name)
        if spec is None:
            raise UnknownFunctionError(
                f"Unknown function {node.name!r}",
                pos=node.pos,
                hint=f"已知函数: {', '.join(known_functions())}",
                function_name=node.name,
            )
        arity_min, arity_max = spec.arity
        n = len(node.args)
        if n < arity_min or n > arity_max:
            if arity_min == arity_max:
                expected = str(arity_min)
            else:
                expected = f"{arity_min}-{arity_max}"
            raise DSLError(
                f"Function {node.name!r} expects {expected} args, got {n}",
                pos=node.pos,
                hint=f"{node.name} 参数个数：{expected}",
            )
        for a in node.args:
            validate(a)
        return

    if node.type == "binop":
        validate(node.left)
        validate(node.right)
        return

    if node.type == "unary":
        validate(node.operand)
        return

    # number / bool：无需校验
    return


# ═══════════════════════════════════════════════════════════════
#   推断：lookback_days / output_type
# ═══════════════════════════════════════════════════════════════


def infer_lookback(node: Node) -> int:
    """遍历 AST，推断因子需要多少天历史数据。

    规则：
    - MA/EMA/STD/MAX/MIN/DIFF/PCT/... 按 registry.lookback_from_arg 读取窗口字面量
    - cross_up/cross_down 至少需要 2 天（比较前后两天）
    - 结果 = max(所有子表达式的 lookback)
    """

    if node.type == "call":
        spec = lookup_function(node.name)
        sub_max = max((infer_lookback(a) for a in node.args), default=0)
        own = spec.default_lookback if spec else 0
        if spec and spec.lookback_from_arg is not None and spec.lookback_from_arg < len(node.args):
            arg = node.args[spec.lookback_from_arg]
            if arg.type == "number":
                own = max(own, int(arg.value))
        return max(own, sub_max)

    if node.type == "binop":
        own = 0
        if node.op in ("cross_up", "cross_down"):
            own = 2
        return max(own, infer_lookback(node.left), infer_lookback(node.right))

    if node.type == "unary":
        return infer_lookback(node.operand)

    return 0


def infer_output_type(node: Node) -> str:
    """推断输出类型：boolean / scalar

    规则：
    - 比较 / 逻辑运算 → boolean
    - 算术 / 函数数值 → scalar
    - 少数函数（cross_up 等）→ boolean
    """

    if node.type == "bool":
        return "boolean"
    if node.type == "number" or node.type == "field":
        return "scalar"
    if node.type == "call":
        spec = lookup_function(node.name)
        return spec.output_type if spec else "scalar"
    if node.type == "binop":
        # OPERATORS 表里写了 output_type
        info = OPERATORS.get(node.op)
        if info:
            return info[1]
        return "scalar"
    if node.type == "unary":
        return "boolean" if node.op == "NOT" else "scalar"
    return "scalar"


# ═══════════════════════════════════════════════════════════════
#   统一入口（供 API 层调用）
# ═══════════════════════════════════════════════════════════════


@dataclass
class ParseResult:
    ast: Node
    output_type: str
    lookback_days: int


def parse_formula(src: str) -> ParseResult:
    """解析 + 校验 + 推断，一条龙

    成功：返回 ParseResult
    失败：抛 DSLError / UnknownFunctionError
    """

    if not src or not src.strip():
        raise DSLError("Formula is empty", pos=0, hint="DSL 不能为空")
    parser = Parser(src)
    node = parser.parse()
    validate(node)
    return ParseResult(
        ast=node,
        output_type=infer_output_type(node),
        lookback_days=infer_lookback(node),
    )
