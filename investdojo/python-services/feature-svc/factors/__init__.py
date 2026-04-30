"""factors 包：DSL 解析（T-3.01）→ 计算引擎（T-3.02）→ 内置因子（T-3.03）"""

from .ast_nodes import BinOp, BoolLit, Call, FieldRef, Node, NumberLit, UnaryOp, dump_ast
from .dsl_parser import DSLError, ParseResult, UnknownFunctionError, parse_formula
from .registry import (
    BUILTIN_FIELDS,
    OPERATORS,
    FunctionSpec,
    is_builtin_field,
    known_functions,
    lookup_function,
)

__all__ = [
    # AST
    "Node",
    "NumberLit",
    "BoolLit",
    "FieldRef",
    "Call",
    "BinOp",
    "UnaryOp",
    "dump_ast",
    # Parser
    "ParseResult",
    "parse_formula",
    "DSLError",
    "UnknownFunctionError",
    # Registry
    "BUILTIN_FIELDS",
    "OPERATORS",
    "FunctionSpec",
    "is_builtin_field",
    "lookup_function",
    "known_functions",
]
