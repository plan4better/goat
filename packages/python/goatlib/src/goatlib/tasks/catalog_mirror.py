"""Build the query-shaped catalog mirror from published stac-geoparquet.

The harvester publishes native stac-geoparquet at the bucket root --
``items.parquet`` (one row per STAC Item, ``properties.*`` promoted to
top-level columns, ``assets``/``links`` as real STRUCTs) and
``collections.parquet`` (one row per Collection). ``apps/catalog`` reads
``mirror_items.parquet`` + ``mirror_collections.parquet``: the same rows, every
published column passed through under its published name, plus the columns a
search needs and a published file cannot have -- collection fields
denormalised onto their items, a lowercased ``search_text``, envelope scalars,
and precomputed bundle membership.

This module is that build. It runs at sync time, not per request, so the
service reads local files and knows nothing about the published layout.

Two properties are deliberate:

**Everything is derived from the observed columns.** The published schema is
not ours to pin, and it has already changed twice in a day (``language``
appeared on items, ``license``/``providers``/``themes`` on collections, the
``type`` column went away). So the column list comes from ``DESCRIBE``: every
published column is passed through under its published name, a derived
expression over a column that is absent yields ``NULL`` rather than a SQL
error, and a *new* published column is served as a ``properties.*`` member --
and picked up by ``catalog.services.registry`` as a queryable -- with no code
change on either side.

**The join denormalises.** ``license`` and ``providers`` live on the
Collection, never on the Item, but the catalog page facets *datasets* by
licence and publisher. Doing that join here -- once per harvest -- is what
lets every request stay a single-relation scan.

Items and collections stay in **separate files**, as they are published and as
pgstac stores them: merged, every item query would carry a discriminator
predicate over rows it can never return, and the schema would be the union of
both. Measured over 1.77M rows, separate relations won on every query shape.

The remaining derived columns exist only to keep request-time work off the hot
path, measured at the 1M-item target:

- ``search_text`` is one lowercased column holding title, description,
  keywords and publisher. It is what free-text scans; it replaced a full-text
  index that cost 1.8 GB resident and a rebuild in every pod on every swap.
- ``goat:geographical_code`` and the other facet columns are real columns
  rather than paths into a JSON blob: filtering through a JSON path cost 1.4 s
  per query at 1M rows versus 2.6 ms as a column.
- ``member_count`` precomputes
  bundle membership, which a per-request ``GROUP BY`` was recomputing over
  every item row (~1 GB of hash table) on data fixed between harvests.
- ``bbox_xmin``/``ymin``/``xmax``/``ymax`` (and the ``group_*`` pair) are the
  envelopes as plain doubles, which a spatial filter tests before it calls
  ``ST_Intersects``: measured at 1M rows, that took a bbox search from 89 ms to
  10 ms, and unlike a geometry column these give parquet row-group statistics
  to prune with.

What the mirror deliberately does **not** store is the rendered STAC document.
Caching it cost 69% of the file and 3.2 GB of the build's peak memory, to save
a transformation the service performs on every response anyway.
"""

from __future__ import annotations

import logging
from pathlib import Path

import duckdb

logger = logging.getLogger(__name__)

__all__ = [
    "COLLECTIONS_FILENAME",
    "MIRROR_FORMAT_VERSION",
    "GUARANTEED_COLLECTION_COLUMNS",
    "GUARANTEED_ITEM_COLUMNS",
    "ITEMS_FILENAME",
    "build_mirror",
]

