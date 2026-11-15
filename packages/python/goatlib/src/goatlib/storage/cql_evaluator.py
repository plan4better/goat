"""CQL2 to DuckDB SQL evaluator.

This module converts CQL2 filter expressions (parsed by pygeofilter)
to DuckDB SQL WHERE clauses.

Supports:
- Comparison operators: =, <>, <, >, <=, >=
- Logical operators: AND, OR, NOT
- String operators: LIKE, ILIKE
- List operators: IN, BETWEEN
- Null checks: IS NULL
- Spatial operators: S_INTERSECTS, S_WITHIN, S_CONTAINS, etc.

Usage:
    from pygeofilter.parsers.cql2_json import parse as cql2_json_parser

    # Parse CQL2 JSON
    ast = cql2_json_parser('{"op": "=", "args": [{"property": "name"}, "Berlin"]}')

    # Convert to DuckDB SQL
    sql, params = cql2_to_duckdb_sql(ast, ["name", "population", "geom"])
    # Result: ('"name" = ?', ['Berlin'])
"""

from datetime import date, datetime, time, timedelta
from typing import Any

from pygeofilter import ast, values
from pygeofilter.backends.evaluator import Evaluator, handle

from goatlib.filter.cql import FUNCTIONS
from goatlib.filter.normalize import normalize

# Function calls in a CQL2 filter reach DuckDB by name; the allowlist and why it
# is safe live with the filter's other tables (`goatlib.filter.cql.FUNCTIONS`),
# so the checker accepts exactly what this evaluator runs.
_ALLOWED_CQL_FUNCTIONS: frozenset[str] = frozenset(FUNCTIONS)


