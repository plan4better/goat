"""Shared query building utilities for DuckDB SQL queries.

This module provides reusable components for building DuckDB SQL queries
with spatial filters, CQL2 filters, and other common query patterns.
"""

import json
import logging
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Optional

from goatlib.filter.normalize import normalize
from goatlib.storage.cql_evaluator import cql2_to_duckdb_sql, parse_cql2_filter

logger = logging.getLogger(__name__)

#: The most reasons a refused filter names; the rest it counts.
_MAX_REASONS = 3
#: The kinds of column a filter's checker reads as fields, as the map's
#: queryables give them (a time is text there); objects and geometries are no
#: fields.
_FIELD_KINDS = {"time": "string"} | {
    kind: kind
    for kind in ("string", "number", "integer", "boolean", "date", "datetime")
}


class UnreadableFilterError(ValueError):
    """A layer's filter that a tool or an export cannot apply.

    Refused rather than dropped: without it the tool would run on the whole
    layer and hand back a result that looks right.
    """


@dataclass
class QueryFilters:
    """Container for query filter conditions and parameters.

    Attributes:
        clauses: List of SQL WHERE clause fragments
        params: List of parameter values for placeholders
    """

    clauses: list[str] = field(default_factory=list)
    params: list[Any] = field(default_factory=list)

    def add(self, clause: str, *args: Any) -> "QueryFilters":
        """Add a clause with optional parameters.

        Args:
            clause: SQL clause fragment (use ? for placeholders)
            *args: Parameter values for placeholders

        Returns:
            Self for method chaining
        """
        self.clauses.append(clause)
        self.params.extend(args)
        return self

    def extend(self, other: "QueryFilters") -> "QueryFilters":
        """Merge another QueryFilters into this one.

        Args:
            other: QueryFilters to merge

        Returns:
            Self for method chaining
        """
        self.clauses.extend(other.clauses)
        self.params.extend(other.params)
        return self

    def to_where_sql(self, prefix: str = " AND ") -> str:
        """Convert to SQL WHERE clause fragment.

        Args:
            prefix: String to prepend if clauses exist

        Returns:
            SQL string (e.g., " AND clause1 AND clause2") or empty string
        """
        if not self.clauses:
            return ""
        return prefix + " AND ".join(self.clauses)

    def to_full_where(self, default: str = "TRUE") -> str:
        """Convert to complete WHERE clause content.

        Args:
            default: Default value if no clauses

        Returns:
            SQL string for WHERE clause body
        """
        if not self.clauses:
            return default
        return " AND ".join(self.clauses)


def build_bbox_filter(
    bbox: list[float],
    geometry_column: str,
) -> QueryFilters:
    """Build a bounding box spatial filter.

    Args:
        bbox: Bounding box [minx, miny, maxx, maxy]
        geometry_column: Name of the geometry column

    Returns:
        QueryFilters with bbox intersection clause
    """
    minx, miny, maxx, maxy = bbox
    bbox_wkt = (
        f"POLYGON(({minx} {miny}, {minx} {maxy}, "
        f"{maxx} {maxy}, {maxx} {miny}, {minx} {miny}))"
    )

    filters = QueryFilters()
    filters.add(
        f'ST_Intersects("{geometry_column}", ST_GeomFromText(?))',
        bbox_wkt,
    )
    return filters


def build_cql_filter(
    cql_filter: dict[str, Any],
    column_names: list[str],
    geometry_column: str = "geometry",
    normalize_geometry_aliases: bool = True,
) -> QueryFilters:
    """Build a CQL2 filter.

    Args:
        cql_filter: Dict with 'filter' (string) and optional 'lang' keys
        column_names: List of valid column names for validation
        geometry_column: Name of the geometry column
        normalize_geometry_aliases: Whether to normalize 'geom' to actual column name

    Returns:
        QueryFilters with CQL clause, or empty if parsing fails. A map request
        then shows every feature; a tool or an export, which must not run on
        the whole layer instead, uses `checked_cql_filter`.
    """
    try:
        return _translated(
            cql_filter, column_names, geometry_column, normalize_geometry_aliases
        )
    except Exception as e:
        logger.warning("CQL2 parse error: %s", e)
        # Don't fail the request, just skip the filter
        return QueryFilters()


