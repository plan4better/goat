"""The checker of a layer filter: shape, limits and, with a `DataContext`, fields.

A filter is checked as `normalize` rewrites it, so the legacy and the standard
spelling of a condition get the same issues; normalize keeps every condition in
its place, so the issue paths point into the filter as it was given. Every walk
is iterative.

What the services cannot evaluate is `operator_unsupported` (array operators,
`accenti`, functions off `cql.FUNCTIONS` or in the standard `op` spelling the
parser does not read, the temporal operators the evaluator reads as equality);
the other forms they evaluate today (spatial and arithmetic operators, the
functions of `cql.FUNCTIONS`, `t_before`, `t_after`, `t_equals`, any `like`
pattern) are accepted, so no saved filter becomes invalid.

`over_request_limits` holds a filter against the request ceilings instead of
the save limits: what the services take in one request at most
(`over_request_limits_text` for a filter that came as CQL2 text). An area whose
outline crosses itself too often (`goatlib.filter.area`) is over both: its
cost does not depend on who sends it.
"""

import json
import math
from typing import Any

from goatlib.filter import cql
from goatlib.filter.issues import DAMAGE_CODES, LIMIT_CODES, make_issue
from goatlib.filter.limits import (
    MAX_CONDITIONS,
    MAX_DEPTH,
    MAX_LENGTH,
    MAX_POINTS,
    MAX_SHAPES,
    MAX_VALUES,
    REQUEST_MAX_CONDITIONS,
    REQUEST_MAX_DEPTH,
    REQUEST_MAX_POINTS,
    REQUEST_MAX_SHAPES,
    REQUEST_MAX_VALUES,
    parts,
    url_length,
)
from goatlib.filter.normalize import normalize
from goatlib.style.context import DataContext, FieldInfo
from goatlib.style.issues import Issue

NUMERIC = ("number", "integer")
ORDERED = NUMERIC + ("date", "datetime")
DATES = ("date", "datetime")


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _is_property(v: Any) -> bool:
    return isinstance(v, dict) and set(v) == {"property"}


def _is_timestamp(v: Any) -> bool:
    return isinstance(v, dict) and len(v) == 1 and isinstance(v.get("timestamp"), str)


def _is_literal(v: Any) -> bool:
    """A value a condition compares with: text, a number, true or false, or a timestamp."""
    return isinstance(v, (str, int, float, bool)) or _is_timestamp(v)


def _numeric_text(v: str) -> bool:
    try:
        return math.isfinite(float(v))
    except ValueError:
        return False


def _fits(field_type: str, v: Any) -> bool:
    if field_type == "string":
        return isinstance(v, str)
    if field_type in NUMERIC:
        # DuckDB casts a text that is a number to the column's type.
        return _num(v) or (isinstance(v, str) and _numeric_text(v))
    if field_type == "boolean":
        return isinstance(v, bool)
    return isinstance(v, str) or _is_timestamp(v)


def _is_function(v: Any) -> bool:
    return isinstance(v, dict) and "function" in v


def _is_arithmetic(v: Any) -> bool:
    return isinstance(v, dict) and v.get("op") in cql.ARITHMETIC


def _null_property(node: Any) -> str | None:
    """The field of an `isNull` condition in the evaluator's form."""
    if isinstance(node, dict) and node.get("op") == "isNull":
        args = node.get("args")
        if isinstance(args, list) and len(args) == 1 and _is_property(args[0]):
            name = args[0]["property"]
            return name if isinstance(name, str) else None
    return None


