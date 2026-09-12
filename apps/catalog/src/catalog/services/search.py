"""Item Search query engine: builds SQL against ``CatalogStore`` and runs it.

Encodes the STAC Item Search rules audited in ``docs/goat-catalog-api.md``
§2.1: ``bbox``/``intersects`` are mutually exclusive; ``datetime`` accepts a
full RFC 3339 instant or ``start/end``/``start/..``/``../end`` interval and
never silently drops an unparseable value; ``bbox`` is a pure
``ST_Intersects`` unless ``bbox_mode == "relevant"`` opts into the 30%-overlap
area heuristic; collection-type rows never surface as search results;
``bbox_boost`` ranks intersecting rows first WITHOUT excluding the rest (it
only ever affects ORDER BY, never WHERE).

The module aliases the stdlib ``datetime`` class as ``dt`` throughout because
``SearchParams.datetime`` is itself a field name on the model defined here.
"""

import json
import math
import re
from datetime import datetime as dt
from typing import Any, Literal

import duckdb
from pydantic import BaseModel, ConfigDict, Field

from catalog.errors import ApiError
from catalog.relevance import BBOX_AREA_SQL, RELEVANCE_RANK_SQL
from catalog.services.registry import Queryable, QueryableRegistry
from catalog.store import CatalogStore

_BBOX_MODES = ("strict", "relevant")


class SearchParams(BaseModel):
    """Item Search parameters (STAC core six + GOAT/CQL extensions)."""

    # A scalar filter that used to be its own field (`themes=`, `license=`,
    # ...) now travels in `fields`. Forbidding extras makes a stale keyword a
    # loud error instead of a filter that is silently dropped.
    model_config = ConfigDict(extra="forbid")

    collections: list[str] | None = None
    ids: list[str] | None = None
    bbox: list[float] | None = None  # 4 or 6 numbers
    intersects: dict[str, Any] | None = None  # GeoJSON geometry
    datetime: str | None = None  # RFC 3339 instant or interval
    q: str | None = None
    sortby: list[tuple[str, str]] | None = None  # [(field, 'asc'|'desc')]
    #: Scalar filters, ``{query-parameter name: comma-separated values}`` --
    #: e.g. ``{"license": "CC-BY-4.0", "themes": "transport,environment"}``.
    #: Which names are accepted is the registry's answer
    #: (``QueryableRegistry.filter_params``), derived from the loaded file, not
    #: a list enumerated here and again in every handler signature.
    fields: dict[str, str] = Field(default_factory=dict)
    cql: tuple[str, list[Any]] | None = None  # compiled fragment (Task 6)
    bbox_mode: str = "strict"
    nuts: list[str] | None = None  # NUTS region ids; intersect their geometry
    bbox_boost: list[float] | None = None  # rank intersecting rows first (4 or 6 nums)
    limit: int = 10
    offset: int = 0


#: RFC 3339 ``date-time``, which is what STAC requires for the ``datetime``
#: parameter -- stricter than ``datetime.fromisoformat``, which also accepts
#: date-only values, a missing offset, and ``+0100`` without the colon. The
#: ``[Tt]``/``[Zz]`` classes are deliberate: RFC 3339 permits the lowercase
#: separators, and rejecting them would fail conformant clients.
_RFC3339 = re.compile(
    r"^\d{4}-\d{2}-\d{2}"  # full-date
    r"[Tt]"
    r"\d{2}:\d{2}:\d{2}(\.\d+)?"  # partial-time (fraction needs >=1 digit)
    r"([Zz]|[+-]\d{2}:\d{2})$"  # time-offset
)


def parse_datetime_interval(s: str) -> tuple[dt | None, dt | None]:
    """Parse an RFC 3339 instant or interval into ``(start, end)``.

    Accepts a bare instant, ``start/end``, and an interval with either side
    open -- written as ``..`` **or** left empty (``start/``, ``/end``): both
    spellings are valid and clients use both.

    Validation is a strict RFC 3339 grammar check rather than a
    ``fromisoformat`` attempt, because ``fromisoformat`` is more permissive
    than the spec: it happily accepts date-only values, timestamps with no
    offset, and ``+0100`` without the colon. Silently accepting those makes
    the filter mean something the caller did not ask for, so each is a 400.
    A reversed interval (start after end) is a 400 too -- it can only ever
    match nothing, so answering 200 with an empty page would hide the typo.

    An instant is returned as ``(instant, instant)``: the caller treats an
    equal, non-None pair as "match this exact timestamp" (per spec, an
    instant means ``datetime == value``), not as a one-point range.
    """

    def _parse_one(part: str) -> dt:
        if not _RFC3339.match(part):
            raise ApiError(400, f"invalid RFC 3339 datetime: {part!r}")
        # fromisoformat needs an explicit offset; RFC 3339's Z/z is UTC.
        normalised = part[:-1] + "+00:00" if part[-1] in "Zz" else part
        try:
            return dt.fromisoformat(normalised.replace("t", "T", 1))
        except ValueError as exc:  # pragma: no cover -- regex already gates
            raise ApiError(400, f"invalid RFC 3339 datetime: {part!r}") from exc

    if "/" in s:
        parts = s.split("/")
        if len(parts) != 2:
            raise ApiError(400, f"invalid datetime interval: {s!r}")
        start_s, end_s = parts[0].strip(), parts[1].strip()
        # An empty side and ".." both mean "open" (spec allows either).
        start = None if start_s in ("", "..") else _parse_one(start_s)
        end = None if end_s in ("", "..") else _parse_one(end_s)
        if start is None and end is None:
            raise ApiError(400, f"invalid datetime interval: {s!r}")
        if start is not None and end is not None and start > end:
            raise ApiError(400, f"datetime interval ends before it starts: {s!r}")
        return start, end

    stripped = s.strip()
    if not stripped or stripped == "..":
        raise ApiError(400, f"invalid datetime: {s!r}")
    instant = _parse_one(stripped)
    return instant, instant