#: Bumped whenever this converter's OUTPUT changes for unchanged input.
#:
#: ``sync_catalog`` skips work when the published ETags match what it last built
#: from — which is correct for data changes and wrong for *code* changes: a new
#: derivation here leaves every deployment serving the old mirror, because the
#: inputs it hashes did not move. Folding this into that marker is what turns a
#: bump into exactly one forced rebuild everywhere.
#:
#: v2: items inherit their collection's description and keywords.
#: v3: dropped `is_representative`/`group_geometry`/`group_bbox_*` — a dataset
#:     list asks the collections relation, so nothing designates a member.
#: v4: `datetime_start`/`datetime_end` — a temporal INTERVAL per row, so a
#:     `start_datetime`/`end_datetime` item and a Collection whose
#:     `extent.temporal` states a real range are matched by overlap instead of
#:     being reduced to one instant.
#: v5: `goat:geometryType` on a Collection — its layers' geometry type where
#:     they agree on one, so a dataset card can show what shape the data is
#:     without fetching its members.
#: v6: a Collection's temporal interval is its LAYERS' dates unless its own
#:     `extent.temporal` states a closed one.
#: v7: `thumbnail_item` — which layer's thumbnail stands for the dataset, so a
#:     dataset card has a picture without fetching its members.
#: v8: items inherit their collection's `attribution` — the notice an
#:     attribution licence obliges the user to reproduce. It is published on the
#:     Collection only, and has to reach a layer the way `license` does.
#: v9: `goat:topicRelevance` on a Collection — Plan4Better's topic relevance
#:     tier — with `goat:topicRelevanceScore`, the same judgement as a number so
#:     ordering needs no knowledge of that vocabulary. Higher is better.
MIRROR_FORMAT_VERSION = 9

ITEMS_FILENAME = "items.parquet"
COLLECTIONS_FILENAME = "collections.parquet"

#: Columns every mirror carries, whatever the published file contains.
#:
#: Passthrough alone is not enough: `apps/catalog` names these in its own SQL
#: (``ORDER BY updated``, ``datetime >= ?``, the facets), so a published file
#: that happens to omit one would produce a mirror the service cannot query.
#: They are emitted as typed NULLs instead, which keeps the schema stable and
#: turns "the harvester dropped a column" into empty results rather than a
#: binder error mid-request.
_GUARANTEED_SHARED: tuple[tuple[str, str], ...] = (
    ("title", "VARCHAR"),
    ("description", "VARCHAR"),
    ("license", "VARCHAR"),
    ("category", "VARCHAR"),
    ("language_code", "VARCHAR"),
    ("publisher", "VARCHAR"),
    ("search_text", "VARCHAR"),
    ("updated", "TIMESTAMPTZ"),
)
GUARANTEED_ITEM_COLUMNS: tuple[tuple[str, str], ...] = (
    *_GUARANTEED_SHARED,
    ("collection", "VARCHAR"),
    ("datetime", "TIMESTAMPTZ"),
    ("datetime_start", "TIMESTAMPTZ"),
    ("datetime_end", "TIMESTAMPTZ"),
    ("created", "TIMESTAMPTZ"),
    ("parquet_url", "VARCHAR"),
    ("goat:layerType", "VARCHAR"),
    ("goat:geometryType", "VARCHAR"),
    ("goat:geographical_code", "VARCHAR"),
)
GUARANTEED_COLLECTION_COLUMNS: tuple[tuple[str, str], ...] = (
    *_GUARANTEED_SHARED,
    ("datetime", "TIMESTAMPTZ"),
    ("datetime_start", "TIMESTAMPTZ"),
    ("datetime_end", "TIMESTAMPTZ"),
    # Named in the service's own ORDER BY, so an older file yields typed NULLs.
    ("goat:topicRelevance", "VARCHAR"),
    ("goat:topicRelevanceScore", "BIGINT"),
)

#: Physical row order of the written files -- what a reader's row-group
#: pruning has to work with, since the service queries the parquet through a
#: view rather than loading it into a table.
#:
#: `updated DESC` first because it is the default sort of every listing, so
#: the first page comes out of the first row group. `collection` second is
#: nearly free and buys per-collection pruning: in the real catalog a
#: collection's items all share one harvest timestamp (median 1 distinct
#: `updated` per collection), so a collection's rows stay contiguous inside a
#: timestamp run. Both columns are guaranteed, so this always binds.
#:
#: Honest scope: at today's 10.8k items each file is a *single* row group, so
#: this changes nothing yet -- it starts paying above DuckDB's 122,880-row
#: group size, on the way to the 500k-1M target. Measured gains at a synthetic
#: 1M rows are ~1.2-1.6x over unsorted across listing/bbox/free-text shapes.
_ITEM_CLUSTER_ORDER = "updated DESC NULLS LAST, collection NULLS LAST, id"
_COLLECTION_CLUSTER_ORDER = "updated DESC NULLS LAST, id"


def _columns(con: duckdb.DuckDBPyConnection, path: Path) -> dict[str, str]:
    rows = con.execute(
        "DESCRIBE SELECT * FROM read_parquet(?)", [path.as_posix()]
    ).fetchall()
    return {row[0]: row[1] for row in rows}