class _Checker:
    def __init__(self, ctx: DataContext | None) -> None:
        self.fields = ctx.fields if ctx is not None else None
        self.lower = (
            {name.lower(): info for name, info in self.fields.items()}
            if self.fields is not None
            else {}
        )
        self.issues: list[Issue] = []

    def add(self, code: str, path: str, message: str) -> None:
        self.issues.append(make_issue(code, path, message))

    # fields -------------------------------------------------------------------------------------
    def field(self, name: Any, path: str) -> FieldInfo | None:
        """The field a property names; reports a field the layer does not have."""
        if not isinstance(name, str) or not name:
            self.add("malformed", path, "A property names a field.")
            return None
        if self.fields is None:
            return None
        # The evaluator matches column names regardless of case.
        info = self.fields.get(name) or self.lower.get(name.lower())
        if (
            info is None
            and name not in cql.GEOMETRY_PROPERTIES + cql.VIRTUAL_PROPERTIES
        ):
            self.add("unknown_field", path, f'The layer has no field "{name}".')
        return info

    def operand(self, value: Any, path: str) -> tuple[bool, FieldInfo | None]:
        """What a condition tests: a field, or arithmetic over fields. Returns
        whether it is one, and the field when it is a single known one."""
        if _is_property(value):
            return True, self.field(value["property"], path)
        if _is_arithmetic(value) or _is_function(value):
            return self.expression(value, path), None
        if isinstance(value, dict) and "op" in value:
            name = value["op"]
            self.add(
                "operator_unsupported",
                path,
                f'"{name}" cannot be used in a filter.',
            )
            return False, None
        self.add("malformed", path, "A condition tests a field.")
        return False, None

    def expression(self, root: dict[str, Any], path: str) -> bool:
        """Arithmetic and function calls over fields and values: their fields
        must exist, and they nest no deeper than a filter may (the parser
        recurses). Arithmetic takes numbers; a function also takes text, true or
        false and timestamps."""
        # (node, level, an argument of a function)
        stack: list[tuple[Any, int, bool]] = [(root, 1, False)]
        while stack:
            node, level, argument = stack.pop()
            if level > MAX_DEPTH:
                self.add(
                    "too_deep",
                    path,
                    f"Arithmetic and functions nest at most {MAX_DEPTH} levels.",
                )
                return False
            if _num(node) or (argument and _is_literal(node)):
                continue
            if _is_property(node):
                self.field(node["property"], path)
                continue
            if (
                _is_arithmetic(node)
                and isinstance(node.get("args"), list)
                and len(node["args"]) == 2
            ):
                stack.extend((arg, level + 1, False) for arg in node["args"])
                continue
            if _is_function(node):
                arguments = self.function(node, path)
                if arguments is None:
                    return False
                stack.extend((arg, level + 1, True) for arg in arguments)
                continue
            if isinstance(node, dict) and "op" in node:
                self.add(
                    "operator_unsupported",
                    path,
                    f'"{node["op"]}" cannot be used in a filter.',
                )
            elif argument:
                self.add(
                    "malformed",
                    path,
                    "A function takes fields, values, arithmetic and functions.",
                )
            else:
                self.add(
                    "malformed",
                    path,
                    "Arithmetic takes fields, numbers and arithmetic.",
                )
            return False
        return True

    def function(self, node: dict[str, Any], path: str) -> list[Any] | None:
        """The arguments of a call the services run, in the parser's spelling
        `{"function": {"name": ..., "arguments": [...]}}`; None after reporting
        any other call."""
        call = node["function"]
        if (
            set(node) != {"function"}
            or not isinstance(call, dict)
            or not isinstance(call.get("name"), str)
            or not isinstance(call.get("arguments"), list)
            or not call["arguments"]
        ):
            self.add(
                "malformed",
                path,
                'A function call is {"function": {"name": ..., "arguments": [...]}} '
                "with one or more arguments.",
            )
            return None
        if call["name"].strip().lower() not in cql.FUNCTIONS:
            self.add(
                "operator_unsupported",
                path,
                f'"{call["name"]}" cannot be used in a filter.',
            )
            return None
        return call["arguments"]

    def value(self, v: Any, path: str) -> bool:
        """A literal, another field or arithmetic: whether it is one."""
        if _is_literal(v):
            return True
        if _is_property(v) or _is_arithmetic(v) or _is_function(v):
            return self.operand(v, path)[0]
        self.add(
            "malformed",
            path,
            "A condition compares with a text, a number, true or false or a date.",
        )
        return False

    # conditions ---------------------------------------------------------------------------------
    def run(self, root: Any) -> list[Issue]:
        # (node, path, fields with an empty alternative around it, inside a `not`)
        stack: list[tuple[Any, str, frozenset[str], bool]] = [
            (root, "", frozenset(), False)
        ]
        while stack:
            node, path, guarded, negated = stack.pop()
            if not isinstance(node, dict) or not isinstance(node.get("op"), str):
                self.add(
                    "malformed",
                    path,
                    "A condition is an object with an op and its args.",
                )
                continue
            op, args = node["op"], node.get("args")
            if op in ("and", "or"):
                if not isinstance(args, list) or not args:
                    self.add("malformed", path, f'"{op}" takes a list of conditions.')
                    continue
                if op == "or":
                    nulls = {_null_property(a) for a in args} - {None}
                    guarded = guarded | frozenset(n for n in nulls if n is not None)
                stack.extend(
                    (a, f"{path}/args/{i}", guarded, negated)
                    for i, a in reversed(list(enumerate(args)))
                )
                continue
            if op == "not":
                if isinstance(args, list) and len(args) == 1:
                    inner, inner_path = args[0], f"{path}/args/0"
                elif isinstance(args, dict):
                    inner, inner_path = args, f"{path}/args"
                else:
                    self.add("malformed", path, '"not" takes one condition.')
                    continue
                read = cql.fields_of(inner)
                # Outside an area: a feature without a geometry is nowhere on
                # the map, so there is nothing to keep.
                spatial = isinstance(inner, dict) and inner.get("op") in cql.SPATIAL
                if (
                    not negated
                    and not spatial
                    and _null_property(inner) is None
                    and read
                    and not read <= guarded
                ):
                    self.negation(path)
                stack.append((inner, inner_path, guarded, True))
                continue
            self.condition(node, path, guarded, negated)
        return self.issues

    def negation(self, path: str) -> None:
        self.add(
            "negation_drops_empty",
            path,
            "This negation leaves out the features without a value; "
            "add the empty value as an alternative to keep them.",
        )

    def condition(
        self, node: dict[str, Any], path: str, guarded: frozenset[str], negated: bool
    ) -> None:
        op, args = node["op"], node.get("args")
        if op in cql.ARITHMETIC:
            self.add("malformed", path, f'"{op}" is arithmetic, not a condition.')
            return
        if op not in cql.FILTER_OPS or op in cql.NO_OP_WRAPPERS:
            self.add(
                "operator_unsupported", path, f'"{op}" cannot be used in a filter.'
            )
            return
        if op == "isNull":
            if not isinstance(args, list) or len(args) != 1:
                self.add("malformed", path, '"isNull" takes the field it tests.')
            else:
                self.operand(args[0], path)
            return
        if not isinstance(args, list) or len(args) != 2:
            self.add("malformed", path, f'"{op}" takes a field and a value.')
            return
        if op in cql.SPATIAL:
            if not _is_property(args[0]) or not cql.is_geometry(args[1]):
                self.add(
                    "malformed",
                    path,
                    f'"{op}" takes the geometry field and a GeoJSON geometry.',
                )
            return
        is_operand, info = self.operand(args[0], path)
        if op == "in":
            values = args[1]
            if not isinstance(values, list) or not values:
                self.add("malformed", path, '"in" takes a list of values.')
                return
        elif op == "between":
            values = args[1]
            if not isinstance(values, list) or len(values) != 2:
                self.add(
                    "malformed",
                    path,
                    '"between" takes a field, a low and a high value.',
                )
                return
        elif op == "like":
            values = [args[1]]
            # Any pattern: the services evaluate it (ILIKE). Style rules allow
            # fewer, because the map client evaluates those.
            if not isinstance(args[1], str):
                self.add("malformed", path, '"like" takes a text pattern.')
                return
        else:
            values = [args[1]]
        if not all([self.value(v, path) for v in values]):
            return
        if (
            op == "<>"
            and not negated
            and _is_property(args[0])
            and args[0]["property"] not in guarded
            and args[1] != ""
        ):
            self.negation(path)
        if not is_operand or info is None:
            return
        self.types(op, info, [v for v in values if _is_literal(v)], path)

    def types(self, op: str, info: FieldInfo, values: list[Any], path: str) -> None:
        if (op in cql.ORDERING and info.type not in ORDERED) or (
            op in cql.TEMPORAL and info.type not in DATES
        ):
            self.add(
                "operator_type_mismatch",
                path,
                f'"{op}" compares numbers or dates; "{info.name}" is a {info.type} field.',
            )
            return
        if op == "like":
            if info.type != "string":
                self.add(
                    "operator_type_mismatch",
                    path,
                    f'"like" reads text; "{info.name}" is a {info.type} field.',
                )
            return
        wrong = [v for v in values if not _fits(info.type, v)]
        if wrong:
            self.add(
                "field_type_mismatch",
                path,
                f'"{info.name}" is a {info.type} field; '
                f"{', '.join(repr(v) for v in wrong[:5])} does not fit it.",
            )