def _validate_bbox(bbox: list[float]) -> tuple[float, float, float, float]:
    if len(bbox) not in (4, 6):
        raise ApiError(400, f"bbox must have 4 or 6 numbers, got {len(bbox)}")
    if len(bbox) == 6:
        w, s, _min_elev, e, n, _max_elev = bbox
    else:
        w, s, e, n = bbox
    for value in (w, s, e, n):
        if math.isnan(value):
            raise ApiError(400, f"invalid bbox value: {bbox!r}")
    if not (-180.0 <= w <= 180.0) or not (-180.0 <= e <= 180.0):
        raise ApiError(400, f"bbox longitude out of range: {bbox!r}")
    if not (-90.0 <= s <= 90.0) or not (-90.0 <= n <= 90.0):
        raise ApiError(400, f"bbox latitude out of range: {bbox!r}")
    if s > n:
        raise ApiError(400, f"bbox south is greater than north: {bbox!r}")
    # west > east is NOT an error: per OGC/STAC it is a box crossing the
    # antimeridian, and the SQL builder splits it in two.
    return w, s, e, n


#: JSON type -> Python coercion for a scalar filter's values. A string-typed
#: queryable needs none; a numeric one must not be compared as text (DuckDB
#: would reject ``date_part(...) IN ('2024')``), and a value that cannot be
#: coerced is the caller's mistake, hence a 400 rather than a 500 later.
_VALUE_COERCION: dict[str, Any] = {"integer": int, "number": float}


def _scalar_filter(entry: Queryable, value: str, add: Any) -> str | None:
    """``<expr> IN (?, ...)`` for one comma-separated scalar filter value.

    Returns ``None`` for an all-blank value, which callers treat as "parameter
    not supplied" rather than "match nothing".
    """
    values: list[Any] = [v.strip() for v in value.split(",") if v.strip()]
    if not values:
        return None
    coerce = _VALUE_COERCION.get(entry.json_type)
    if coerce is not None:
        try:
            values = [coerce(v) for v in values]
        except ValueError as exc:
            raise ApiError(
                400, f"invalid {entry.param} value: {value!r} ({entry.json_type})"
            ) from exc
    placeholders = ", ".join(add(v) for v in values)
    return f"{entry.expr} IN ({placeholders})"


def _parse_q_terms(q: str | None) -> list[list[str]]:
    """Parse ``q`` into OR-terms of AND-words.

    Free-text Basic (api spec §2.1.6) makes commas the OR separator. Within one
    term, whitespace separates words, and each word must appear somewhere in the
    row's ``search_text`` for the term to be considered fully matched --
    ``q=radverkehr dresden`` means both words, not the literal phrase.

    Returns a list of word-lists: ``"a b, c"`` -> ``[["a", "b"], ["c"]]``.
    Blank/whitespace-only terms are dropped; an all-blank ``q`` (``""``, ``","``,
    ``"  "``) yields an empty list, which callers treat as "no q" rather than a
    400 -- free text has no invalid input, only an absent one.
    """
    if not q:
        return []
    terms = []
    for raw in q.split(","):
        words = [w for w in raw.lower().split() if w]
        if words:
            terms.append(words)
    return terms


def _q_predicate(terms: list[list[str]], add: Any) -> str:
    """WHERE fragment for ``q``: ALL words of ANY one term must match.

    Commas are the OR (``q=radweg,fahrrad`` matches either); spaces are the AND
    (``q=radverkehr dresden`` matches rows containing both, not rows containing
    just one).

    The looser alternative -- OR across every word, letting the ranking sort it
    out -- reads better for a caller that over-specifies, since it never answers
    an empty page. It was measured and rejected: at 1M items a two-word query
    whose first word is common reported *every* row in ``numberMatched`` while
    showing exact hits on page one. A count no caller can trust is worse than a
    query they have to retry, and a caller that wants alternatives has commas,
    plus ``suggest_terms``/``describe_catalog`` to find the right words.
    """
    per_term = [
        " AND ".join(f"contains(search_text, {add(word)})" for word in term)
        for term in terms
    ]
    return "(" + " OR ".join(f"({clause})" for clause in per_term) + ")"


