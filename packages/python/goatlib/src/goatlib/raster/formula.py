"""Band formulas (the style specification's section 9.3).

The grammar: `b1`, `b2`, ... (a band, from 1), numbers, `+ - * /`, brackets and
unary minus. An expression is parsed into a small tree and evaluated with numpy
in float32; nothing is ever passed to `eval`. Division by zero and invalid
values become NaN, which the coloring treats as no data.
"""

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Union

if TYPE_CHECKING:
    import numpy as np

#: Long or deeply nested expressions are refused before they cost anything.
MAX_LENGTH = 500
MAX_DEPTH = 32

_TOKEN = re.compile(r"\s*(?:(b\d+)|(\d+(?:\.\d+)?)|([-+*/()]))")


class FormulaError(ValueError):
    """The expression is not a band formula."""


@dataclass(frozen=True)
class _Band:
    index: int


@dataclass(frozen=True)
class _Number:
    value: float


@dataclass(frozen=True)
class _Negate:
    operand: "_Node"


@dataclass(frozen=True)
class _Binary:
    op: str
    left: "_Node"
    right: "_Node"


_Node = Union[_Band, _Number, _Negate, _Binary]


def _tokens(expression: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    pos = 0
    while pos < len(expression):
        if expression[pos:].strip() == "":
            break
        m = _TOKEN.match(expression, pos)
        if not m:
            raise FormulaError(f"Unexpected text at position {pos + 1}.")
        band, number, op = m.groups()
        out.append(
            ("band", band) if band else ("number", number) if number else ("op", op)
        )
        pos = m.end()
    return out


class _Parser:
    def __init__(self, tokens: list[tuple[str, str]]) -> None:
        self.tokens = tokens
        self.pos = 0

    def peek(self) -> tuple[str, str] | None:
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def take(self) -> tuple[str, str]:
        token = self.peek()
        if token is None:
            raise FormulaError("The formula ends too early.")
        self.pos += 1
        return token

    def expression(self, depth: int) -> _Node:
        node = self.term(depth)
        while (t := self.peek()) is not None and t in (("op", "+"), ("op", "-")):
            self.pos += 1
            node = _Binary(t[1], node, self.term(depth))
        return node

    def term(self, depth: int) -> _Node:
        node = self.factor(depth)
        while (t := self.peek()) is not None and t in (("op", "*"), ("op", "/")):
            self.pos += 1
            node = _Binary(t[1], node, self.factor(depth))
        return node

    def factor(self, depth: int) -> _Node:
        if depth > MAX_DEPTH:
            raise FormulaError("The formula is nested too deeply.")
        kind, text = self.take()
        if kind == "band":
            index = int(text[1:])
            if index < 1:
                raise FormulaError("Bands are numbered from b1.")
            return _Band(index)
        if kind == "number":
            return _Number(float(text))
        if text == "-":
            return _Negate(self.factor(depth + 1))
        if text == "(":
            node = self.expression(depth + 1)
            if self.take() != ("op", ")"):
                raise FormulaError("A bracket is not closed.")
            return node
        raise FormulaError(f'Unexpected "{text}".')


def _band_indexes(node: _Node, found: set[int]) -> set[int]:
    if isinstance(node, _Band):
        found.add(node.index)
    elif isinstance(node, _Negate):
        _band_indexes(node.operand, found)
    elif isinstance(node, _Binary):
        _band_indexes(node.left, found)
        _band_indexes(node.right, found)
    return found


@dataclass(frozen=True)
class Formula:
    expression: str
    tree: _Node
    bands: tuple[int, ...]

    def evaluate(
        self, arrays: Mapping[int, "np.ndarray"], dtype: str = "float32"
    ) -> "np.ndarray":
        """The formula over band arrays of one shape (band index to values), in
        float32 (a single value reads better in float64); NaN where a value is
        undefined."""
        import numpy as np

        shape = next(iter(arrays.values())).shape

        def run(node: _Node) -> np.ndarray:
            if isinstance(node, _Band):
                return arrays[node.index].astype(dtype, copy=False)
            if isinstance(node, _Number):
                return np.full(shape, node.value, dtype=dtype)
            if isinstance(node, _Negate):
                return -run(node.operand)
            left, right = run(node.left), run(node.right)
            if node.op == "+":
                return left + right
            if node.op == "-":
                return left - right
            if node.op == "*":
                return left * right
            return left / right

        with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
            out = np.asarray(run(self.tree), dtype=dtype)
        out[~np.isfinite(out)] = np.nan
        return out


def parse_formula(expression: str, bands: int | None = None) -> Formula:
    """The formula `expression` describes; `bands` (the file's band count, when
    known) limits the bands it may use. Raises FormulaError."""
    if not isinstance(expression, str) or not expression.strip():
        raise FormulaError("The formula is empty.")
    if len(expression) > MAX_LENGTH:
        raise FormulaError(f"A formula has at most {MAX_LENGTH} characters.")
    parser = _Parser(_tokens(expression))
    tree = parser.expression(0)
    if parser.peek() is not None:
        raise FormulaError(f'Unexpected "{parser.peek()[1]}".')  # type: ignore[index]
    used = tuple(sorted(_band_indexes(tree, set())))
    if not used:
        raise FormulaError("A formula uses at least one band (b1, b2, ...).")
    if bands and any(i > bands for i in used):
        raise FormulaError(f"The raster has {bands} band{'s' if bands != 1 else ''}.")
    return Formula(expression, tree, used)