def _limits(
    cql_filter: Any,
    max_conditions: int = MAX_CONDITIONS,
    max_values: int = MAX_VALUES,
    max_shapes: int = MAX_SHAPES,
    max_points: int = MAX_POINTS,
) -> list[Issue]:
    conditions, shapes = parts(cql_filter)
    issues = []
    if len(conditions) > max_conditions:
        issues.append(
            make_issue(
                "too_many_conditions",
                "",
                f"A filter takes at most {max_conditions} conditions; this one has {len(conditions)}.",
            )
        )
    for path, n in conditions:
        if n > max_values:
            issues.append(
                make_issue(
                    "too_many_values",
                    path,
                    f"A condition takes at most {max_values} values; this one has {n}.",
                )
            )
    if len(shapes) > max_shapes:
        issues.append(
            make_issue(
                "too_many_shapes",
                "",
                f"A filter takes at most {max_shapes} areas; this one has {len(shapes)}.",
            )
        )
    for path, n in shapes:
        if n > max_points:
            issues.append(
                make_issue(
                    "area_too_detailed",
                    path,
                    f"An area takes at most {max_points} points; this one has {n}.",
                )
            )
    if shapes and len(shapes) <= max_shapes:
        # Shapely is loaded for a filter with an area only. Within the limits
        # above the reading is bounded, so nothing larger is read.
        from goatlib.filter.area import CROSSES_ITSELF, crosses_itself

        for path, n in shapes:
            if n <= max_points and crosses_itself(_at(cql_filter, path)):
                issues.append(make_issue("area_crosses_itself", path, CROSSES_ITSELF))
    return issues