def _q_rank_sql(terms: list[list[str]], add: Any) -> str:
    """ORDER BY fragment ranking rows by how completely they match ``q``.

    Two integers, both descending: how many query words the row contains at all,
    then how many of them are in the ``title``. That replaces BM25, whose
    IDF/length weighting is tuned for documents rather than the ~100-character
    titles this catalog holds, and -- unlike a similarity score -- is a number a
    caller can explain ("matched 2 of your 2 words, both in the title").

    With a single term the first integer is constant (the predicate already
    required every word), so ordering is effectively by title hits; it earns its
    keep across comma-separated alternatives, where rows matching more than one
    alternative rank first.
    """
    words = [word for term in terms for word in term]
    matched = " + ".join(f"(contains(search_text, {add(w)}))::INT" for w in words)
    in_title = " + ".join(f"(contains(lower(title), {add(w)}))::INT" for w in words)
    return f"({matched}) DESC, ({in_title}) DESC"


def safe_query(
    store: CatalogStore,
    sql: str,
    params: list[Any] | None = None,
    con: duckdb.DuckDBPyConnection | None = None,
) -> list[tuple[Any, ...]]:
    """Run a store query, translating a DuckDB execution error into an
    ``ApiError`` instead of letting it surface as a bare 500.

    The WHERE clause built by ``build_filters`` validates everything it can
    up front (bbox bounds, sortby whitelist, CQL2 queryable names, ...), but
    a geometry that parses as valid JSON and passes the shallow
    ``type``/``coordinates`` presence check at the router (e.g. ``intersects``)
    can still be semantically invalid GeoJSON that only DuckDB's
    ``ST_GeomFromGeoJSON`` rejects at execution time -- this is the backstop
    for that case (and anything else in the same shape), hence 400.

    Running out of memory is NOT that: the query was valid and the server could
    not afford it, which is a 503 the caller can retry -- and, unlike a 400, one
    that shows up as a server-health signal instead of blaming a client whose
    request was fine. Measured at 1.77M rows, a bbox search or a full ``sortby``
    needs more than 512 MB of DuckDB memory, so a tight ``duckdb_memory_limit``
    makes this reachable in production rather than theoretical.
    """
    try:
        return store.query(sql, params, con=con)
    except duckdb.OutOfMemoryException as exc:
        raise ApiError(
            503,
            "the catalog is out of memory for this query; retry, or narrow it "
            "with a filter",
        ) from exc
    except duckdb.Error as exc:
        raise ApiError(400, f"invalid search query: {exc}") from exc


#: Filters whose answer for a dataset is the envelope of its layers', not the
#: collection row's own value.
#:
#: Only temporal ones belong here. A dataset's period genuinely IS the span of
#: its layers (that is what a Collection's `extent.temporal` states), whereas
#: something like `license` is a property of the dataset itself -- promoting that
#: to "any member" would make one openly-licensed layer relicense the whole
#: dataset. `datetime` gets the same treatment in its own branch below.
_DATASET_PERIOD_PARAMS = frozenset({"year"})


def _member_exists(clause: str) -> str:
    """Wrap an item-level predicate as "this collection has such a member".

    The shape the NUTS filter already uses: a correlated EXISTS over the items
    relation. It is what makes a dataset match on *any* of its layers, which is
    the only correct reading of "datasets with a polygon layer" -- 569 bundles
    mix geometry types, so testing one designated member instead silently drops
    228 polygon datasets and 281 point ones.
    """
    return (
        f"EXISTS (SELECT 1 FROM {CatalogStore.ITEMS} "
        f"WHERE {CatalogStore.ITEMS}.collection = {CatalogStore.COLLECTIONS}.id "
        f"AND {clause})"
    )