class DuckDBCQLEvaluator(Evaluator):
    """Convert CQL2 AST to DuckDB SQL WHERE clause."""

    def __init__(
        self,
        field_names: list[str],
        geometry_column: str = "geometry",
        field_exprs: dict[str, str] | None = None,
    ) -> None:
        """Initialize evaluator.

        Args:
            field_names: List of valid column names in the table
            geometry_column: Name of the geometry column (default: "geometry")
            field_exprs: Optional ``{property name: SQL expression}`` overrides,
                consulted before any other attribute handling. A caller whose
                filterable properties are not plain columns -- a nested JSON
                path, or a computed value such as a year extracted from a
                timestamp -- supplies the expression here instead of letting
                the property name be quoted as a column reference. Keys are
                matched case-insensitively, and a property present here needs
                no entry in ``field_names``.
        """
        self.field_names = [f.lower() for f in field_names]
        self.geometry_column = geometry_column
        self.field_exprs = {k.lower(): v for k, v in (field_exprs or {}).items()}
        self.params: list[Any] = []

    def _add_param(self, value: Any) -> str:
        """Add parameter and return placeholder."""
        self.params.append(value)
        return "?"

    def _quote_identifier(self, name: str) -> str:
        """Quote a column name."""
        # Escape any existing quotes
        escaped = name.replace('"', '""')
        return f'"{escaped}"'

    @handle(ast.Not)
    def not_(self, node, sub) -> str:
        """Handle NOT operator."""
        return f"NOT ({sub})"

    @handle(ast.And)
    def and_(self, node, lhs, rhs) -> str:
        """Handle AND operator."""
        return f"({lhs} AND {rhs})"

    @handle(ast.Or)
    def or_(self, node, lhs, rhs) -> str:
        """Handle OR operator."""
        return f"({lhs} OR {rhs})"

    @handle(ast.Comparison, subclasses=True)
    def comparison(self, node, lhs, rhs) -> str:
        """Handle comparison operators."""
        op_map = {
            "=": "=",
            "==": "=",
            "<>": "<>",
            "!=": "<>",
            "<": "<",
            ">": ">",
            "<=": "<=",
            ">=": ">=",
        }
        op = op_map.get(node.op.value, node.op.value)
        return f"{lhs} {op} {rhs}"

    @handle(ast.Between)
    def between(self, node, lhs, low, high):
        """Handle BETWEEN operator."""
        result = f"{lhs} BETWEEN {low} AND {high}"
        return f"NOT ({result})" if node.not_ else result

    @handle(ast.Like)
    def like(self, node, lhs):
        """Handle LIKE operator (always case-insensitive with ILIKE).

        Casts the left-hand side to VARCHAR so ILIKE works for numeric
        columns too — e.g., autocomplete searches against a DOUBLE column
        like AREA_SQKM where the user types digits.
        """
        pattern = self._add_param(node.pattern)
        # Always use ILIKE for case-insensitive matching (better UX)
        result = f"CAST({lhs} AS VARCHAR) ILIKE {pattern}"
        return f"NOT ({result})" if node.not_ else result

    @handle(ast.In)
    def in_(self, node, lhs, *options):
        """Handle IN operator."""
        if not options:
            return "FALSE" if not node.not_ else "TRUE"
        placeholders = ", ".join(str(opt) for opt in options)
        result = f"{lhs} IN ({placeholders})"
        return f"NOT ({result})" if node.not_ else result

    @handle(ast.IsNull)
    def null(self, node, lhs) -> str:
        """Handle IS NULL / IS NOT NULL.

        ``node.not_`` carries the negation, exactly as it does for
        ``Between``/``Like``/``In`` above. Dropping it silently inverted every
        ``IS NOT NULL`` filter -- returning precisely the rows the caller asked
        to exclude, with no error to notice.
        """
        # lhs may be a list with one element
        if isinstance(lhs, list) and len(lhs) == 1:
            lhs = lhs[0]
        return f"{lhs} IS NOT NULL" if node.not_ else f"{lhs} IS NULL"

    @handle(list)
    def list_(self, node):
        """Handle list (used in IsNull and other ops)."""
        if len(node) == 1:
            return self.evaluate(node[0])
        return [self.evaluate(item) for item in node]

    @handle(ast.Attribute)
    def attribute(self, node):
        """Handle attribute (column) reference."""
        name = node.name

        # An explicit expression wins over every rule below: the caller has
        # said what this property means in SQL, and it may not be a column at
        # all (a JSON path, a computed value), so no aliasing or column-name
        # validation applies to it.
        expr = self.field_exprs.get(name.lower())
        if expr is not None:
            return expr

        # Normalize common geometry column aliases to the actual geometry column
        # This handles cases where the CQL filter uses "geom" but the actual column is "geometry"
        geom_aliases = ["geom", "geometry", "the_geom", "wkb_geometry"]
        if name.lower() in geom_aliases:
            # Use the actual geometry column name
            return self._quote_identifier(self.geometry_column)

        # _rowid is a virtual property that maps to DuckDB's rowid + 1
        # (feature_id = rowid + 1 because MVT feature ID 0 is "unset" in MapLibre)
        if name == "_rowid":
            return "(rowid + 1)"

        # When filtering on "id" but the table has no id column, use rowid + 1
        if name.lower() == "id" and "id" not in self.field_names:
            return "(rowid + 1)"

        # Validate column name
        if name.lower() not in self.field_names:
            raise ValueError(f"Unknown field: {name}. Valid fields: {self.field_names}")
        return self._quote_identifier(name)

    @handle(ast.Arithmetic, subclasses=True)
    def arithmetic(self, node, lhs, rhs) -> str:
        """Handle arithmetic operators."""
        op_map = {"+": "+", "-": "-", "*": "*", "/": "/"}
        op = op_map.get(node.op.value, node.op.value)
        return f"({lhs} {op} {rhs})"

    @handle(ast.Function)
    def function(self, node, *arguments) -> str:
        """Handle function calls, restricted to a vetted pure-scalar allowlist.

        The name is matched case-insensitively and the canonical allowlisted
        spelling is emitted — the caller's token never reaches the SQL string,
        so it cannot inject even via a quoted-identifier name. Arguments are
        already parameterized by their own handlers.
        """
        canonical = str(node.name).strip().lower()
        if canonical not in _ALLOWED_CQL_FUNCTIONS:
            raise ValueError(f"Unsupported function in filter: {node.name!r}")
        args_str = ", ".join(str(arg) for arg in arguments)
        return f"{canonical}({args_str})"

    # Literal handlers
    @handle(str)
    def literal_str(self, value):
        """Handle string literals."""
        return self._add_param(value)

    @handle(int)
    def literal_int(self, value):
        """Handle integer literals."""
        return self._add_param(value)

    @handle(float)
    def literal_float(self, value):
        """Handle float literals."""
        return self._add_param(value)

    @handle(bool)
    def literal_bool(self, value) -> str:
        """Handle boolean literals."""
        return "TRUE" if value else "FALSE"

    @handle(datetime)
    def literal_datetime(self, value):
        """Handle datetime literals."""
        return self._add_param(value.isoformat())

    @handle(date)
    def literal_date(self, value):
        """Handle date literals."""
        return self._add_param(value.isoformat())

    @handle(time)
    def literal_time(self, value):
        """Handle time literals."""
        return self._add_param(value.isoformat())

    @handle(timedelta)
    def literal_timedelta(self, value):
        """Handle timedelta literals."""
        return self._add_param(str(value))

    @handle(values.Interval)
    def interval(self, node, start, end):
        """Handle interval values."""
        return (start, end)

    @handle(values.Geometry)
    def geometry(self, node) -> str:
        """Handle geometry literals.

        pygeofilter's Geometry object has a .geometry attribute containing
        a GeoJSON dict. We use ST_GeomFromGeoJSON for proper parsing.

        An area is bound as its union (`normalize_area`): against a constant
        MultiPolygon whose polygons overlap, DuckDB reads a point in two of
        them as outside.
        """
        import json

        from goatlib.filter.area import normalize_area

        # node.geometry is a GeoJSON dict
        if hasattr(node, "geometry") and isinstance(node.geometry, dict):
            geojson_str = json.dumps(normalize_area(node.geometry))
            return f"ST_GeomFromGeoJSON({self._add_param(geojson_str)})"

        # Fallback: try WKT if available
        if hasattr(node, "wkt"):
            return f"ST_GeomFromText({self._add_param(node.wkt)})"

        # Last resort: stringify (probably won't work)
        return f"ST_GeomFromText({self._add_param(str(node))})"

    @handle(values.Envelope)
    def envelope(self, node) -> str:
        """Handle envelope/bbox values."""
        # Create WKT from envelope
        wkt = (
            f"POLYGON(({node.x1} {node.y1}, {node.x1} {node.y2}, "
            f"{node.x2} {node.y2}, {node.x2} {node.y1}, {node.x1} {node.y1}))"
        )
        return f"ST_GeomFromText({self._add_param(wkt)})"

    # Spatial operators - DuckDB Spatial compatible
    @handle(ast.SpatialComparisonPredicate, subclasses=True)
    def spatial_operation(self, node, lhs, rhs) -> str:
        """Handle spatial comparison operators."""
        op_map = {
            "INTERSECTS": "ST_Intersects",
            "S_INTERSECTS": "ST_Intersects",
            "DISJOINT": "ST_Disjoint",
            "CONTAINS": "ST_Contains",
            "WITHIN": "ST_Within",
            "TOUCHES": "ST_Touches",
            "CROSSES": "ST_Crosses",
            "OVERLAPS": "ST_Overlaps",
            "EQUALS": "ST_Equals",
        }
        func_name = op_map.get(node.op.name.upper(), f"ST_{node.op.name}")
        return f"{func_name}({lhs}, {rhs})"

    @handle(ast.Relate)
    def spatial_pattern(self, node, lhs, rhs) -> str:
        """Handle ST_Relate with pattern."""
        return f"ST_Relate({lhs}, {rhs}, {self._add_param(node.pattern)})"

    @handle(ast.SpatialDistancePredicate, subclasses=True)
    def spatial_distance(self, node, lhs, rhs) -> str:
        """Handle distance-based spatial predicates."""
        distance = self._add_param(node.distance)
        if node.op.value.upper() == "DWITHIN":
            return f"ST_DWithin({lhs}, {rhs}, {distance})"
        elif node.op.value.upper() == "BEYOND":
            return f"NOT ST_DWithin({lhs}, {rhs}, {distance})"
        return f"ST_Distance({lhs}, {rhs}) {node.op.value} {distance}"

    @handle(ast.BBox)
    def bbox(self, node, lhs) -> str:
        """Handle BBOX predicate."""
        wkt = (
            f"POLYGON(({node.minx} {node.miny}, {node.minx} {node.maxy}, "
            f"{node.maxx} {node.maxy}, {node.maxx} {node.miny}, "
            f"{node.minx} {node.miny}))"
        )
        return f"ST_Intersects({lhs}, ST_GeomFromText({self._add_param(wkt)}))"

    # Temporal operators
    @handle(ast.TemporalPredicate, subclasses=True)
    def temporal(self, node, lhs, rhs) -> str:
        """Handle temporal predicates."""
        op = node.op.value.upper()

        if isinstance(rhs, tuple):
            # Interval
            start, end = rhs
            if op == "DURING":
                return f"({lhs} >= {start} AND {lhs} <= {end})"
            elif op == "BEFORE":
                return f"{lhs} < {start}"
            elif op == "AFTER":
                return f"{lhs} > {end}"
        else:
            # Single value
            if op == "BEFORE":
                return f"{lhs} < {rhs}"
            elif op == "AFTER":
                return f"{lhs} > {rhs}"
            elif op in ("TEQUALS", "EQUALS"):
                return f"{lhs} = {rhs}"

        return f"{lhs} = {rhs}"


