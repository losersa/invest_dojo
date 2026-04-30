"""因子 DSL 的 AST 节点定义。

所有节点都是 Pydantic 模型，方便 JSON 序列化（给前端可视化 / DB 缓存）。
设计原则：结构简单、字段自解释、类型区分用 discriminator。
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

# ── 叶子节点 ────────────────────────────────────────────────────

class NumberLit(BaseModel):
    """数字字面量：1.5 / -3 / 0.8"""

    type: Literal["number"] = "number"
    value: float
    pos: int = Field(..., description="在原表达式中的起始 offset")


class BoolLit(BaseModel):
    """布尔字面量（DSL 里少见，但前端有时传）"""

    type: Literal["bool"] = "bool"
    value: bool
    pos: int


class FieldRef(BaseModel):
    """内置字段引用：close / high / volume / open / low / amount / preclose / pct_change / turnover"""

    type: Literal["field"] = "field"
    name: str
    pos: int


# ── 复合节点 ────────────────────────────────────────────────────

class Call(BaseModel):
    """函数调用：MA(close, 20) / RSI(14) / cross_up(a, b)"""

    type: Literal["call"] = "call"
    name: str
    args: list[Node]
    pos: int


class BinOp(BaseModel):
    """二元运算：a + b / a > b / a AND b / a cross_up b"""

    type: Literal["binop"] = "binop"
    op: str  # +, -, *, /, >, <, >=, <=, ==, !=, AND, OR, cross_up, cross_down
    left: Node
    right: Node
    pos: int


class UnaryOp(BaseModel):
    """一元运算：NOT x / -x"""

    type: Literal["unary"] = "unary"
    op: str  # NOT, -
    operand: Node
    pos: int


# Node = 所有节点的联合（Pydantic v2 discriminated union）
Node = NumberLit | BoolLit | FieldRef | Call | BinOp | UnaryOp


# 让 Call/BinOp/UnaryOp 的 forward ref 解析
Call.model_rebuild()
BinOp.model_rebuild()
UnaryOp.model_rebuild()


def dump_ast(node: Node) -> dict[str, Any]:
    """AST → dict（给 API 响应用的 parsed_ast 字段）"""

    return node.model_dump()