def build_filters(
    p: SearchParams,
    *,
    registry: QueryableRegistry,
    relation: Literal["items", "collections"] = "items",
    item_registry: QueryableRegistry | None = None,
) -> tuple[str, list[Any]]:
    """Build a WHERE-clause body (no leading ``WHERE``) + positional params.

    Positional ``?`` placeholders, in the exact left-to-right order they
    appear in the returned SQL fragment -- DuckDB has no named parameters.

    ``registry`` resolves ``p.fields``: an unknown parameter name is a 400
    naming what is available, never a silently ignored filter.

    ``relation`` names which mirror relation the caller is querying. Items and
    collections live in separate files, so there is no discriminator predicate
    to add -- the relation *is* the filter.

    ``item_registry`` lets Collection Search accept item-level facets by
    promoting them to a semi-join (see :func:`_member_exists`). Without it a
    dataset search cannot ask about geometry type at all, because that property
    only exists on the layers inside the dataset.

    """
    if p.bbox is not None and p.intersects is not None:
        raise ApiError(400, "bbox and intersects are mutually exclusive")
    if p.bbox_mode not in _BBOX_MODES:
        raise ApiError(400, f"invalid bbox_mode: {p.bbox_mode!r}")

    params: list[Any] = []

    def add(value: Any) -> str:
        params.append(value)
        return "?"

    # No discriminator predicate: the relation already contains exactly one
    # kind of row. `TRUE` keeps the fragment a valid WHERE body when nothing
    # else is filtered.
    filters: list[str] = ["TRUE"]

    # Qualified with the relation, not bare: the NUTS filter below is a
    # correlated EXISTS whose inner table has its own `geometry`, and a bare
    # name inside it resolves to *that* one — the region tested against itself,
    # which is always true. The envelope columns are qualified for the same
    # reason, even though nothing in the subquery shadows them today.
    rel = CatalogStore.ITEMS if relation == "items" else CatalogStore.COLLECTIONS
    geom = f"{rel}.geometry"
    env_prefix = f"{rel}.bbox"

    def envelope_overlaps(w: float, s: float, e: float, n: float) -> str:
        """Cheap numeric overlap test against the row's stored envelope.

        ANDed in front of every exact spatial predicate. Two properties make it
        worth the four extra comparisons: DuckDB evaluates them before calling
        into the spatial library (89 ms -> 10 ms for a bbox search over 1M rows,
        measured), and because they are plain doubles the parquet's per-row-group
        statistics can rule out whole row groups without reading them.

        It only ever *widens* what the exact predicate then narrows: any geometry
        intersecting the query box necessarily has an overlapping envelope, so no
        match can be lost here.
        """
        return (
            f"{env_prefix}_xmax >= {add(w)} AND {env_prefix}_xmin <= {add(e)} "
            f"AND {env_prefix}_ymax >= {add(s)} AND {env_prefix}_ymin <= {add(n)}"
        )

    if p.ids:
        placeholders = ", ".join(add(i) for i in p.ids)
        filters.append(f"id IN ({placeholders})")

    if p.collections:
        placeholders = ", ".join(add(c) for c in p.collections)
        if relation == "collections":
            # On the collections relation the collection IS the row. Reusing the
            # item-shaped predicate here bound a `collection` column that does not
            # exist, so `GET /stac/collections?source=…` answered 400 — found by a
            # test written against the relation rather than the endpoint.
            filters.append(f"id IN ({placeholders})")
        else:
            # An item without an explicit collection is its own singleton dataset
            # (the same coalesce identity ``resolve_id`` uses), so a bare item id is
            # also a valid "collection" to filter by.
            filters.append(f"coalesce(collection, id) IN ({placeholders})")

    if p.bbox is not None:
        w, s, e, n = _validate_bbox(p.bbox)
        if w > e:
            # Crossing the antimeridian: `[170, -10, -170, 10]` means the two
            # boxes `[170..180]` and `[-180..-170]`, not an inverted envelope
            # that nothing satisfies. Intersection semantics in both modes; a
            # relevance fraction across the seam has no single area to compare.
            halves = []
            for hw, he in ((w, 180.0), (-180.0, e)):
                overlaps = envelope_overlaps(hw, s, he, n)
                env = f"ST_MakeEnvelope({add(hw)}, {add(s)}, {add(he)}, {add(n)})"
                halves.append(f"({overlaps} AND ST_Intersects({geom}, {env}))")
            filters.append("(" + " OR ".join(halves) + ")")
        elif p.bbox_mode == "relevant":
            # `add()` appends to a positional parameter list, so every
            # fragment must be built in the order its placeholders appear in
            # the SQL. Evaluating `envelope_overlaps` inline in the f-string
            # below bound its four values *after* the three envelopes, while
            # its `?`s came first -- w/e/s/n silently swapped into
            # `xmin <= ymin`, and the branch returned nothing.
            overlaps = envelope_overlaps(w, s, e, n)
            env1 = f"ST_MakeEnvelope({add(w)}, {add(s)}, {add(e)}, {add(n)})"
            env2 = f"ST_MakeEnvelope({add(w)}, {add(s)}, {add(e)}, {add(n)})"
            env3 = f"ST_MakeEnvelope({add(w)}, {add(s)}, {add(e)}, {add(n)})"
            # `&&` is a cheap bbox-overlap pre-filter; the area-ratio test on
            # top of it is the opt-in "drop a mere edge sliver" heuristic --
            # the spec-conformant default (bbox_mode == "strict") is the
            # plain ST_Intersects branch below.
            filters.append(
                f"({overlaps} AND {geom} && {env1} AND "
                f"ST_Area(ST_Intersection({geom}, {env2})) >= "
                f"0.3 * LEAST(ST_Area({geom}), ST_Area({env3})))"
            )
        else:
            overlaps = envelope_overlaps(w, s, e, n)
            env = f"ST_MakeEnvelope({add(w)}, {add(s)}, {add(e)}, {add(n)})"
            filters.append(f"({overlaps} AND ST_Intersects({geom}, {env}))")
    elif p.intersects is not None:
        geom_json = json.dumps(p.intersects)
        # No envelope prefilter here: the caller's geometry is arbitrary, so its
        # bounds would have to be computed before the query is built. bbox is the
        # parameter a map viewport sends on every pan, and it is the one this
        # optimisation is for.
        filters.append(f"ST_Intersects({geom}, ST_GeomFromGeoJSON({add(geom_json)}))")

    if p.nuts:
        # Intersect the region's actual geometry, not its bounding box, because
        # that is the question the user asked: "datasets covering Vienna", not
        # "datasets covering the rectangle around Vienna".
        #
        # Measured honestly: on today's catalog it makes no difference at all
        # (AT13/AT34/AT21/DE30 return identical counts either way), because the
        # published item geometries are coarse state-sized envelopes rather than
        # real footprints -- so both tests select the same rows. It matters as
        # soon as footprints get finer, and the exact test costs nothing here:
        # the envelope columns below discard almost every row first.
        #
        # Expressed as a semi-join against the NUTS table rather than by
        # inlining the polygon: the geometries are large (MultiPolygons of a few
        # hundred KB), and a GET whose query string carried one would risk a 414
        # as well as re-parsing that GeoJSON on every request.
        #
        # The envelope columns pre-filter before the exact test, the same way
        # the bbox branch does: cheap scalar comparisons discard almost every
        # row before ST_Intersects is called on the survivors.
        placeholders = ", ".join(add(code.strip()) for code in p.nuts if code.strip())
        if placeholders:
            filters.append(
                f"""EXISTS (
                    SELECT 1 FROM {CatalogStore.NUTS} n
                    WHERE n.nuts_id IN ({placeholders})
                      AND bbox_xmin <= ST_XMax(n.geometry)
                      AND bbox_xmax >= ST_XMin(n.geometry)
                      AND bbox_ymin <= ST_YMax(n.geometry)
                      AND bbox_ymax >= ST_YMin(n.geometry)
                      AND ST_Intersects({geom}, n.geometry)
                )"""
            )

    if p.datetime:
        start, end = parse_datetime_interval(p.datetime)

        def datetime_clause(add_param: Any) -> str:
            """A row matches when its temporal extent OVERLAPS the query.

            What the STAC API spec asks for: the `datetime` parameter selects
            anything whose temporal property *intersects* the value. The mirror
            stores an interval per row (`datetime_start`/`datetime_end`), so an
            item published as `start_datetime`/`end_datetime` and a Collection
            with a real `extent.temporal` are both handled here — an instant is
            just a zero-length interval.

            Comparing the single `datetime` instead (what this did) silently
            under-matches the moment ranges appear upstream: a dataset covering
            2014-2021 would answer only to a query containing whichever endpoint
            had been picked.

            Open-ended queries and open-ended extents both work: a NULL bound is
            treated as unbounded rather than as a failed comparison.
            """
            bounds = []
            if start is not None:
                # The row must not end before the query begins.
                bounds.append(
                    f"(datetime_end IS NULL OR datetime_end >= {add_param(start)})"
                )
            if end is not None:
                # ...nor begin after it ends.
                bounds.append(
                    f"(datetime_start IS NULL OR datetime_start <= {add_param(end)})"
                )
            if not bounds:
                return "TRUE"
            # A row with no temporal information at all matches nothing: `..` on
            # both sides is not a filter, and anything narrower cannot include a
            # dataset that never says when it is from.
            return (
                "(datetime_start IS NOT NULL OR datetime_end IS NOT NULL) AND "
                + " AND ".join(bounds)
            )

        if relation == "collections":
            # A dataset is in the range when its own extent says so OR when any of
            # its layers' dates do. Both halves are needed because the two
            # disagree on 2,502 of 3,834 datasets: a Collection states one extent
            # and its members state their own instants, and STAC's rule that the
            # extent is the envelope of the items is not met upstream yet
            # (contract C12). Testing the collection alone would hide a dataset
            # whose layers are from the period asked for.
            own = datetime_clause(add)
            member = datetime_clause(add)
            filters.append(f"(({own}) OR {_member_exists(member)})")
        else:
            datetime_sql = datetime_clause(add)
            if datetime_sql != "TRUE":
                filters.append(datetime_sql)

    terms = _parse_q_terms(p.q)
    if terms:
        # A scan of the mirror's precomputed `search_text` column. This is the
        # WHERE-side filter only; the completeness ranking is injected
        # separately in ``_build_order_by`` so it composes with
        # ``sortby``/``bbox_boost``.
        filters.append(_q_predicate(terms, add))

    # Scalar filters, resolved through the registry: the accepted parameter
    # names, the column (or JSON path, or computed expression) each one
    # narrows, and the type its values are compared as all come from the
    # loaded file. `?themes=` narrows the `category` column because the seed
    # says so, not because this function knows about themes.
    #
    # Iterated in the caller's insertion order so the `?` placeholders this
    # appends stay in the same left-to-right order as the params list.
    allowed = registry.filter_params()
    # Collection Search accepts item-level facets too, as a semi-join. A dataset
    # is a container: "which datasets have a polygon layer" is a question about
    # its members, and answering it on the collection row alone is impossible --
    # `goat:geometryType` is per layer and simply is not there. Promoting the
    # parameter to an EXISTS keeps one vocabulary across both searches instead of
    # a 400 that reads like the filter does not exist.
    promoted = (
        {
            param: entry
            for param, entry in item_registry.filter_params().items()
            if param not in allowed
        }
        if relation == "collections" and item_registry is not None
        else {}
    )
    for param, value in p.fields.items():
        entry = allowed.get(param)
        if entry is None:
            promoted_entry = promoted.get(param)
            if promoted_entry is None:
                available = sorted({*allowed, *promoted})
                raise ApiError(
                    400,
                    f"unknown filter parameter: {param!r} "
                    f"(available: {', '.join(available)})",
                )
            clause = _scalar_filter(promoted_entry, value, add)
            if clause:
                filters.append(_member_exists(clause))
            continue
        if relation == "collections" and param in _DATASET_PERIOD_PARAMS:
            # The same envelope reading `datetime` gets below: a dataset's period
            # is its own extent OR any of its layers'. Without this, `year=2016`
            # answered 1 dataset where `datetime=2016-01-01/2016-12-31` answered
            # 51 -- two spellings of one question disagreeing, because today's
            # a dataset's own extent and its layers' dates disagree on 2,502 of
            # 3,834 datasets.
            own_sql = _scalar_filter(entry, value, add)
            member_sql = _scalar_filter(entry, value, add)
            if own_sql and member_sql:
                filters.append(f"(({own_sql}) OR {_member_exists(member_sql)})")
            continue
        clause = _scalar_filter(entry, value, add)
        if clause:
            filters.append(clause)

    if p.cql is not None:
        frag, cql_params = p.cql
        filters.append(f"({frag})")
        params.extend(cql_params)

    return " AND ".join(filters), params


