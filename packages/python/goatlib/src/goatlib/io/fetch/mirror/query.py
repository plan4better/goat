"""The SQL a fetch runs over the mirror.

Its columns, candidate rows and filters, and the lineage it records.
"""

from datetime import datetime
from typing import Any

from goatlib.io.fetch.mirror.osm import (
    TAGS_SQL,
    _quote,
    _tag_sql,
    _tags_from,
    tag_storage,
)
from goatlib.io.fetch.mirror.overture import overture_plain_columns
from goatlib.io.fetch.mirror.reader import Source, mirror_columns


def selected_columns(
    columns: dict[str, str], source: Source, storage: str
) -> list[tuple[str, str, str]]:
    """What a fetch writes: (SQL expression over `c`, output name, type before DuckDB resolves it)."""
    nested = ("STRUCT", "MAP", "UNION")
    out: list[tuple[str, str, str]] = []
    if source.tagged:
        for name, kind in columns.items():
            if name not in ("tags", "all_tags", "bbox", "filename"):
                out.append((f'c."{name}"', name, kind))
        # One text column, as from the hstore files: the tile writer drops a map.
        if storage == "text":
            if "all_tags" in columns:
                out.append(('c."all_tags"', "all_tags", columns["all_tags"]))
        else:
            out.append(
                ("CAST(to_json(c.tags) AS VARCHAR) AS all_tags", "all_tags", "VARCHAR")
            )
        return out
    # Right after the id, so they are the first thing a popup shows.
    out.append(
        (f'c."{source.id_column}"', source.id_column, columns.get(source.id_column, ""))
    )
    for item in overture_plain_columns(columns):
        out.append((item, item.rsplit(" AS ", 1)[1], "VARCHAR"))
    for name, kind in columns.items():
        if name in (source.id_column, "bbox", "filename"):
            continue
        # Nested records as JSON text: the table and the tiles show nothing readable.
        if kind.upper().startswith(nested) or kind.endswith("]"):
            out.append(
                (f'CAST(to_json(c."{name}") AS VARCHAR) AS "{name}"', name, "VARCHAR")
            )
        else:
            out.append((f'c."{name}"', name, kind))
    return out


def output_columns(
    con: "Any", files: list[str], source: Source, type_key: str
) -> list[tuple[str, str]]:
    """The (name, DuckDB type) of each attribute a fetch writes, without fetching."""
    columns = mirror_columns(con, files)
    storage = tag_storage(columns)
    select = ", ".join(e for e, _, _ in selected_columns(columns, source, storage))
    rows = con.execute(
        f"DESCRIBE SELECT {select} FROM "
        f"({candidates_sql(files, source, (-180, -90, 180, 90), 'TRUE', storage)}) c"
    ).fetchall()
    return [(str(r[0]), str(r[1])) for r in rows if str(r[0]) != source.geom]


def checked_where(con: "Any", files: list[str], source: Source, where: str) -> str:
    """A user's own condition, held to what goatlib allows in an expression."""
    from goatlib.utils.expressions.validator import ExpressionValidator

    columns = list(mirror_columns(con, files))
    if source.tagged and "tags" not in columns:
        columns.append("tags")
    result = ExpressionValidator(columns, source.geom).validate(where)
    if not result.valid:
        raise ValueError(
            "The SQL condition is not allowed: "
            + "; ".join(e.message for e in result.errors)
        )
    return f"({where})"


def candidates_sql(
    files: list[str],
    source: Source,
    envelope: tuple,
    prefilter: str,
    storage: str = "text",
) -> str:
    """One read over every covering file. Features at a continent seam can arrive
    twice; the caller de-duplicates by id."""
    xmin, ymin, xmax, ymax = envelope
    # Inside a CASE, so only rows the prefilter admits are parsed: written as a
    # plain projection, DuckDB merged it with the exact test into one filter and
    # parsed every row first -- 0.59s instead of 0.05s for Munich's points.
    parsed = (
        TAGS_SQL
        if prefilter == "TRUE"
        else f"CASE WHEN {prefilter} THEN {TAGS_SQL} END"
    )
    if not source.tagged or storage == "map":
        projection = "*"
    elif storage == "text":
        projection = f"* EXCLUDE (all_tags), all_tags, {parsed} AS tags"
    else:
        projection = f"* EXCLUDE (tags), {_tags_from(storage, parsed)} AS tags"
    listed = ", ".join(f"'{_quote(f)}'" for f in files)
    return f"""SELECT {projection}
        FROM read_parquet([{listed}], union_by_name = true, filename = true)
        WHERE bbox.xmin <= {xmax} AND bbox.xmax >= {xmin}
          AND bbox.ymin <= {ymax} AND bbox.ymax >= {ymin}
          AND {prefilter}
          AND ST_Intersects("{source.geom}", ST_MakeEnvelope({xmin}, {ymin}, {xmax}, {ymax}))"""


def _version_date(version: str) -> str:
    """A mirror version as a date a person reads: '20261011' -> '11 Oct 2026'."""
    try:
        day = datetime.strptime(version, "%Y%m%d")
    except ValueError:
        return version
    return f"{day.day} {day:%b %Y}"


def lineage_text(
    source: Source,
    type_key: str,
    parts: list[tuple[str, str]],
    filters: list,
    match_mode: str = "all",
    where: str | None = None,
) -> str:
    """Where the layer's data came from, in a sentence for the metadata panel."""
    if source.tagged:
        places = [unit.replace("-", " ").title() for unit, _ in parts]
        named = (
            f"{', '.join(places[:-1])} and {places[-1]}"
            if len(places) > 1
            else "".join(places)
        )
        latest = max((version for _, version in parts), default="")
        text = f"OpenStreetMap data for {named}, as of {_version_date(latest)}."
    else:
        release = parts[0][1] if parts else ""
        text = f"Overture Maps {type_key.replace('_', ' ')}, release {release}."
    if where:
        return f"{text} Only features matching: {where}"
    if filters:
        conditions = [
            f"{f.key} is {' or '.join(f.values)}" if f.values else f"{f.key} is set"
            for f in filters
        ]
        joiner = " and " if match_mode == "all" else " or "
        text += f" Only features where {joiner.join(conditions)}."
    return text


def _column_sql(
    filters: list, joiner: str, source: Source, type_key: str
) -> tuple[str, str]:
    """The same pair for a typed source: no prefilter, a plain comparison.

    Nothing to pre-filter and nothing to parse -- the attribute is already a
    column, so the only test is the test.
    """
    if not filters:
        return "TRUE", "TRUE"
    exact = []
    for f in filters:
        column = source.field_sql(type_key, f.key)
        if not f.values:
            exact.append(f"{column} IS NOT NULL")
        else:
            listed = ", ".join(f"'{_quote(v)}'" for v in f.values)
            # Not `IN`: over S3 a one-value IN becomes `=`, which DuckDB pushes
            # into the Parquet reader, and the reader then fetches each row
            # group's other columns separately -- 718 requests instead of 178
            # for Munich, five seconds instead of one. A function stays out.
            exact.append(f"list_contains([{listed}], {column})")
    return "TRUE", joiner.join(exact)


def filter_sql(
    filters: list,
    source: Source,
    match_mode: str = "all",
    type_key: str = "places",
    storage: str = "text",
) -> tuple[str, str]:
    """(cheap prefilter before parsing, exact test after)."""
    joiner = " AND " if match_mode == "all" else " OR "
    if source.tagged:
        return _tag_sql(filters, joiner, storage)
    return _column_sql(filters, joiner, source, type_key)