def _translated(
    cql_filter: dict[str, Any],
    column_names: list[str],
    geometry_column: str,
    normalize_geometry_aliases: bool,
) -> QueryFilters:
    """`build_cql_filter`'s clause; raises where the filter does not translate."""
    filters = QueryFilters()
    # Include geometry column and common aliases in valid field names
    geom_aliases = {"geom", "geometry", geometry_column.lower()}
    cql_field_names = list(column_names)
    cql_field_names.extend(geom_aliases)

    # Preprocess filter to normalize geometry column references
    filter_str = cql_filter["filter"]
    if normalize_geometry_aliases and isinstance(filter_str, str):
        filter_str = _normalize_geometry_property(filter_str, geometry_column)

    # Legacy and standard spellings the parser does not take (goatlib.filter.normalize)
    if cql_filter.get("lang", "cql2-json") == "cql2-json":
        filter_str = normalize(
            json.loads(filter_str) if isinstance(filter_str, str) else filter_str
        )

    ast = parse_cql2_filter(
        filter_str,
        cql_filter.get("lang", "cql2-json"),
    )
    cql_sql, cql_params = cql2_to_duckdb_sql(ast, cql_field_names, geometry_column)
    filters.add(f"({cql_sql})", *cql_params)

    logger.debug("CQL filter SQL: %s, params: %s", cql_sql, cql_params)
    return filters


def _unreadable(reasons: list[str]) -> UnreadableFilterError:
    shown = " ".join(reasons[:_MAX_REASONS])
    if len(reasons) > _MAX_REASONS:
        shown += f" ({len(reasons) - _MAX_REASONS} more)"
    return UnreadableFilterError(
        f"The layer's filter cannot be applied: {shown} "
        "Change or remove the filter and try again."
    )


def checked_cql_filter(
    cql_filter: Any,
    columns: Mapping[str, str],
    geometry_column: str = "geometry",
) -> QueryFilters:
    """A layer's CQL2-JSON filter as WHERE clauses for a tool or an export,
    which filter by it in full or not at all.

    `build_cql_filter` drops a filter it cannot read: a map request then shows
    every feature, but a tool or an export would run on the whole layer and
    hand back a result that looks right. Here such a filter raises
    `UnreadableFilterError` with its reasons: a filter over a request ceiling
    (`goatlib.filter.limits.REQUEST_MAX_*`), one the checker finds broken as a
    saved filter (`goatlib.filter.validate` with `stored=True`: its errors and
    the fields a data change broke; the save limits are warnings there, so a
    filter saved over one applies as it does on the map), and one the
    evaluator does not translate.

    Args:
        cql_filter: The filter, as a dict or JSON text; None or an empty
            object is no filter and gives no clause.
        columns: The layer's columns with their DuckDB types (DESCRIBE), or
            with the kinds `goatlib.utils.column_types.type_class` gives them.
            The checker reads them as the map's queryables give them: a time
            as text, objects and geometries as no fields.
        geometry_column: Name of the geometry column
    """
    from typing import get_args

    from goatlib.filter.validate import over_request_limits, validate
    from goatlib.style.context import DataContext, FieldInfo
    from goatlib.utils.column_types import TypeClass, type_class

    def kind_of(column_type: str) -> str:
        return (
            column_type
            if column_type in get_args(TypeClass)
            else type_class(column_type)
        )

    if isinstance(cql_filter, str):
        try:
            cql_filter = json.loads(cql_filter)
        except ValueError:
            raise _unreadable(["The filter is not valid JSON."]) from None
    if cql_filter is None or cql_filter == {}:
        return QueryFilters()
    issues = over_request_limits(cql_filter) if isinstance(cql_filter, dict) else []
    if not issues:
        fields = {
            name: FieldInfo(name=name, type=_FIELD_KINDS[kind])  # type: ignore[arg-type]
            for name, column_type in columns.items()
            if (kind := kind_of(column_type)) in _FIELD_KINDS
        }
        context = DataContext(kind="vector", fields=fields)
        issues = [
            issue
            for issue in validate(cql_filter, context, stored=True)
            if issue.level in ("error", "damaged")
        ]
    if issues:
        raise _unreadable([issue.message for issue in issues])
    try:
        return _translated(
            {"filter": json.dumps(cql_filter), "lang": "cql2-json"},
            list(columns),
            geometry_column,
            normalize_geometry_aliases=True,
        )
    except RecursionError:
        raise _unreadable(["The filter nests too deeply."]) from None
    except Exception as e:
        logger.warning("CQL2 filter refused: %s", e)
        raise _unreadable(
            ["It uses a field or a form the services cannot read."]
        ) from None


