"""Which attributes, or which values of one, the mirror holds in an area.

What the fetch form lists, and its size check before a fetch.
"""

import json
import logging
import os
import threading
from typing import Any

from cachetools import TTLCache

from goatlib.io.config import parquet_copy_options
from goatlib.io.fetch.area import area_boxes, area_envelope, area_table
from goatlib.io.fetch.mirror.osm import (
    FEATURE_TYPES,
    IDENTIFIER_TAGS,
    NOT_TAGS,
    _count_tags,
    _has_key_sql,
    _quote,
    _raw_tags_sql,
    _tag_cache_path,
    filter_operator,
    tag_storage,
)
from goatlib.io.fetch.mirror.overture import OVERTURE_FIELDS, OVERTURE_TYPES
from goatlib.io.fetch.mirror.query import (
    candidates_sql,
    checked_where,
    filter_sql,
    output_columns,
    selected_columns,
)
from goatlib.io.fetch.mirror.reader import (
    MAX_FEATURES,
    MAX_READ_FEATURES,
    SOURCES,
    Source,
    _cache_lock,
    _files_of,
    _indexed,
    _too_large,
    area_size,
    filters_can_fit,
    inside_rows,
    mirror_columns,
    pointer,
    row_groups,
)

logger = logging.getLogger(__name__)


#: Features read to suggest keys and values: the fetch limit, so any area small
#: enough to fetch whole gets exact counts. Reading every feature of a large map
#: view took over a minute.
SUGGESTION_ROWS = MAX_FEATURES

#: Features a sample shows at most: a look at the columns, not a read of the area.
MAX_SAMPLE_ROWS = 50
#: A sample's cell is cut here, so one long tag list does not widen the whole table.
SAMPLE_CELL_CHARS = 120


def _sample_cell(value: Any) -> str:
    text = "" if value is None else str(value)
    return (
        text if len(text) <= SAMPLE_CELL_CHARS else text[: SAMPLE_CELL_CHARS - 1] + "…"
    )


def _filters_of(tag_filters: list[dict] | None) -> list:
    """Filters as the request sends them, as the objects the SQL builders read."""
    from types import SimpleNamespace

    return [
        SimpleNamespace(
            key=str(f.get("key", "")).strip(),
            values=list(f.get("values") or []),
            operator=f.get("operator") or "is",
        )
        for f in tag_filters or []
        if str(f.get("key", "")).strip()
    ]


def _sample_rows(
    con: "Any",
    src: Source,
    files: list[str],
    table: str,
    envelope: tuple,
    feature_type: str,
    limit: int,
    tag_filters: list[dict] | None,
    match_mode: str,
    where: str | None,
) -> dict:
    """A few of the features a fetch would write, with the same columns and filters.

    The fetch's own SQL (candidates, filters, selected columns), stopped after
    `limit` rows, so the table shows what the layer will hold rather than a guess.
    """
    columns = mirror_columns(con, files)
    storage = tag_storage(columns)
    if where:
        prefilter, exact = "TRUE", checked_where(con, files, src, where)
    else:
        # As the fetch does: a tag with its own column is tested on that column.
        filters = _filters_of(tag_filters)
        own = frozenset(
            f.key for f in filters if src.tagged and _key_column(con, files, f.key)
        )
        prefilter, exact = filter_sql(
            filters, src, match_mode, feature_type, storage, own
        )
    prefilter = f"({prefilter}) AND {src.geometry_filter(feature_type, files)}"
    selected = [
        item for item in selected_columns(columns, src, storage) if item[1] != src.geom
    ]
    select = ", ".join(expression for expression, _, _ in selected)
    (shape,) = con.execute(
        f"SELECT ST_AsHEXWKB(ST_Union_Agg(geom)) FROM {table}"
    ).fetchone()
    result = con.execute(f"""
        SELECT {select}
        FROM ({candidates_sql(files, src, envelope, prefilter, storage)}) c
        WHERE {exact} AND ST_Intersects(c."{src.geom}", ST_GeomFromHEXWKB('{shape}'))
        LIMIT {max(1, min(int(limit), MAX_SAMPLE_ROWS))}
    """)
    names = [str(d[0]) for d in result.description]
    rows = [[_sample_cell(v) for v in row] for row in result.fetchall()]
    return {
        "key": None,
        "total": len(rows),
        "values": [],
        "columns": [{"name": n, "type": t} for n, (_, _, t) in zip(names, selected)],
        "geometry_type": src.geometry_of(feature_type),
        "rows": rows,
    }


