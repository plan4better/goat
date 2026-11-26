"""The style contract: what a tool's default style holds for the result it styles.

`style_contract` checks a style document against a result (a DuckDB relation)
and its geometry and returns the problems it finds, each with its rule and
level:

- `error`, the hard rules: every field the style reads is a column of the
  result (`field_missing`), and the document validates against the result
  without an error (`invalid`: a part the geometry cannot draw, a palette
  shorter than the classes, a field of the wrong type, ...);
- `design`, what a tool's default is made to hold beyond that: no computed
  class list of one (`single_class`), the column the run wrote is the one
  classified (`field_expected`, where the caller names it), no class without a
  feature where the field has at least as many distinct values as classes
  (`empty_class`), a legend title on every classification (`title_missing`), a
  no-data color on every numeric one (`no_data_missing`), and the rest of the
  pinned shape the caller expects (`shape`: method, palette, direction,
  unit).

A run checks the hard rules only (`hard_problems`, from
`BaseToolRunner.computed_style`) and gives a tool style that breaks one the
default style of its geometry. The tool tests call `assert_tool_style` with a
result their analysis wrote: the hard rules, `single_class` and
`field_expected` fail the test (`FAILS_TOOL_TESTS`); the others depend on the
data more than on the tool's code and are reported as notes
(`StyleContractNote` warnings). With `strict`, every rule fails.
"""

import warnings
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

import duckdb

from goatlib.analysis.statistics.columns import quote_identifier
from goatlib.models.io import DatasetMetadata
from goatlib.style.data import describe
from goatlib.style.data_check import referenced_fields
from goatlib.style.models.classify import NUMERIC_METHODS
from goatlib.style.validate import validate
from goatlib.utils.column_types import column_types, type_class

if TYPE_CHECKING:
    from goatlib.tools.base import BaseToolRunner

Level = Literal["error", "design"]

#: The fingerprint and seed the style of a checked result is computed with.
_FINGERPRINT = "style-contract"
_SEED = "style-contract"


@dataclass(frozen=True)
class Problem:
    """A rule the style breaks for its result."""

    rule: str
    level: Level
    message: str
    #: The style check's issue codes behind it, where it has any.
    codes: tuple[str, ...] = ()


#: The rules that fail a tool test; the others are notes there.
FAILS_TOOL_TESTS = frozenset(
    {"field_missing", "invalid", "single_class", "field_expected"}
)


class StyleContractError(AssertionError):
    """A style breaks the contract for its result (`assert_style_contract`)."""


class StyleContractNote(UserWarning):
    """A rule a tool's style breaks for its result that does not fail a tool
    test (`FAILS_TOOL_TESTS`)."""


@dataclass(frozen=True)
class Expectation:
    """The shape a tool test pins for the tool's first classification; what is
    None is not compared."""

    #: The column the run wrote that the style classifies.
    field: str | None = None
    method: str | None = None
    palette: str | list[str] | None = None
    reverse: bool | None = None
    unit: str | None = None


def _classifications(document: dict[str, Any]) -> list[dict[str, Any]]:
    classify = document.get("classify")
    if not isinstance(classify, list):
        return []
    return [c for c in classify if isinstance(c, dict)]


def _numeric(c: dict[str, Any]) -> bool:
    return c.get("method") in NUMERIC_METHODS


def _missing_field(field: str, columns: dict[str, str]) -> Problem:
    shown = ", ".join(f'"{c}"' for c in list(columns)[:12])
    return Problem(
        "field_missing",
        "error",
        f'The style reads "{field}", which the result does not have '
        f"(its columns: {shown}).",
        ("unknown_field",),
    )


def _check_errors(
    document: dict[str, Any],
    con: duckdb.DuckDBPyConnection,
    relation: str,
    geometry: str | None,
    missing: set[str],
) -> list[Problem]:
    ctx = describe(
        con,
        relation,
        geometry=geometry,  # type: ignore[arg-type]
        fields_used=referenced_fields(document),
    )
    return [
        Problem("invalid", "error", f"{i.path}: {i.message}", (i.code,))
        for i in validate(document, ctx)
        if i.level == "error"
        and not (i.code == "unknown_field" and (i.params or {}).get("field") in missing)
    ]


def _distinct_at_least(
    con: duckdb.DuckDBPyConnection, relation: str, column: str, count: int
) -> bool:
    """Whether `column` holds at least `count` distinct values, counted only
    that far."""
    (values,) = con.execute(
        f"""SELECT count(*) FROM (
                SELECT DISTINCT {column} FROM {relation}
                WHERE {column} IS NOT NULL LIMIT {count})"""
    ).fetchone()
    return values >= count