def _normalize_geometry_property(filter_str: str, geometry_column: str) -> str:
    """Normalize geometry property references in CQL filter JSON.

    Replaces common geometry aliases (geom, geometry) with the actual
    geometry column name.

    Args:
        filter_str: CQL filter JSON string
        geometry_column: Actual geometry column name

    Returns:
        Modified filter string with normalized geometry references
    """
    for alias in ["geom", "geometry"]:
        if alias.lower() != geometry_column.lower():
            # Replace in property references: {"property": "geom"} -> {"property": "geometry"}
            filter_str = re.sub(
                rf'"property"\s*:\s*"{alias}"',
                f'"property": "{geometry_column}"',
                filter_str,
                flags=re.IGNORECASE,
            )
    return filter_str


def build_id_filter(
    ids: list[str],
) -> QueryFilters:
    """Build a rowid list filter.

    Args:
        ids: List of feature IDs (rowid + 1) to filter

    Returns:
        QueryFilters with IN clause
    """
    filters = QueryFilters()
    if ids:
        placeholders = ", ".join("?" for _ in ids)
        # Convert feature IDs to rowids (feature_id = rowid + 1)
        filters.add(f"rowid IN ({placeholders})", *[int(i) - 1 for i in ids])
    return filters


def build_filters(
    bbox: Optional[list[float]] = None,
    cql_filter: Optional[dict[str, Any]] = None,
    ids: Optional[list[str]] = None,
    geometry_column: str = "geometry",
    column_names: Optional[list[str]] = None,
    has_geometry: bool = True,
) -> QueryFilters:
    """Build combined query filters.

    Convenience function to build all common filter types at once.

    Args:
        bbox: Optional bounding box [minx, miny, maxx, maxy]
        cql_filter: Optional CQL2 filter dict
        ids: Optional list of feature IDs
        geometry_column: Name of the geometry column
        column_names: Valid column names for CQL validation
        has_geometry: Whether the layer has geometry (for bbox filter)

    Returns:
        Combined QueryFilters
    """
    filters = QueryFilters()

    # ID filter
    if ids:
        filters.extend(build_id_filter(ids))

    # Bbox filter (only if layer has geometry)
    if bbox and has_geometry:
        filters.extend(build_bbox_filter(bbox, geometry_column))

    # CQL filter
    if cql_filter and column_names:
        filters.extend(
            build_cql_filter(
                cql_filter,
                column_names,
                geometry_column,
            )
        )

    return filters


def build_order_clause(sortby: Optional[str]) -> str:
    """Build ORDER BY clause from sortby parameter.

    The column name is emitted as a quoted identifier with embedded double
    quotes doubled, so it cannot terminate the identifier and add SQL of its
    own. Whether the column exists is the caller's business: an unknown name
    still reaches the database.

    Args:
        sortby: Sort column name, optionally prefixed with - (desc) or + (asc)

    Returns:
        ORDER BY clause string or empty string
    """
    if not sortby:
        return ""

    if sortby.startswith("-"):
        column, direction = sortby[1:], "DESC"
    elif sortby.startswith("+"):
        column, direction = sortby[1:], "ASC"
    else:
        column, direction = sortby, "ASC"

    quoted = '"' + column.replace('"', '""') + '"'
    return f"ORDER BY {quoted} {direction}"