def _validated_bbox_boost(p: SearchParams) -> tuple[float, float, float, float] | None:
    """Validate ``bbox_boost`` exactly like ``bbox`` (400 on garbage)."""
    if p.bbox_boost is None:
        return None
    return _validate_bbox(p.bbox_boost)


def _envelope_containment_sql(
    west: float, south: float, east: float, north: float
) -> str:
    """How much of each row's stored extent lies inside a rectangle, 0..1.

    Arithmetic on the bbox columns, no spatial call per row. Measured on a
    synthetic 1M-dataset catalog: 144 ms against 1,323 ms for the equivalent
    `ST_Intersection` expression, and the two produce the same order on the real
    catalog (identical top 10) because the published extents ARE rectangles.

    The bounds are inlined rather than bound as parameters: they are validated
    floats, and the expression repeats each one, which with placeholders means
    binding the same value several times in an order that has to match the SQL
    exactly -- a trap this file has fallen into before.

    The `CASE` is correctness, not speed: a zero-extent row (a single point)
    divides by zero, and reading that as "fully contained" would put every point
    dataset in the country at the top of a city's list.
    """
    return (
        f"CASE WHEN (bbox_xmax >= {west} AND bbox_xmin <= {east} "
        f"AND bbox_ymax >= {south} AND bbox_ymin <= {north}) "
        f"THEN COALESCE("
        f"GREATEST(0, LEAST(bbox_xmax, {east}) - GREATEST(bbox_xmin, {west})) "
        f"* GREATEST(0, LEAST(bbox_ymax, {north}) - GREATEST(bbox_ymin, {south})) "
        f"/ NULLIF((bbox_xmax - bbox_xmin) * (bbox_ymax - bbox_ymin), 0), 1.0) "
        f"ELSE 0 END DESC"
    )