def _quoted(name: str) -> str:
    """Quote an identifier -- published names contain colons."""
    escaped = name.replace('"', '""')
    return f'"{escaped}"'


def _ref(name: str, alias: str = "") -> str:
    """A column reference, table-qualified when an alias is given.

    Qualification is required on the item side: the mirror joins items to
    collections and the two share column names (``id``, ``title``,
    ``stac_extensions``, ...), so a bare reference is ambiguous.
    """
    return f"{alias}.{_quoted(name)}" if alias else _quoted(name)


def _opt(
    columns: dict[str, str],
    name: str,
    expr: str | None = None,
    alias: str = "",
) -> str:
    """``expr`` when ``name`` is present in the file, else ``NULL``."""
    if name not in columns:
        return "NULL"
    return expr if expr is not None else _ref(name, alias)


def _text(expr: str) -> str:
    """Force a derived scalar to VARCHAR.

    A column the published file lacks degrades to a bare ``NULL``, which DuckDB
    types as INTEGER -- so the mirror would carry, say, an integer
    ``language_code``. The registry classifies by type, so that column silently
    stops being facetable, and a CQL2 filter on it compares against the wrong
    type. Casting keeps the schema stable whether or not the source has it.
    """
    return f"CAST({expr} AS VARCHAR)"


def _probe(con: duckdb.DuckDBPyConnection, path: Path, expr: str, alias: str) -> str:
    """``expr`` if it actually binds against this file, else ``NULL``.

    :func:`_opt` only checks that a *column* exists, which is not enough for the
    nested paths this converter reads (``assets.data.href``,
    ``summaries.updated.maximum``, ``providers[1].name``,
    ``themes[1].concepts[1].id``, ``extent.spatial.bbox[1][1]``). A published
    STRUCT whose member list differs is a **bind error that fails the whole
    build**, not a NULL -- and that is not hypothetical: the collections
    captured from the bucket in ``tests/fixtures/real`` carry a ``summaries``
    struct with no ``updated`` member, which took the mirror down entirely.

    Since the published schema is not ours to pin, the only reliable test is to
    ask DuckDB. This binds the expression against zero rows once per expression
    at build time -- no per-row cost, and it tolerates any shape change in the
    published structs, not just the ones we thought to anticipate.
    """
    try:
        con.execute(
            f"SELECT {expr} FROM read_parquet('{path.as_posix()}') {alias} LIMIT 0"
        )
    except duckdb.Error:
        logger.info("published schema lacks %s; emitting NULL", expr)
        return "NULL"
    return expr


def _geometry_expr(columns: dict[str, str], alias: str = "") -> str:
    """A geometry-typed expression for the geometry column, or ``NULL``.

    DuckDB only surfaces a parquet geometry column as ``GEOMETRY`` when the
    file carries GeoParquet ``geo`` metadata; without it the same bytes read
    back as ``BLOB`` (raw WKB) and every spatial function refuses them. The
    published ``items.parquet`` does carry that metadata -- but
    ``collections.parquet`` does not, so the two spellings already coexist
    upstream and a converter that assumed one of them would break on the
    other.
    """
    if "geometry" not in columns:
        return "NULL"
    ref = _ref("geometry", alias)
    if columns["geometry"].strip().upper().startswith("BLOB"):
        return f"ST_GeomFromWKB({ref})"
    return ref


def _keywords_text(columns: dict[str, str], alias: str = "") -> str:
    """``keywords`` as a plain string, whatever shape it is published in.

    STAC's ``keywords`` is an array of strings, but the flat mirror has also
    seen it published as a single string; both flatten to text here so
    :func:`_search_text_expr` does not have to care.
    """
    if "keywords" not in columns:
        return "NULL"
    ref = _ref("keywords", alias)
    declared = columns["keywords"].strip().upper()
    if declared.endswith("[]") or declared.startswith("LIST"):
        return f"array_to_string({ref}, ' ')"
    return f"{ref}::VARCHAR"