#: A first, fast read whose list shows while the full one is counted.
QUICK_ROWS = 100_000
#: The same for a key too rare to show up in that sample.
RARE_KEY_ROWS = 20_000


#: How long a missing ``_values.parquet`` is trusted to stay missing.
RECHECK_SECONDS = 60
_counts: TTLCache[tuple, list[tuple[str, int]]] = TTLCache(maxsize=20000, ttl=3600)
_no_counts: TTLCache[str, bool] = TTLCache(maxsize=1000, ttl=RECHECK_SECONDS)


def _column_values(
    con: "Any",
    source: Source,
    files: list[str],
    type_key: str,
    envelope: tuple,
    key: str | None,
    limit: int,
) -> dict:
    """The same answer for a typed source, without any of the machinery.

    No hstore to parse, so no cache either: the values are a plain count over one
    column.
    """
    # By each feature's bbox only, as for OSM: the exact test reads the geometry
    # column and changes nothing a dropdown shows.
    xmin, ymin, xmax, ymax = envelope
    listed = ", ".join(f"'{_quote(f)}'" for f in files)
    capped = f"""SELECT * FROM read_parquet([{listed}], union_by_name = true)
        WHERE bbox.xmin <= {xmax} AND bbox.xmax >= {xmin}
          AND bbox.ymin <= {ymax} AND bbox.ymax >= {ymin}
          AND {source.geometry_filter(type_key, files)}
        LIMIT {SUGGESTION_ROWS}"""
    column = source.field_sql(type_key, key)
    rows = con.execute(f"""
        SELECT {column} AS value, count(*) AS count, sum(count(*)) OVER () AS seen
        FROM ({capped}) WHERE {column} IS NOT NULL
        GROUP BY value ORDER BY count DESC, value LIMIT {int(limit)}
    """).fetchall()
    return {
        "key": key,
        "total": len(rows),
        "sampled": bool(rows) and rows[0][2] >= SUGGESTION_ROWS,
        "values": [{"value": str(v), "count": n} for v, n, _ in rows],
    }


def _built_counts(
    con: "Any", values_file: str, paths: list[str], key: str | None
) -> list[tuple[str, int]] | None:
    """One version's built counts for some of its files; None without ``_values.parquet``."""
    with _cache_lock:
        if values_file in _no_counts:
            return None
        known = {
            p: _counts[(values_file, p, key)]
            for p in paths
            if (values_file, p, key) in _counts
        }
    missing = [p for p in paths if p not in known]
    if missing:
        picked = "key" if key is None else "value"
        which = (
            "value IS NULL"
            if key is None
            else f"key = '{_quote(key)}' AND value IS NOT NULL"
        )
        try:
            rows = con.execute(f"""
                SELECT path, {picked}, sum(count)::BIGINT FROM read_parquet('{_quote(values_file)}')
                WHERE {which} AND path IN ({", ".join(f"'{_quote(p)}'" for p in missing)})
                GROUP BY path, {picked}
            """).fetchall()
        except Exception as e:  # noqa: BLE001 - a version built before the file existed
            logger.info("no value counts at %s: %s", values_file, e)
            with _cache_lock:
                _no_counts[values_file] = True
            return None
        fresh: dict[str, list[tuple[str, int]]] = {p: [] for p in missing}
        for p, v, n in rows:
            fresh[p].append((v, int(n)))
        with _cache_lock:
            for p, found in fresh.items():
                _counts[(values_file, p, key)] = found
        known.update(fresh)
    return [vn for p in paths for vn in known[p]]