def _classes_holding(
    con: duckdb.DuckDBPyConnection, relation: str, column: str, breaks: list[float]
) -> int:
    """How many of the classes `breaks` split the field into hold a feature:
    each class from its break (inclusive) to the next (exclusive)."""
    index = " + ".join(f"({column} >= ?)::INTEGER" for _ in breaks) or "0"
    (holding,) = con.execute(
        f"SELECT count(DISTINCT {index}) FROM {relation} WHERE {column} IS NOT NULL",
        breaks,
    ).fetchone()
    return holding


def _class_problems(
    c: dict[str, Any],
    con: duckdb.DuckDBPyConnection,
    relation: str,
    columns: dict[str, str],
) -> list[Problem]:
    classes = [k for k in (c.get("classes") or []) if isinstance(k, dict)]
    field = c.get("field")
    if not (_numeric(c) and classes and isinstance(field, str)):
        return []
    if len(classes) == 1:
        return [
            Problem(
                "single_class",
                "design",
                f'The classification of "{field}" has a single class.',
            )
        ]
    if type_class(columns.get(field, "")) not in ("integer", "number"):
        return []
    breaks = [k["from"] for k in classes[1:] if isinstance(k.get("from"), (int, float))]
    if len(breaks) != len(classes) - 1:
        return []
    count = c.get("count") if isinstance(c.get("count"), int) else len(classes)
    column = quote_identifier(field)
    if not _distinct_at_least(con, relation, column, count):
        return []
    empty = len(classes) - _classes_holding(con, relation, column, breaks)
    if empty <= 0:
        return []
    return [
        Problem(
            "empty_class",
            "design",
            f'{empty} of the {len(classes)} classes of "{field}" hold no feature, '
            f"although the field has at least {count} distinct values.",
        )
    ]


def _naming_problems(c: dict[str, Any]) -> list[Problem]:
    field = c.get("field")
    problems = []
    if not c.get("title"):
        problems.append(
            Problem(
                "title_missing",
                "design",
                f'The classification of "{field}" has no legend title.',
            )
        )
    if _numeric(c) and not c.get("no_data"):
        problems.append(
            Problem(
                "no_data_missing",
                "design",
                f'The classification of "{field}" has no color for features '
                "without a value.",
            )
        )
    return problems


def _shape_problems(
    document: dict[str, Any], expect: Expectation | None
) -> list[Problem]:
    if expect is None:
        return []
    wanted = {
        "field": expect.field,
        "method": expect.method,
        "palette": expect.palette,
        "reverse": expect.reverse,
        "unit": expect.unit,
    }
    wanted = {key: value for key, value in wanted.items() if value is not None}
    if not wanted:
        return []
    classify = _classifications(document)
    if not classify:
        return [
            Problem(
                "field_expected" if "field" in wanted else "shape",
                "design",
                f"The style has no classification; the tool's default classifies "
                f"by {wanted}.",
            )
        ]
    first = classify[0]
    found = {**first, "reverse": bool(first.get("reverse"))}
    return [
        Problem(
            "field_expected" if key == "field" else "shape",
            "design",
            f"The classification's {key} is {found.get(key)!r}, not {value!r}.",
        )
        for key, value in wanted.items()
        if found.get(key) != value
    ]


def style_contract(
    document: dict[str, Any],
    con: duckdb.DuckDBPyConnection,
    relation: str,
    geometry: str | None,
    *,
    expect: Expectation | None = None,
    errors_only: bool = False,
) -> list[Problem]:
    """The rules `document` breaks for the result `relation` of `geometry`
    ("point", "line", "polygon"; None for a table); with `errors_only`, the
    hard rules alone. The class rules read the classes a computed document
    holds."""
    columns = column_types(con, relation)
    missing = referenced_fields(document) - set(columns)
    problems = [_missing_field(f, columns) for f in sorted(missing)]
    problems += _check_errors(document, con, relation, geometry, missing)
    if errors_only:
        return problems
    for c in _classifications(document):
        if c.get("field") in columns:
            problems += _class_problems(c, con, relation, columns)
        problems += _naming_problems(c)
    return problems + _shape_problems(document, expect)