def _geojson_envelope(
    geometry: dict[str, Any],
) -> tuple[float, float, float, float] | None:
    """The bounding box of a GeoJSON geometry, or None if it has no coordinates."""
    xs: list[float] = []
    ys: list[float] = []

    def walk(node: Any) -> None:
        if (
            isinstance(node, (list, tuple))
            and len(node) >= 2
            and all(isinstance(v, (int, float)) for v in node[:2])
        ):
            xs.append(float(node[0]))
            ys.append(float(node[1]))
            return
        if isinstance(node, (list, tuple)):
            for child in node:
                walk(child)

    walk(geometry.get("coordinates"))
    if not xs or not ys:
        return None
    return min(xs), min(ys), max(xs), max(ys)


def _viewport_rank_sql(boost: tuple[float, float, float, float], add: Any) -> str:
    """What "show me what is around here first" means.

    A dataset drawn around this city scores 1.0, a nationwide one a fraction,
    one elsewhere 0 -- and nothing is excluded, so the rest of the catalog is a
    scroll away. Runs over every row in the catalog, which is why it is the
    arithmetic form (38 ms at a million datasets).
    """
    del add  # bounds are inlined; see `_envelope_containment_sql`
    w, s, e, n = boost
    return _envelope_containment_sql(w, s, e, n)


def _containment_rank_sql(p: SearchParams, add: Any, geom: str) -> str | None:
    """How much of each row's own extent falls inside the spatial filter.

    Everything a spatial filter returns intersects the area; that says nothing
    about whether the dataset is *of* the place. The catalog's stored extents
    make this acute -- a Baden-Württemberg dataset carrying a 41° x 40° bbox, an
    unprojected one 1,087,569° wide -- so a city-sized filter matches datasets
    from other countries, all honest intersections against dishonest rectangles.

    Dividing by the ROW's own area is what separates them: a dataset drawn
    around this city scores 1.0, a continent-sized one about 0.00002. Nothing is
    excluded and no threshold is invented -- a nationwide dataset covering the
    place is a real answer, just a worse one, and it keeps its place lower down.

    Ranked against the filter's ENVELOPE, not its exact shape: the filter itself
    stays exact, this only orders what it returned, and the geometric form costs
    1,323 ms against 144 ms at a million datasets. A region (`nuts`) keeps the
    geometric form because its bounds live in another table, and a region filter
    is the rare path.
    """
    if p.bbox is not None:
        w, s, e, n = _validate_bbox(p.bbox)
        return _envelope_containment_sql(w, s, e, n)

    if p.intersects is not None:
        envelope = _geojson_envelope(p.intersects)
        if envelope is None:
            return None
        return _envelope_containment_sql(*envelope)

    if p.nuts:
        codes = ", ".join(add(code.strip()) for code in p.nuts if code.strip())
        if not codes:
            return None
        union = (
            f"(SELECT ST_Union_Agg(n.geometry) FROM {CatalogStore.NUTS} n "
            f"WHERE n.nuts_id IN ({codes}))"
        )
        return (
            f"COALESCE(ST_Area(ST_Intersection({geom}, {union})) "
            f"/ NULLIF(ST_Area({geom}), 0), 1.0) DESC"
        )

    return None