def _keywords_list_expr(items: dict[str, str], collections: dict[str, str]) -> str:
    """``keywords`` as a list, inherited from the collection when the item has none.

    Kept separate from :func:`_keywords_text` because the mirror needs both
    spellings: a list for the column the served document passes through, and flat
    text for the free-text haystack.

    Only coalesces when both files declare a list. STAC says array-of-string but
    the flat mirror has seen a bare string published, and mixing the two in one
    COALESCE is a bind error that takes the whole build down -- so a mismatch
    keeps the item's own value rather than risking that.
    """

    def is_list(columns: dict[str, str]) -> bool:
        declared = columns.get("keywords", "").strip().upper()
        return declared.endswith("[]") or declared.startswith("LIST")

    if not is_list(items):
        return _opt(items, "keywords", alias="i")
    if not is_list(collections):
        return _ref("keywords", "i")
    return f'COALESCE({_ref("keywords", "i")}, {_ref("keywords", "c")})'


def _temporal_interval(columns: dict[str, str], alias: str = "") -> tuple[str, str]:
    """``(start, end)`` for a row's temporal extent, as TIMESTAMPTZ expressions.

    STAC gives an Item two mutually exclusive spellings: a single ``datetime``, or
    ``datetime: null`` with ``start_datetime``/``end_datetime`` for a range. Both
    collapse to an interval here so the service compares intervals and nothing
    downstream has to know which spelling a row used. A closed instant is simply
    an interval of zero length.

    Reducing a range to one instant is the trap this exists to avoid: taking the
    END of a range would make a dataset covering 2014-2021 invisible to a search
    for 2014-2016, and taking the start would hide it from 2019-2021.
    """
    instant = _opt(columns, "datetime", alias=alias)
    start = _opt(columns, "start_datetime", alias=alias)
    end = _opt(columns, "end_datetime", alias=alias)
    lower = instant if start == "NULL" else f"COALESCE({start}, {instant})"
    upper = instant if end == "NULL" else f"COALESCE({end}, {instant})"
    return f"TRY_CAST({lower} AS TIMESTAMPTZ)", f"TRY_CAST({upper} AS TIMESTAMPTZ)"


def _collection_interval(
    con: duckdb.DuckDBPyConnection, path: Path, columns: dict[str, str]
) -> tuple[str, str]:
    """A Collection's temporal extent as ``(start, end)``.

    STAC gives a Collection ``extent.temporal.interval`` -- a LIST of intervals,
    each ``[start, end]`` with null meaning open-ended. The whole extent is the
    earliest start to the latest end, so this unnests rather than reading
    ``interval[1][1]``: that expression takes the END of the FIRST interval, which
    turns a dataset covering 2014-2021 into an instant at 2021 and hides it from
    every search before that year.

    Falls back to the row's own ``datetime`` where the published file has no
    usable extent -- which was the whole catalog until 2026-08-04 (``[[null,
    null]]`` on all 3,834) and is none of it since.
    """
    instant = _opt(columns, "datetime")
    lower = (
        "COALESCE("
        "(SELECT min(TRY_CAST(i[1] AS TIMESTAMPTZ)) FROM unnest(extent.temporal.interval) AS t(i)), "
        f"TRY_CAST({instant} AS TIMESTAMPTZ))"
    )
    upper = (
        "COALESCE("
        "(SELECT max(TRY_CAST(i[2] AS TIMESTAMPTZ)) FROM unnest(extent.temporal.interval) AS t(i)), "
        f"TRY_CAST({instant} AS TIMESTAMPTZ))"
    )
    return (
        _probe(con, path, lower, ""),
        _probe(con, path, upper, ""),
    )


def _search_text_expr(
    columns: dict[str, str],
    alias: str = "",
    *,
    description: str | None = None,
    keywords: str | None = None,
) -> str:
    """One lowercase haystack per row, for the free-text (``q``) filter.

    Precomputed here rather than assembled per query for two reasons: the
    service scans this single column instead of three (a projection of ~80 MB
    at 1M items rather than the whole file), and the concatenation + case
    folding happen once per harvest instead of once per request.

    The fields are the ones the STAC free-text extension names -- title,
    description, keywords -- and nothing else. Widening it to publisher or
    category would make ``q`` quietly overlap the facet filters, so those stay
    separately filterable instead.

    ``description``/``keywords`` override where those two come from, which is how
    an item borrows its dataset's text. It matters more than it sounds: the
    harvester publishes both **only on the Collection**, so an item-only haystack
    is the title and nothing else -- measured at 44 characters per item against
    655 per collection, i.e. ~93% of the catalog's searchable prose invisible to
    ``q``.

    ``concat_ws`` skips NULL arguments, so a row missing any of the three still
    produces a usable haystack rather than NULL.
    """
    parts = [
        _opt(columns, "title", alias=alias),
        description
        if description is not None
        else _opt(columns, "description", alias=alias),
        keywords if keywords is not None else _keywords_text(columns, alias),
    ]
    present = [p for p in parts if p != "NULL"]
    if not present:
        return "NULL"
    return f"lower(concat_ws(' ', {', '.join(present)}))"