def _values_files(indexed: tuple[dict, list]) -> dict[str, list[str]]:
    """The parts of each version the area reads, under that version's counts file."""
    by_file: dict[str, list[str]] = {}
    for index, p, *_ in indexed[1]:
        by_file.setdefault(
            index.removesuffix("_index.parquet") + "_values.parquet", []
        ).append(p)
    return by_file


def _build_values(
    con: "Any", indexed: tuple[dict, list], key: str | None
) -> list[tuple[str, int]] | None:
    """Values (or keys) summed over the view's files from the built counts; None if none."""
    found = [_built_counts(con, f, ps, key) for f, ps in _values_files(indexed).items()]
    if all(rows is None for rows in found):
        return None
    total: dict[str, int] = {}
    for rows in found:
        for v, n in rows or []:
            total[v] = total.get(v, 0) + int(n)
    return sorted(total.items(), key=lambda kv: (-kv[1], kv[0]))


def _big_view_keys(
    con: "Any", groups: list[tuple], envelope: tuple, estimate: int
) -> dict:
    """The tags a view over the cap offers: the files' tag columns, without counts."""
    xmin, ymin, xmax, ymax = envelope
    files = list(
        dict.fromkeys(
            g[0]
            for g in groups
            if g[3] is None
            or (g[3] <= xmax and g[5] >= xmin and g[4] <= ymax and g[6] >= ymin)
        )
    )
    tags = sorted(
        {
            c
            for f in files
            for c, t in mirror_columns(con, [f]).items()
            if t.upper() == "VARCHAR" and c not in NOT_TAGS
        }
    )
    return {
        "key": None,
        "total": len(tags),
        "sampled": True,
        "complete": True,
        "estimate": estimate,
        "values": [{"value": c, "count": 0} for c in tags],
    }


def _key_column(con: "Any", files: list[str], key: str) -> bool:
    """Whether every file holds this tag as its own column, beside the full tags."""
    return all(
        mirror_columns(con, [f]).get(key, "").upper() == "VARCHAR" for f in files
    )


def _column_counts(
    con: "Any", files: list[str], envelope: tuple, key: str, limit: int
) -> tuple[list, int]:
    """A tag's commonest values from its own column, and how many were counted."""
    xmin, ymin, xmax, ymax = envelope
    listed = ", ".join(f"'{_quote(f)}'" for f in files)
    column = '"' + key.replace('"', '""') + '"'
    rows = con.execute(f"""
        SELECT value, count(*) AS count, sum(count(*)) OVER () AS seen FROM (
            SELECT {column} AS value FROM read_parquet([{listed}], union_by_name = true)
            WHERE bbox.xmin <= {xmax} AND bbox.xmax >= {xmin}
              AND bbox.ymin <= {ymax} AND bbox.ymax >= {ymin} AND {column} IS NOT NULL
            LIMIT {SUGGESTION_ROWS}
        ) GROUP BY value ORDER BY count DESC, value LIMIT {int(limit)}
    """).fetchall()
    return [(v, n) for v, n, _ in rows], int(rows[0][2]) if rows else 0