def _build_order_by(
    p: SearchParams,
    boost: tuple[float, float, float, float] | None,
    *,
    registry: QueryableRegistry,
    geom: str = "geometry",
) -> tuple[str, list[Any]]:
    """Build the ORDER BY clause.

    Sortable fields come from ``registry`` rather than a fixed list, so any
    scalar column the loaded file happens to carry can be sorted on; geometry,
    lists and structs are excluded there (no meaningful total order). The
    registry accepts both ``updated`` and ``properties.updated`` -- STAC
    clients send the prefixed spelling.

    """
    order_params: list[Any] = []

    def add(value: Any) -> str:
        order_params.append(value)
        return "?"

    prefix = ""

    # Every ranking key below is skipped when the caller sorted explicitly: a
    # sortby makes `q` filter-only (api spec §2.1.6), never a ranking signal.
    if not p.sortby:
        containment = _containment_rank_sql(p, add, geom)
        if containment:
            prefix += containment + ", "

    # Below the spatial filter, so it only breaks that filter's ties: viewing
    # Munich while filtering Berlin must not promote the rows sprawling across
    # both, which the filter ranked last.
    if boost is not None:
        prefix += _viewport_rank_sql(boost, add) + ", "

    q_terms = _parse_q_terms(p.q)
    if q_terms and not p.sortby:
        prefix += _q_rank_sql(q_terms, add) + ", "

    # How much a planner needs it, then the wider footprint among rows that tie.
    # Gated on the score column, which only collections carry.
    scored = registry.resolve("relevance") is not None
    if not p.sortby and scored:
        prefix += f"{RELEVANCE_RANK_SQL} DESC, "
        prefix += f"{BBOX_AREA_SQL} DESC, "

    if not p.sortby:
        # Recency, then `id`, behind every ranking key: the score has four
        # values and the footprint ties across NULL and oversized bboxes, so
        # without a unique key offset paging over the partial order serves one
        # row on two pages and skips another. A layer list, which carries no
        # score, starts here.
        body = "updated DESC, id"
    else:
        clauses: list[str] = []
        for field, direction in p.sortby:
            entry = registry.resolve(field)
            if entry is None or not entry.sortable:
                raise ApiError(400, f"unknown sortby field: {field!r}")
            column = entry.expr
            direction_sql = direction.upper()
            if direction_sql not in ("ASC", "DESC"):
                raise ApiError(400, f"invalid sort direction: {direction!r}")
            clauses.append(f"{column} {direction_sql}")
        body = ", ".join(clauses)

    return f"ORDER BY {prefix}{body}", order_params


def _rows_as_dicts(
    store: CatalogStore,
    sql: str,
    params: list[Any],
    con: duckdb.DuckDBPyConnection | None = None,
) -> list[dict[str, Any]]:
    """Run a query and return rows as ``{column: value}``.

    Geometry is projected as GeoJSON text here rather than handed back as a
    DuckDB geometry: the document assembly needs GeoJSON, and doing the
    conversion in SQL keeps it to the page's rows.
    """
    try:
        return store.query_dicts(sql, params, con=con)
    except duckdb.OutOfMemoryException as exc:
        raise ApiError(
            503,
            "the catalog is out of memory for this query; retry, or narrow it "
            "with a filter",
        ) from exc
    except duckdb.Error as exc:
        raise ApiError(400, f"invalid search query: {exc}") from exc


def search_items(
    store: CatalogStore, p: SearchParams
) -> tuple[list[dict[str, Any]], int]:
    """Run Item Search; returns ``(rows, numberMatched)``.

    Rows are mirror rows -- ``{column: value}`` with the geometry as GeoJSON --
    not STAC documents. Assembling an Item out of them is a serve-time concern
    handled by ``catalog.services.stac_build.item_from_row``, which is also
    where the mirror's internal columns are dropped.

    Each row carries its real ``collection`` (the dataset's bundle/source id,
    or ``None`` for a standalone item) under the reserved
    ``goat:row_collection`` key -- this is a cross-collection query
    (``/search``), so there is no single caller-known collection id to pass the
    way ``/collections/{cid}/items`` can. ``record_to_item`` pops it back off
    and uses it when its own ``collection_id`` argument is absent, instead of
    inventing a synthetic "datasets" collection.
    """
    # Validated up front (400s either way) since it
    # only ever feeds ORDER BY, never build_filters' WHERE clause.
    boost = _validated_bbox_boost(p)
    # One generation for the whole call: the WHERE clause is compiled from this
    # registry and must run on the connection it describes, not on whatever a
    # reload landing mid-request swapped in.
    snap = store.snapshot()
    where_sql, params = build_filters(p, registry=snap.registry)
    order_sql, order_params = _build_order_by(p, boost, registry=snap.registry)
    limit = max(p.limit, 0)
    offset = max(p.offset, 0)

    count_rows = safe_query(
        store,
        f"SELECT count(*) FROM {CatalogStore.ITEMS} WHERE {where_sql}",
        params,
        con=snap.con,
    )
    number_matched = int(count_rows[0][0]) if count_rows else 0

    select_sql = (
        f"SELECT * REPLACE (ST_AsGeoJSON(geometry) AS geometry) "
        f"FROM {CatalogStore.ITEMS} WHERE {where_sql} {order_sql} LIMIT ? OFFSET ?"
    )
    rows = _rows_as_dicts(
        store, select_sql, [*params, *order_params, limit, offset], con=snap.con
    )
    for row in rows:
        if row.get("collection"):
            row["goat:row_collection"] = row["collection"]
        # `member_count` counts the layers of the *dataset*, so it says nothing
        # about the layer this row is. It belongs on the Collection, which is what
        # a dataset-level client reads (`GET /stac/collections`).
        row.pop("member_count", None)
    return rows, number_matched