def _too_long(cql_filter: Any) -> list[Issue]:
    """A filter longer than a map request's URL takes. A save limit only: the
    services get the filter in the request, so a longer one does not get past
    a proxy that refuses the URL."""
    n = url_length(cql_filter)
    if n <= MAX_LENGTH:
        return []
    return [
        make_issue(
            "too_long",
            "",
            f"A filter sent with a map request takes at most {MAX_LENGTH} "
            f"characters; this one has {n}. Remove a piece of the area or some values.",
        )
    ]


def _at(node: Any, path: str) -> Any:
    """What a JSON pointer of `limits.parts` points at."""
    for segment in path.split("/")[1:]:
        key = segment.replace("~1", "/").replace("~0", "~")
        node = node[int(key)] if isinstance(node, list) else node[key]
    return node


def _too_deep(cql_filter: Any, max_depth: int) -> Issue | None:
    nesting = cql.depth(cql_filter)
    if nesting <= max_depth:
        return None
    return make_issue(
        "too_deep",
        "",
        f"A filter nests at most {max_depth} levels; this one nests {nesting}.",
    )


def _path_key(issue: Issue) -> tuple[tuple[tuple[int, Any], ...], str]:
    segments = issue.path.split("/")[1:] if issue.path else []
    return (
        tuple((0, int(s)) if s.isdigit() else (1, s) for s in segments),
        issue.code,
    )


def _tidy(issues: list[Issue], stored: bool) -> list[Issue]:
    if stored:
        issues = [
            i.model_copy(update={"level": "damaged"})
            if i.code in DAMAGE_CODES
            else i.model_copy(update={"level": "warning"})
            if i.code in LIMIT_CODES
            else i
            for i in issues
        ]
    seen: set[tuple[str, str]] = set()
    out = []
    for i in sorted(issues, key=_path_key):
        if (i.code, i.path) not in seen:
            seen.add((i.code, i.path))
            out.append(i)
    return out