def cql2_to_duckdb_sql(
    cql_ast: Any,
    field_names: list[str],
    geometry_column: str = "geometry",
    field_exprs: dict[str, str] | None = None,
) -> tuple[str, list[Any]]:
    """Convert CQL2 AST to DuckDB SQL WHERE clause with parameters.

    Args:
        cql_ast: Parsed CQL2 AST from pygeofilter
        field_names: List of valid column names
        geometry_column: Name of geometry column
        field_exprs: Optional ``{property name: SQL expression}`` overrides for
            properties that are not plain columns (see
            :class:`DuckDBCQLEvaluator`)

    Returns:
        Tuple of (sql_where_clause, parameters)
    """
    evaluator = DuckDBCQLEvaluator(field_names, geometry_column, field_exprs)
    sql = evaluator.evaluate(cql_ast)
    return sql, evaluator.params


def parse_cql2_filter(
    filter_str: str | dict,
    filter_lang: str = "cql2-json",
) -> Any:
    """Parse CQL2 filter string to AST.

    Args:
        filter_str: CQL2 filter string (a cql2-json filter may also be a dict)
        filter_lang: Either 'cql2-json' or 'cql2-text'

    Returns:
        Parsed AST
    """
    if filter_lang == "cql2-json":
        from pygeofilter.parsers.cql2_json import parse as cql2_json_parser

        return cql2_json_parser(filter_str)
    else:
        from pygeofilter.parsers.cql2_text import parse as cql2_text_parser

        return cql2_text_parser(filter_str)