def search_collections(
    store: CatalogStore, p: SearchParams
) -> tuple[list[dict[str, Any]], int]:
    """Collection Search (``GET /stac/collections``): the same predicates as
    ``search_items``, against the collections relation.

    ``bbox_boost`` ranks intersecting collections first, validated exactly like
    Item Search's (400 on a malformed box).
    """
    snap = store.snapshot()
    registry = snap.collection_registry
    boost = _validated_bbox_boost(p)
    where_sql, params = build_filters(
        p, registry=registry, relation="collections", item_registry=snap.registry
    )
    order_sql, order_params = _build_order_by(p, boost, registry=registry)
    limit = max(p.limit, 0)
    offset = max(p.offset, 0)

    count_rows = safe_query(
        store,
        f"SELECT count(*) FROM {CatalogStore.COLLECTIONS} WHERE {where_sql}",
        params,
        con=snap.con,
    )
    number_matched = int(count_rows[0][0]) if count_rows else 0

    select_sql = (
        f"SELECT * REPLACE (ST_AsGeoJSON(geometry) AS geometry) "
        f"FROM {CatalogStore.COLLECTIONS} WHERE {where_sql} {order_sql} "
        f"LIMIT ? OFFSET ?"
    )
    rows = _rows_as_dicts(
        store, select_sql, [*params, *order_params, limit, offset], con=snap.con
    )
    return rows, number_matched


def collection_ids(store: CatalogStore, limit: int = 100) -> list[str]:
    """Id-only listing of collections (landing-page child links).

    Deliberately narrower than ``search_collections``: the landing page only
    needs ids, and the design targets 100k+ datasets, so this reads one column
    and nothing else.
    """
    rows = safe_query(
        store,
        f"SELECT id FROM {CatalogStore.COLLECTIONS} ORDER BY id LIMIT ?",
        [limit],
    )
    return [str(row[0]) for row in rows]


def get_collection_row(store: CatalogStore, cid: str) -> dict[str, Any] | None:
    """One collection row by id, or ``None``."""
    rows = _rows_as_dicts(
        store,
        f"SELECT * REPLACE (ST_AsGeoJSON(geometry) AS geometry) "
        f"FROM {CatalogStore.COLLECTIONS} WHERE id = ?",
        [cid],
    )
    return rows[0] if rows else None


# Cap on how many bundle members a single `resolve_id` collection lookup
# fetches -- an unbounded `WHERE collection = ?` on a bundle with thousands of
# members would otherwise fan the whole set into memory in one request.
# Module-level (not a function default) so a test can monkeypatch it to a small
# number and assert truncation without crafting a huge fixture.
_MEMBER_LIMIT = 100


def resolve_id(store: CatalogStore, entry_id: str) -> dict[str, Any] | None:
    """Resolve an id to whatever it identifies: an item or a collection.

    Returns ``None`` if nothing matches. With the two relations separate this
    is two point lookups rather than one -- measured at parity, since each file
    is smaller than the merged one was.

    A collection's ``member_docs`` is capped at ``_MEMBER_LIMIT`` regardless of
    how many members exist; ``member_count`` is the true (uncapped) total, read
    off the mirror's precomputed column, so a caller can tell truncation apart
    from "this bundle really only has N members".
    """
    geo = "ST_AsGeoJSON(geometry) AS geometry"
    item_rows = _rows_as_dicts(
        store,
        f"SELECT * REPLACE ({geo}) FROM {CatalogStore.ITEMS} WHERE id = ?",
        [entry_id],
    )
    if item_rows:
        row = item_rows[0]
        return {
            "kind": "item",
            "row": row,
            "collection_id": row.get("collection"),
        }

    collection = get_collection_row(store, entry_id)
    if collection is None:
        return None

    member_rows = _rows_as_dicts(
        store,
        f"SELECT * REPLACE ({geo}) FROM {CatalogStore.ITEMS} "
        f"WHERE collection = ? LIMIT {_MEMBER_LIMIT}",
        [entry_id],
    )
    return {
        "kind": "collection",
        "collection_row": collection,
        "member_rows": member_rows,
        "member_count": int(collection.get("member_count") or 0),
    }