def _matching_rows(
    con: "Any",
    files: list[str],
    source: Source,
    type_key: str,
    envelope: tuple,
    boxes: list[tuple],
    filters: list,
    match_mode: str = "all",
) -> int:
    """Features matching the filters whose bbox touches the area, without their geometry."""
    storage = tag_storage(mirror_columns(con, files))
    own = frozenset(
        f.key for f in filters if source.tagged and _key_column(con, files, f.key)
    )
    prefilter, exact = filter_sql(filters, source, match_mode, type_key, storage, own)
    prefilter = f"({prefilter}) AND {source.geometry_filter(type_key, files)}"
    touches = " OR ".join(
        f"(c.bbox.xmin <= {x1} AND c.bbox.xmax >= {x0} "
        f"AND c.bbox.ymin <= {y1} AND c.bbox.ymax >= {y0})"
        for x0, y0, x1, y1 in boxes
    )
    candidates = candidates_sql(
        files, source, envelope, prefilter, storage, exact_area=False
    )
    (n,) = con.execute(
        f"SELECT count(*) FROM ({candidates}) c WHERE {exact} AND ({touches})"
    ).fetchone()
    return int(n)


def counted_matches(
    con: "Any",
    indexed: tuple[dict, list],
    source: Source,
    type_key: str,
    filters: list,
    match_mode: str = "all",
) -> int | None:
    """At most how many features match, from the build's counts; None if they cannot say.

    Only for chosen values, of any OSM tag or of Overture's filterable attributes:
    whole files are counted, so a country's supermarkets fit a fetch however
    large the area.
    """
    # Only "is" with values narrows to what the counts hold. With "all" every filter
    # narrows, so the countable ones bound the rest; with "any" each adds, so all must count.
    countable = [f for f in filters if filter_operator(f) == "is"]
    if not source.tagged:
        fields = OVERTURE_FIELDS.get(OVERTURE_TYPES[type_key][0], {})
        countable = [f for f in countable if f.key in fields]
    if not countable or (match_mode != "all" and len(countable) < len(filters)):
        return None
    total = 0
    for values_file, paths in _values_files(indexed).items():
        for f in countable:
            # One read per file of counts; each part below is then cached.
            if _built_counts(con, values_file, paths, f.key) is None:
                return None
        for p in paths:
            per_filter = []
            for f in countable:
                counts = dict(_built_counts(con, values_file, [p], f.key) or [])
                # A key the build did not count (addr:*, name, rare ones) says nothing.
                if not counts:
                    if match_mode == "all":
                        continue
                    return None
                # The build keeps a key's commonest values only: one left out is
                # rarer than the rarest kept.
                rarest = min(counts.values())
                per_filter.append(sum(counts.get(v, rarest) for v in f.values))
            if not per_filter:
                return None
            total += min(per_filter) if match_mode == "all" else sum(per_filter)
    return total