def hard_problems(
    document: dict[str, Any],
    con: duckdb.DuckDBPyConnection,
    relation: str,
    geometry: str | None,
) -> list[Problem]:
    """The hard rules `document` breaks for its result (`style_contract`)."""
    return style_contract(document, con, relation, geometry, errors_only=True)


def assert_style_contract(
    document: dict[str, Any],
    con: duckdb.DuckDBPyConnection,
    relation: str,
    geometry: str | None,
    *,
    tool: str | None,
    expect: Expectation | None = None,
    strict: bool = True,
) -> list[Problem]:
    """Raises a `StyleContractError` (an AssertionError) that names `tool` and
    each broken rule when `document` breaks the contract for its result.
    Without `strict`, only the rules of `FAILS_TOOL_TESTS` raise; the others
    are warned about as `StyleContractNote`s. Returns those notes."""
    problems = style_contract(document, con, relation, geometry, expect=expect)
    failing: list[Problem] = []
    notes: list[Problem] = []
    for p in problems:
        (failing if strict or p.rule in FAILS_TOOL_TESTS else notes).append(p)
    if notes:
        warnings.warn(
            _described(tool, "keeps the hard rules but notes", notes),
            StyleContractNote,
            stacklevel=2,
        )
    if failing:
        raise StyleContractError(
            _described(tool, "breaks the style contract for its result", failing)
        )
    return notes


def _described(tool: str | None, verdict: str, problems: list[Problem]) -> str:
    lines = "\n".join(
        f"- {p.rule} ({p.level}{''.join(', ' + c for c in p.codes)}): {p.message}"
        for p in problems
    )
    return f"The default style of {tool} {verdict}:\n{lines}"


def result_geometry(con: duckdb.DuckDBPyConnection, relation: str) -> str | None:
    """The geometry ("point", "line", "polygon") of the result's first feature
    with one, as a run reads it from the rows; None without one."""
    from goatlib.tools.db import normalize_geometry_type

    column = next(
        (
            n
            for n, t in column_types(con, relation).items()
            if type_class(t) == "geometry"
        ),
        None,
    )
    if column is None:
        return None
    quoted = quote_identifier(column)
    row = con.execute(
        f"SELECT ST_GeometryType({quoted}) FROM {relation} "
        f"WHERE {quoted} IS NOT NULL LIMIT 1"
    ).fetchone()
    return normalize_geometry_type(str(row[0])) if row else None


def tool_default_style(
    runner: "BaseToolRunner",
    params: Any,
    relation: str,
    geometry: str | None,
    *,
    document: dict[str, Any] | None = None,
    metadata: DatasetMetadata | None = None,
) -> dict[str, Any]:
    """The style the run of `runner` stores for its result `relation`: the
    tool's own default for it (`get_layer_style`, or `document` for a second
    layer), fitted and computed as the run does (`computed_style` with `fit`),
    without the safety net, so a check sees the tool's style and not the
    default that would replace it."""
    if document is None:
        document = runner.get_layer_style(
            params,
            metadata or DatasetMetadata(path=relation, source_type="vector"),
            geometry,
            relation,
        )
    return runner.computed_style(
        document,
        relation=relation,
        geometry=geometry,
        fingerprint=_FINGERPRINT,
        seed=_SEED,
        fit=True,
        safety_net=False,
    )


def assert_tool_style(
    runner: "BaseToolRunner",
    params: Any,
    relation: str,
    geometry: str | None = None,
    *,
    con: duckdb.DuckDBPyConnection | None = None,
    document: dict[str, Any] | None = None,
    metadata: DatasetMetadata | None = None,
    expect: Expectation | None = None,
    strict: bool = False,
) -> dict[str, Any]:
    """Asserts that the style the run of `runner` stores for its result
    `relation` keeps the contract (`tool_default_style`,
    `assert_style_contract`; without `strict`, the rules that depend on the
    data are notes) and returns it. The geometry is read from the result's
    rows when not given (an empty result needs it given); `con` becomes the
    runner's connection when given."""
    if con is not None:
        runner._duckdb_con = con
    con = runner.duckdb_con
    if geometry is None:
        geometry = result_geometry(con, relation)
        if geometry is None:
            raise ValueError(
                "The result has no feature to read its geometry from: pass it."
            )
    styled = tool_default_style(
        runner, params, relation, geometry, document=document, metadata=metadata
    )
    assert_style_contract(
        styled,
        con,
        relation,
        geometry,
        tool=runner.get_tool_type(),
        expect=expect,
        strict=strict,
    )
    return styled