def inline_params(sql: str, params: list[Any]) -> str:
    """Inline parameters into SQL string.

    Replaces ? placeholders with actual parameter values.
    Useful for commands that don't support parameterized queries (e.g., COPY).

    Args:
        sql: SQL string with ? placeholders
        params: Parameter values to substitute

    Returns:
        SQL string with parameters inlined
    """
    # One pass over the SQL: a value written in is never read again, so a
    # question mark inside it is no placeholder, nor is one inside a quoted
    # name.
    values = iter(params)
    out: list[str] = []
    quote: str | None = None
    for char in sql:
        if quote:
            if char == quote:
                quote = None
        elif char in ("'", '"'):
            quote = char
        elif char == "?":
            out.append(_sql_literal(next(values)))
            continue
        out.append(char)
    return "".join(out)


def _sql_literal(param: Any) -> str:
    """A parameter as a SQL literal."""
    if isinstance(param, str):
        # Escape single quotes and wrap in quotes
        escaped = param.replace("'", "''")
        return f"'{escaped}'"
    if param is None:
        return "NULL"
    if isinstance(param, bool):
        return "TRUE" if param else "FALSE"
    # Numbers, etc.
    return str(param)


def cql_to_where_clause(
    cql_filter: dict | str,
    column_names: list[str],
    geometry_column: str = "geometry",
    inline: bool = False,
) -> tuple[str, list[Any]] | str:
    """Convert CQL2 filter to SQL WHERE clause.

    High-level utility that handles JSON parsing and conversion.

    Args:
        cql_filter: CQL2 filter as dict or JSON string
        column_names: Valid column names for the table
        geometry_column: Name of geometry column
        inline: If True, return SQL string with params inlined (for COPY commands)
                If False, return (where_clause, params) tuple

    Returns:
        If inline=False: (where_clause, params) tuple
        If inline=True: SQL string with parameters substituted

    Example:
        # For parameterized queries:
        where, params = cql_to_where_clause(filter_dict, columns)
        con.execute(f"SELECT * FROM t WHERE {where}", params)

        # For COPY commands:
        where = cql_to_where_clause(filter_dict, columns, inline=True)
        con.execute(f"COPY (SELECT * FROM t WHERE {where}) TO ...")
    """
    import json

    # Parse JSON string if needed
    if isinstance(cql_filter, str):
        cql_filter = json.loads(cql_filter)

    # Parse the CQL2 filter, in the spellings the parser takes
    filter_json = json.dumps(normalize(cql_filter))
    ast = parse_cql2_filter(filter_json, "cql2-json")

    # Convert to SQL
    sql, params = cql2_to_duckdb_sql(ast, column_names, geometry_column)

    if inline:
        return inline_params(sql, params)
    return sql, params