def _envelope_columns(geom_expr: str, prefix: str = "bbox") -> str:
    """Four ``DOUBLE`` envelope columns for a geometry expression.

    Cheap numeric comparisons on these eliminate almost every row before the
    exact ``ST_Intersects`` runs, and -- being plain scalars -- they also land in
    the parquet's per-row-group min/max statistics, so whole row groups can be
    skipped without being read.
    """
    if geom_expr == "NULL":
        return ", ".join(
            f"NULL::DOUBLE AS {prefix}_{part}"
            for part in ("xmin", "ymin", "xmax", "ymax")
        )
    return ", ".join(
        f"ST_{fn}({geom_expr}) AS {prefix}_{part}"
        for fn, part in (
            ("XMin", "xmin"),
            ("YMin", "ymin"),
            ("XMax", "xmax"),
            ("YMax", "ymax"),
        )
    )


def _first_theme(columns: dict[str, str], alias: str = "") -> str:
    """The dataset's category: the first concept of the first theme block.

    Read from the item first and the collection second (see the item SELECT's
    ``COALESCE``). Category is a dataset-level attribute, like ``license`` and
    ``publisher`` which only exist on the collection, so the collection is the
    natural fallback -- and it keeps the facet working if item-level ``themes``
    ever disappears the way the item ``type`` column did.
    """
    return _opt(columns, "themes", f"{_ref('themes', alias)}[1].concepts[1].id")


def _fill_missing(
    produced: set[str], guaranteed: tuple[tuple[str, str], ...]
) -> list[str]:
    """Typed NULLs for guaranteed columns the source did not supply."""
    return [
        f"NULL::{sql_type} AS {_quoted(name)}"
        for name, sql_type in guaranteed
        if name not in produced
    ]


def _passthrough(columns: dict[str, str], alias: str, exclude: set[str]) -> list[str]:
    """Every published column, verbatim, minus the ones we replace.

    Passthrough rather than re-encoding is the whole point of dropping the
    ``document`` blob: the published file already types ``assets``/``links``/
    ``table:columns`` as real STRUCTs, and the service rebuilds the STAC JSON
    from them per response. A property the harvester adds tomorrow flows
    through here with no code change -- the same drift-tolerance the blob gave,
    without paying to render 1.3 GB of JSON at every harvest.
    """
    return [
        f"{_ref(name, alias)} AS {_quoted(name)}"
        for name in columns
        if name not in exclude
    ]