def validate(
    cql_filter: Any, ctx: DataContext | None = None, *, stored: bool = False
) -> list[Issue]:
    """Every issue of a layer filter, in the order of their paths (positions in
    the filter, numbers compared as numbers), then by code.

    With `ctx` None only the shape and the limits are checked; with a context
    whose `fields` is None the fields are unknown and not checked either.
    `stored=True` reads a filter that was saved before: a field a later data
    change broke is `damaged` and a limit is a `warning`, so the filter still
    loads; a new save (`stored=False`) is refused on every error.
    """
    if not isinstance(cql_filter, dict):
        return [make_issue("malformed", "", "A filter is a CQL2-JSON object.")]
    deep = _too_deep(cql_filter, MAX_DEPTH)
    if deep is not None:
        # The other checks are skipped: nothing deeper is read.
        return _tidy([deep], stored)
    issues = (
        _limits(cql_filter)
        + _too_long(cql_filter)
        + _Checker(ctx).run(normalize(cql_filter))
    )
    return _tidy(issues, stored)


def _unwrapped(cql_filter: Any) -> Any:
    """The filter as the parser reads it: it takes `{"filter": x}` as `x` at
    any level (before reading anything else of the object). A new tree; the
    walk never recurses."""
    holder: list[Any] = [None]
    stack: list[tuple[Any, Any, Any]] = [(cql_filter, holder, 0)]
    while stack:
        node, parent, key = stack.pop()
        while isinstance(node, dict) and "filter" in node:
            node = node["filter"]
        if isinstance(node, dict):
            copy: dict[str, Any] = dict(node)
            parent[key] = copy
            stack.extend(
                (v, copy, k) for k, v in node.items() if isinstance(v, (dict, list))
            )
        elif isinstance(node, list):
            items = list(node)
            parent[key] = items
            stack.extend(
                (v, items, i) for i, v in enumerate(node) if isinstance(v, (dict, list))
            )
        else:
            parent[key] = node
    return holder[0]


def over_request_limits(cql_filter: Any) -> list[Issue]:
    """The request ceilings (`limits.REQUEST_MAX_*`) a filter is over, as errors.

    The services call this on every filter a request brings, before parsing it:
    the ceilings protect them, and lie well above the save limits, so a filter
    saved over a save limit still loads and filters. Only the size is read
    here, and of an area within the ceilings how its outline crosses itself;
    what is not a filter measures as nothing and is left to the parser.
    """
    cql_filter = _unwrapped(cql_filter)
    deep = _too_deep(cql_filter, REQUEST_MAX_DEPTH)
    if deep is not None:
        # Nothing deeper is read: the parser would recurse through it.
        return [deep]
    return sorted(
        _limits(
            cql_filter,
            REQUEST_MAX_CONDITIONS,
            REQUEST_MAX_VALUES,
            REQUEST_MAX_SHAPES,
            REQUEST_MAX_POINTS,
        ),
        key=_path_key,
    )


def over_request_limits_text(tree: Any) -> list[Issue]:
    """`over_request_limits` for a filter parsed from CQL2 text (the parser's tree).

    Text has to be parsed to be measured: it is held against the ceilings as
    the CQL2-JSON it stands for (`_joined`). What that form cannot express
    measures as nothing, as in `over_request_limits`.
    """
    from pygeofilter.backends.cql2_json import to_cql2

    try:
        measured = _joined(json.loads(to_cql2(tree)))
    except RecursionError:
        raise
    except Exception:
        measured = None
    return over_request_limits(measured)


def _joined(root: Any) -> Any:
    """A CQL2-JSON tree with each `and` in an `and` (and `or` in an `or`)
    joined into one, in place.

    CQL2 text reads `a AND b AND c` as pairs in pairs. Joined, it measures as
    the one `and` its JSON form is.
    """
    stack = [root]
    while stack:
        node = stack.pop()
        if isinstance(node, list):
            stack.extend(node)
            continue
        if not isinstance(node, dict):
            continue
        op, args = node.get("op"), node.get("args")
        if op not in ("and", "or") or not isinstance(args, list):
            stack.extend(v for v in node.values() if isinstance(v, (dict, list)))
            continue
        joined, pending = [], args[::-1]
        while pending:
            arg = pending.pop()
            if (
                isinstance(arg, dict)
                and arg.get("op") == op
                and isinstance(arg.get("args"), list)
            ):
                pending.extend(arg["args"][::-1])
            else:
                joined.append(arg)
        node["args"] = joined
        stack.extend(joined)
    return root