def mirror_values(
    con: "Any",
    *,
    area: dict,
    feature_type: str,
    key: str | None = None,
    limit: int = 100,
    source_name: str = "osm",
    quick: bool = False,
    size_only: bool = False,
    columns_only: bool = False,
    sample_only: bool = False,
    tag_filters: list[dict] | None = None,
    match_mode: str = "all",
    where: str | None = None,
) -> dict:
    """Which attributes, or which values of one attribute, the mirror holds here.

    OSM tags or Overture columns alike: the source decides how they are read.

    Scoped to the area on purpose: over a whole country this would mean parsing
    every row, while a district is a few thousand and answers at once. It is
    also the only list worth showing -- a key that exists in Hamburg helps
    nobody drawing a box in Munich.
    """
    import hashlib

    src = SOURCES.get(source_name)
    if src is None or feature_type not in (
        FEATURE_TYPES if src.tagged else OVERTURE_TYPES
    ):
        raise ValueError(f"No {feature_type!r} in the {source_name!r} source.")
    table = area_table(con, area)
    envelope = area_envelope(con, table)
    boxes = area_boxes(con, table)
    indexed = _indexed(con, pointer(con, src), src, feature_type, envelope)
    files, parts = _files_of(*indexed)
    # Features in files wholly inside the area, from the index without a read.
    inside = inside_rows(indexed[1], boxes)
    if sample_only:
        # A few rows of what a fetch with these filters would write. Not over an
        # area no fetch reads: a selective filter would scan all of it.
        if not files or inside > MAX_READ_FEATURES:
            return {
                "key": None,
                "total": 0,
                "values": [],
                "columns": [],
                "rows": [],
                "too_large": bool(files),
            }
        return _sample_rows(
            con,
            src,
            files,
            table,
            envelope,
            feature_type,
            limit,
            tag_filters,
            match_mode,
            where,
        )
    if columns_only:
        # What a fetch would write here, for the nodes after it to be set up.
        named = output_columns(con, files, src, feature_type) if files else []
        return {
            "key": None,
            "total": 0,
            "values": [],
            "columns": [{"name": n, "type": t} for n, t in named],
            "geometry_type": src.geometry_of(feature_type),
        }
    if not files:
        return {"key": key, "total": 0, "values": [], "estimate": 0}
    if size_only:
        # Files wholly inside count from the index; the row groups are read only when that is not enough.
        if inside > MAX_READ_FEATURES:
            estimate, too_large = inside, True
        else:
            estimate, geometry = area_size(con, row_groups(con, files, src.geom), boxes)
            too_large = _too_large(estimate, geometry)
        # With filters, how many match: counted where the area can be read, and
        # over the read limit at most the build's counts, which may let it through.
        filters = [] if where else _filters_of(tag_filters)
        matches, bound = None, False
        # Up to the ceiling, filters with values may still make an area too large fit.
        can_fit = not too_large or filters_can_fit(con, indexed, files, boxes, src.geom)
        if filters and too_large and can_fit:
            matches = counted_matches(
                con, indexed, src, feature_type, filters, match_mode
            )
            bound = True
            too_large = matches is None or matches > MAX_FEATURES
        elif filters and not too_large:
            matches = _matching_rows(
                con, files, src, feature_type, envelope, boxes, filters, match_mode
            )
        return {
            "key": None,
            "total": 0,
            "complete": True,
            "estimate": estimate,
            "too_large": too_large,
            "matches": matches,
            "matches_bound": bound,
            "filters_can_fit": can_fit,
            "values": [],
        }
    if quick and (src.tagged or key is not None):
        built = _build_values(con, indexed, key)
        if built is not None and key is None:
            # Hidden as in the full list: names, and sub-keys such as addr:street.
            built = [
                (t, n) for t, n in built if t not in IDENTIFIER_TAGS and ":" not in t
            ]
        if built is not None:
            # Per-country counts: shown without numbers, exact ones follow under the cap.
            in_view, _ = area_size(
                con, row_groups(con, files, src.geom), boxes, SUGGESTION_ROWS
            )
            big = in_view > SUGGESTION_ROWS
            values = [{"value": str(v), "count": 0} for v, _ in built[: int(limit)]]
            return {
                "key": key,
                "total": len(values),
                "sampled": big,
                "complete": big,
                "estimate": in_view if key is None else None,
                "values": values,
            }
    # With the key list: lets the form refuse an area over the cap before a fetch.
    estimate = None
    if key is None:
        groups = row_groups(con, files, src.geom)
        estimate, _ = area_size(con, groups, boxes, SUGGESTION_ROWS)
        if src.tagged and estimate > SUGGESTION_ROWS:
            return _big_view_keys(con, groups, envelope, estimate)

    if not src.tagged and key is None:
        # The curated fields, without reading the area.
        fields = OVERTURE_FIELDS.get(OVERTURE_TYPES[feature_type][0], {})
        return {
            "key": None,
            "total": len(fields),
            "sampled": False,
            "complete": True,
            "estimate": estimate,
            "values": [{"value": name, "count": 0} for name in fields],
        }
    if not src.tagged:
        # Read whole already: a quick ask needs no second, full one.
        return {
            **_column_values(con, src, files, feature_type, envelope, key, limit),
            "complete": True,
        }
    storage = tag_storage(mirror_columns(con, files))

    # Every feature's tags in the area, parsed once and kept. Building it is the
    # slow part -- the whole area is read and every hstore parsed -- and the
    # form asks repeatedly: the keys, then the values of each key a user tries.
    # Without this each of those reads the same rows from the mirror again.
    cache = None
    cache_key = hashlib.sha256(json.dumps(area, sort_keys=True).encode()).hexdigest()
    try:
        cache = _tag_cache_path(cache_key, feature_type, parts, envelope)
    except OSError as e:
        logger.warning("tag cache disabled: %s", e)
    if (
        key is not None
        and not (cache is not None and cache.exists())
        and _key_column(con, files, key)
    ):
        # Uncached, a tag with its own column is counted from that column alone.
        rows, seen = _column_counts(con, files, envelope, key, limit)
        return {
            "key": key,
            "total": len(rows),
            "sampled": seen >= SUGGESTION_ROWS,
            "complete": True,
            "estimate": estimate,
            "values": [{"value": v, "count": n} for v, n in rows],
        }
    if quick and not (cache is not None and cache.exists()):
        con.execute(
            "CREATE OR REPLACE TEMP TABLE quick_tags AS "
            f"{_raw_tags_sql(files, envelope, 'TRUE', storage)} LIMIT {QUICK_ROWS}"
        )
        complete = (
            con.execute("SELECT count(*) FROM quick_tags").fetchone()[0] < QUICK_ROWS
        )
        # Fewer than the cap means the area was read whole: that is the full
        # answer, so it is kept as the cache and the caller needs no second read.
        # A capped one is never cached -- a partial read must not stand in for
        # the full list.
        if complete and cache is not None:
            # Per thread: the key and value lists may build the same cache at once.
            tmp = cache.with_suffix(f".{threading.get_ident()}.tmp.parquet")
            con.execute(f"COPY quick_tags TO '{tmp}' {parquet_copy_options()}")
            os.replace(tmp, cache)
        rows, _ = _count_tags(con, "SELECT * FROM quick_tags", key, limit, storage)
        con.execute("DROP TABLE quick_tags")
        return {
            "key": key,
            "total": len(rows),
            "sampled": not complete,
            "complete": complete,
            "estimate": estimate,
            "values": [{"value": v, "count": n} for v, n in rows],
        }
    if cache is not None and cache.exists():
        try:
            cache.touch()
        except OSError:
            pass
        source = f"SELECT * FROM read_parquet('{cache}')"
    else:
        # The envelope by each feature's bbox, not the area itself and not even
        # ST_Intersects: a key present just outside the boundary is present
        # inside it too. The extract still clips exactly; this only decides
        # what the dropdowns offer.
        source = (
            f"{_raw_tags_sql(files, envelope, 'TRUE', storage)} "
            f"LIMIT {SUGGESTION_ROWS}"
        )
        if cache is not None:
            tmp = cache.with_suffix(f".{threading.get_ident()}.tmp.parquet")
            con.execute(f"COPY ({source}) TO '{tmp}' {parquet_copy_options()}")
            os.replace(tmp, cache)
            source = f"SELECT * FROM read_parquet('{cache}')"

    # A capped read makes counts of a sample, not of the area; the caller is
    # told, so it never shows a sample's number as a total.
    sampled = (
        con.execute(f"SELECT count(*) FROM ({source})").fetchone()[0] >= SUGGESTION_ROWS
    )
    rows, _ = _count_tags(con, source, key, limit, storage)
    if key is not None and not rows:
        # A key too rare for the sample: read only features carrying it.
        prefilter = _has_key_sql(key, storage)
        rows, seen = _count_tags(
            con,
            f"{_raw_tags_sql(files, envelope, prefilter, storage)} "
            f"LIMIT {RARE_KEY_ROWS}",
            key,
            limit,
            storage,
        )
        sampled = seen >= RARE_KEY_ROWS
    return {
        "key": key,
        "total": len(rows),
        "sampled": sampled,
        "estimate": estimate,
        "values": [{"value": v, "count": n} for v, n in rows],
    }