def build_mirror(
    items_path: Path,
    collections_path: Path,
    out_items: Path,
    out_collections: Path,
    con: duckdb.DuckDBPyConnection | None = None,
) -> tuple[int, int]:
    """Write the two mirror files; returns ``(item rows, collection rows)``.

    Items and collections stay in separate files, as they are published and as
    pgstac stores them. Merged into one table they would need a schema that is
    the union of both -- ``extent``/``providers``/``summaries`` null on every
    item row, ``assets``/``table:columns`` null on every collection row -- and
    every item query would carry a discriminator predicate over rows it can
    never return. Measured over 1.77M rows, separate relations were faster on
    every query shape (facet filters 0.37x, collection listing 0.38x).

    ``con`` is injectable so a caller that already has a DuckDB connection
    (with the spatial/json extensions loaded) can reuse it.
    """
    owns_connection = con is None
    if con is None:
        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        con.execute("INSTALL json; LOAD json;")
    try:
        items = _columns(con, items_path)
        collections = _columns(con, collections_path)
        logger.info(
            "building mirror from %d item columns and %d collection columns",
            len(items),
            len(collections),
        )

        def item_expr(expr: str) -> str:
            return _probe(con, items_path, expr, "i")

        def coll_expr(expr: str) -> str:
            return _probe(con, collections_path, expr, "c")

        # Denormalised from the Collection onto every item row: the catalog page
        # facets *datasets* by licence and publisher, and neither exists on a
        # published item. Doing the join once per harvest is what keeps a
        # faceted search a single-relation scan.
        publisher = coll_expr(_opt(collections, "providers", "c.providers[1].name"))
        layer_type = "COALESCE({}, {}, 'feature')".format(
            item_expr(_opt(items, "goat:layerType", 'i."goat:layerType"')),
            coll_expr(_opt(collections, "goat:layerType", 'c."goat:layerType"')),
        )
        # Description and keywords are published on the Collection ONLY -- 0 of
        # 10,793 items carry either, while 3,834 of 3,834 collections carry a
        # description and 96% carry keywords. Inheriting them here is what lets a
        # result card show what a dataset is, and what puts the catalog's prose
        # into `q`'s reach at all.
        description = "COALESCE({}, {})".format(
            item_expr(_opt(items, "description", "i.description")),
            coll_expr(_opt(collections, "description", "c.description")),
        )
        keywords_text = "COALESCE({}, {})".format(
            _keywords_text(items, "i"),
            _probe(con, collections_path, _keywords_text(collections, "c"), "c"),
        )
        # The *column* has to stay a list, since that is what STAC `keywords` is
        # and what the served document passes through -- only the haystack above
        # gets the flattened text. Both sides are only coalesced when both are
        # declared as lists; a published string on one side would otherwise make
        # the COALESCE a bind error that fails the whole build.
        keywords_column = _keywords_list_expr(items, collections)
        geographical_code = "COALESCE({}, {})".format(
            item_expr(
                _opt(items, "goat:geographical_code", 'i."goat:geographical_code"')
            ),
            coll_expr(
                _opt(
                    collections, "goat:geographical_code", 'c."goat:geographical_code"'
                )
            ),
        )

        # Names we compute ourselves and therefore must not also pass through.
        # Everything else keeps its published name, so `goat:geometryType` stays
        # `goat:geometryType` -- the column and the STAC property it becomes are
        # the same word, and the registry seeds already know it.
        # `datetime` itself stays a passthrough — it is what STAC serves and what
        # the UI shows as the data date. These two are derived beside it.
        item_start, item_end = (
            _probe(con, items_path, expr, "i")
            for expr in _temporal_interval(items, "i")
        )
        collection_start, collection_end = _collection_interval(
            con, collections_path, collections
        )

        item_derived = {
            "geometry",
            "datetime_start",
            "datetime_end",
            "goat:layerType",
            "goat:geographical_code",
            "license",
            "attribution",
            "publisher",
            "category",
            "description",
            "keywords",
            "search_text",
            "parquet_url",
            "language_code",
        }
        item_select = f"""
            SELECT
                {", ".join(_passthrough(items, "i", item_derived))},
                {_geometry_expr(items, "i")}                  AS geometry,
                {_text(layer_type)}                           AS "goat:layerType",
                {_text(geographical_code)}                    AS "goat:geographical_code",
                {_text(f"COALESCE({item_expr(_opt(items, 'license', 'i.license'))}, "
                       f"{coll_expr(_opt(collections, 'license', 'c.license'))})")} AS license,
                {_text(f"COALESCE({item_expr(_opt(items, 'attribution', 'i.attribution'))}, "
                       f"{coll_expr(_opt(collections, 'attribution', 'c.attribution'))})")} AS attribution,
                {_text(publisher)}                             AS publisher,
                {_text(f"COALESCE({item_expr(_first_theme(items, 'i'))}, "
                       f"{coll_expr(_first_theme(collections, 'c'))})")} AS category,
                {_text(description)}                          AS description,
                {keywords_column}                             AS keywords,
                {_text(_search_text_expr(items, "i", description=description, keywords=keywords_text))} AS search_text,
                {item_start}                                  AS datetime_start,
                {item_end}                                    AS datetime_end,
                {_text(item_expr(_opt(items, "language", "i.language.code")))} AS language_code,
                {_text(item_expr(_opt(items, "assets", "i.assets.data.href")))} AS parquet_url
            FROM read_parquet('{items_path.as_posix()}') i
            LEFT JOIN read_parquet('{collections_path.as_posix()}') c
                ON c.id = i.collection
        """

        # A Collection's spatial extent is a bbox, not a geometry column, so the
        # mirror's geometry is that envelope. Collection-level spatial filtering
        # is therefore bbox-precise, which is all a STAC extent is.
        collection_geometry = _probe(
            con,
            collections_path,
            _opt(
                collections,
                "extent",
                "ST_MakeEnvelope(extent.spatial.bbox[1][1], extent.spatial.bbox[1][2],"
                " extent.spatial.bbox[1][3], extent.spatial.bbox[1][4])",
            ),
            "",
        )
        collection_derived = {
            "datetime_start",
            "datetime_end",
            "geometry",
            "datetime",
            "publisher",
            "category",
            "search_text",
            "updated",
            "language_code",
        }
        collection_select = f"""
            SELECT
                {", ".join(_passthrough(collections, "", collection_derived))},
                {collection_geometry}                          AS geometry,
                {_text(_probe(con, collections_path, _opt(collections, "providers", "providers[1].name"), ""))} AS publisher,
                {_text(_probe(con, collections_path, _first_theme(collections), ""))} AS category,
                {_text(_search_text_expr(collections))}        AS search_text,
                {_text(_probe(con, collections_path, _opt(collections, "language", "language.code"), ""))} AS language_code,
                {_probe(con, collections_path, _opt(collections, "summaries", "TRY_CAST(summaries.updated.maximum AS TIMESTAMPTZ)"), "")} AS updated,
                COALESCE({collection_end}, {collection_start})  AS datetime,
                {collection_start}                             AS datetime_start,
                {collection_end}                               AS datetime_end
            FROM read_parquet('{collections_path.as_posix()}')
        """

        # How many layers the dataset has, precomputed per member row.
        #
        # `is_representative`, `group_geometry` and `group_bbox_*` used to live
        # here too, to let Item Search stand in for a dataset list: one
        # designated member per bundle, with the bundle's union envelope for
        # spatial filters. That was wrong in a way the columns could not fix --
        # filtering the designated member drops a dataset whose *other* layer
        # matched (228 of the 1,886 datasets containing a polygon layer). A
        # dataset list asks the collections relation now, where a member
        # predicate is a semi-join, so nothing reads them.
        item_produced = (set(items) - item_derived) | item_derived
        collection_produced = (
            set(collections) - collection_derived
        ) | collection_derived
        item_fill = _fill_missing(item_produced, GUARANTEED_ITEM_COLUMNS)
        collection_fill = _fill_missing(
            collection_produced, GUARANTEED_COLLECTION_COLUMNS
        )
        if item_fill:
            item_select = f"SELECT *, {', '.join(item_fill)} FROM ({item_select})"
        if collection_fill:
            collection_select = (
                f"SELECT *, {', '.join(collection_fill)} FROM ({collection_select})"
            )

        counted_items = f"""
            SELECT
                * EXCLUDE (group_key),
                {_envelope_columns("geometry")},
                count(*) OVER (PARTITION BY group_key)          AS member_count
            FROM (
                SELECT *, coalesce(collection, id) AS group_key
                FROM ({item_select})
            )
        """
        # A collection row is not a bundle member, so it carries the count of
        # its own items (what `/stac/resolve` used to run a second query for).
        # A Collection publishes no geometry type of its own -- it is a property of
        # a layer, and `summaries` carries only `updated` on the live bucket. So it
        # is resolved from the members here: the type they agree on, or NULL.
        #
        # Every member must state the SAME type and none may be silent, which
        # costs 6 datasets against the looser reading (ignore the silent ones) and
        # buys a column that cannot overstate what a bundle contains. Resolution
        # over the live bucket's 3,834 datasets: 1,478 point, 1,383 polygon, 306
        # line, 667 NULL (569 genuinely mixed, 92 with nothing published).
        #
        # This is a *display* column, deliberately hidden from the collections
        # queryables. Filtering datasets by geometry is a question about members
        # ("datasets with a polygon layer"), which only the semi-join answers --
        # against this column a mixed bundle holding polygons would be dropped.
        member_geometry = _probe(
            con,
            items_path,
            _opt(items, "goat:geometryType", 'i."goat:geometryType"'),
            "i",
        )
        # A Collection publishes no thumbnail of its own -- 3,834 of them carry
        # only the `collection-mirror` asset -- while 1,021 of the 10,793 layers
        # do. So a dataset borrows one of its layers': `thumbnail_item` records
        # which, and the API turns that into an asset href pointing at the layer
        # that owns the object.
        #
        # `min` rather than "the first": a parquet has no row order, so anything
        # else would let two builds of the same data disagree about which picture
        # a card shows.
        member_thumbnail = _probe(
            con, items_path, _opt(items, "assets", "i.assets.thumbnail.href"), "i"
        )
        # A dataset's period: its own `extent.temporal` when that states a CLOSED
        # interval, otherwise the envelope of its layers' dates.
        #
        # Both halves are needed, and which wins is decided by the shape of the
        # published value rather than by the spec's hierarchy:
        #
        # * An open-ended extent -- `[start, null]` on 3,766 of 3,834 collections,
        #   with the start in the harvest year on 799 -- is not a statement about
        #   coverage. Trusting it made a single-layer dataset from 2001 announce
        #   itself as "since 2001" and a 2021 dataset claim it had been collected
        #   since 2026. Its layers' dates are the reference dates of the data
        #   (1,554 distinct values from 1801 to 2026), so they answer instead.
        # * A closed extent IS such a statement, and 44 of the 64 that exist are
        #   wider than their layers' span: `Seismik NRW` covers 1935-2025 where its
        #   one layer is dated 1935, and `HWRM-Karten 1. Zyklus Hamburg` 2013-2019
        #   where its layer is dated 2013. Reading the layers there would throw the
        #   dataset's actual coverage away.
        #
        # Same values the filter uses, so a card cannot show one period while
        # `?datetime=` matches another.
        member_start, member_end = (
            _probe(con, items_path, expr, "i")
            for expr in _temporal_interval(items, "i")
        )
        counted_collections = f"""
            SELECT
                c.* EXCLUDE (datetime, datetime_start, datetime_end),
                {_envelope_columns("c.geometry")},
                coalesce(m.member_count, 0)                     AS member_count,
                m.member_geometry_type                          AS "goat:geometryType",
                m.thumbnail_item                                AS thumbnail_item,
                CASE
                    WHEN c.datetime_start IS NOT NULL AND c.datetime_end IS NOT NULL
                    THEN c.datetime_start
                    ELSE coalesce(m.member_start, c.datetime_start)
                END                                             AS datetime_start,
                CASE
                    WHEN c.datetime_start IS NOT NULL AND c.datetime_end IS NOT NULL
                    THEN c.datetime_end
                    ELSE coalesce(m.member_end, c.datetime_end)
                END                                             AS datetime_end,
                CASE
                    WHEN c.datetime_start IS NOT NULL AND c.datetime_end IS NOT NULL
                    THEN c.datetime_end
                    ELSE coalesce(m.member_end, m.member_start, c.datetime_start)
                END                                             AS datetime
            FROM ({collection_select}) c
            LEFT JOIN (
                SELECT
                    collection,
                    count(*) AS member_count,
                    CASE
                        WHEN count(DISTINCT geometry_type) = 1
                             AND count(geometry_type) = count(*)
                        THEN any_value(geometry_type)
                    END AS member_geometry_type,
                    min(member_start) AS member_start,
                    max(member_end) AS member_end,
                    min(thumbnail_id) AS thumbnail_item
                FROM (
                    SELECT
                        i.collection,
                        {member_geometry} AS geometry_type,
                        {member_start} AS member_start,
                        {member_end} AS member_end,
                        CASE WHEN {member_thumbnail} IS NOT NULL THEN i.id END
                            AS thumbnail_id
                    FROM read_parquet('{items_path.as_posix()}') i
                )
                WHERE collection IS NOT NULL
                GROUP BY collection
            ) m ON m.collection = c.id
        """

        for out, query, order in (
            (out_items, counted_items, _ITEM_CLUSTER_ORDER),
            (out_collections, counted_collections, _COLLECTION_CLUSTER_ORDER),
        ):
            out.parent.mkdir(parents=True, exist_ok=True)
            con.execute(
                f"COPY (SELECT * FROM ({query}) ORDER BY {order}) "
                f"TO '{out.as_posix()}' (FORMAT PARQUET)"
            )

        def _count(path: Path) -> int:
            row = con.execute(
                "SELECT count(*) FROM read_parquet(?)", [path.as_posix()]
            ).fetchone()
            return int(row[0]) if row else 0

        return _count(out_items), _count(out_collections)
    finally:
        if owns_connection:
            con.close()
