"""What is filterable, sortable and facetable -- derived from the loaded table.

One registry, built by introspecting the catalog table that is actually
loaded, drives five things that used to be five hand-maintained lists:

- the ``/queryables`` JSON Schema document (``catalog.services.queryables``)
- CQL2 filter validation + property-to-SQL resolution (``catalog.services.cql``)
- the ``sortby`` whitelist (``catalog.services.search``)
- the facet aggregations offered by ``/aggregate`` (``catalog.services.aggregations``)
- the scalar filter query parameters (``?license=``, ``?themes=``, ...) accepted
  by the search endpoints, and the WHERE clause each one compiles to
  (``catalog.services.search.build_filters``)

This is pgstac's design with the storage swapped out. pgstac keeps a
``queryables`` table whose rows carry ``name``, ``property_path``,
``property_wrapper``, ``definition`` and ``property_index_type``, and one row
drives its ``/queryables`` output, its CQL2-to-SQL translation *and* the index
DDL it generates. It seeds that table from known STAC extension definitions
and discovers the rest from the data (``missing_queryables()`` samples the
partition and infers a type per unregistered property). We do the same, minus
the table: the parquet's own column types are the discovery mechanism, and
:data:`_FIELD_DEFS` is the seed that supplies real titles/formats instead of
guesses.

Why derive rather than hardcode: the harvester's schema is not ours to fix.
It gained ``raster:bands`` and ``gsd`` the moment one raster dataset was
published, and the move to native stac-geoparquet renames or drops several
columns we used to promote. A hardcoded list silently ignores new columns and
generates SQL against departed ones; a derived registry filters and sorts on
whatever the current file actually has, and drops facets whose column is gone
instead of failing the query.

Following pgstac, only what the spec *mandates* is special-cased here (the
core queryables every STAC API must accept, and ``geometry``'s GeoJSON
schema). Everything else comes from the file.
"""

from dataclasses import dataclass
from typing import Any

from catalog.relevance import RELEVANCE_RANK_SQL, TOPIC_SCORE_FIELD

_GEOJSON_GEOMETRY_SCHEMA = "https://geojson.org/schema/Geometry.json"

#: Columns that must never be queryable, whatever the file contains.
#:
#: ``document`` is the verbatim STAC JSON payload -- an opaque blob, not a
#: scalar to filter on (a CQL2 predicate against it would compare JSON text).
#:
#: ``parquet_url`` is the private ``s3://`` location of the layer's data.
#: Every response strips ``s3://`` hrefs (design S14), so advertising it in
#: ``/queryables`` -- let alone letting a filter match on it -- would publish
#: the internal storage layout the response rules exist to hide.
#:
#: The rest are the mirror's internal machinery: ``search_text`` is the folded
#: haystack behind ``q`` (filtering it directly would expose an implementation
#: detail and duplicate ``q``), the mirror's own bookkeeping columns drive
#: bundle grouping, and ``member_count`` is already published on the document as
#: ``goat:member_count``.
_HIDDEN_COLUMNS = frozenset(
    {
        "document",
        "parquet_url",
        "search_text",
        "datetime_start",
        "datetime_end",
        "member_count",
        "bbox_xmin",
        "bbox_ymin",
        "bbox_xmax",
        "bbox_ymax",
    }
)


@dataclass(frozen=True)
class Queryable:
    """One filterable property: what clients name it, and how it becomes SQL.

    Mirrors a pgstac ``queryables`` row. ``expr`` is pgstac's
    ``property_path`` -- today always a plain column reference, since the
    catalog table is flat; it exists as a separate field so a nested path
    (``document->'properties'->>'x'``) can be introduced without touching any
    caller.
    """

    name: str
    expr: str
    json_type: str
    definition: dict[str, Any]
    sortable: bool
    facetable: bool
    #: Name this facet is published under, when it differs from the column.
    #: The published names predate the columns that now back them
    #: (``geometry_type_count`` over ``goat:geometryType``, ``type_count`` over
    #: ``goat:layerType``), and deriving the name from the column would both
    #: rename a live API surface and leak extension prefixes into it.
    facet_name: str = ""
    #: Query-parameter name this property is filterable under, when
    #: :attr:`filterable_param` is set. Kept separate from both ``name`` and
    #: ``facet_name`` because all three are independent published surfaces:
    #: the ``category`` column is aggregated as ``category_count`` but has
    #: always been filtered with ``?themes=``.
    param: str = ""
    #: Whether the search endpoints accept ``?<param>=a,b`` for this property.
    filterable_param: bool = False


@dataclass(frozen=True)
class _Seed:
    """Static metadata for a field we know by name (pgstac's seed catalog)."""

    description: str
    facetable: bool = False
    json_type: str | None = None
    json_format: str | None = None
    facet_name: str | None = None
    param: str | None = None
    #: Expose a scalar filter parameter for a property that is deliberately
    #: *not* a facet (``year`` is a numeric range-ish filter, not a bucket
    #: list). Facetable properties get their parameter automatically.
    filter_param: bool = False


#: Known fields, keyed by column name. Supplies human descriptions and the
#: facetable flag; the *type* still comes from the file unless overridden.
#:
#: Both vocabularies are seeded deliberately -- the flat mirror's column names
#: and the native stac-geoparquet names the harvester now publishes -- so the
#: registry produces good output whichever schema is loaded, including during
#: a migration when both may be in play.
#:
#: `facetable` is declared rather than inferred. Whether a property is offered
#: as a facet is an API surface (`/aggregations` advertises the names, and the
#: UI's sidebar is built from them), so it must not appear or vanish because a
#: column's cardinality drifted between two harvests. Filterability and
#: sortability, which are capabilities rather than surface, are inferred.
_FIELD_DEFS: dict[str, _Seed] = {
    # STAC core
    "id": _Seed("Unique identifier of the item or collection"),
    # Not facetable: an identifier column yields one bucket per dataset
    # (hundreds), which is a listing, not a facet.
    "collection": _Seed("Identifier of the parent collection"),
    # The mirror keeps the *published* column names, so the GOAT vocabulary
    # arrives prefixed. The published API names stay `?type=` and `type_count`
    # -- what they were when a single overloaded `type` column carried both the
    # STAC object kind and the layer type.
    "goat:layerType": _Seed(
        "Layer type", facetable=True, facet_name="type", param="type"
    ),
    "title": _Seed("Human-readable title"),
    "description": _Seed("Human-readable description"),
    "datetime": _Seed("Nominal date and time of the data"),
    "created": _Seed("When the entry was created"),
    "updated": _Seed("When the entry was last updated"),
    "geometry": _Seed("Spatial extent"),
    "license": _Seed("SPDX license identifier", facetable=True),
    "keywords": _Seed("Free-text keywords"),
    "version": _Seed("Version marker of the dataset"),
    # Flat-mirror promoted columns
    # Filtered as `?themes=`, the STAC themes vocabulary the column represents,
    # while the aggregation stays `category_count` -- both names are already
    # published, so neither may be derived from the other.
    "category": _Seed("Thematic category", facetable=True, param="themes"),
    # The published `language` is the Language extension's STRUCT, which cannot
    # be compared or bucketed; the mirror derives this scalar beside it.
    "language_code": _Seed(
        "Metadata language", facetable=True, facet_name="language", param="language"
    ),
    "publisher": _Seed("Publishing organisation", facetable=True),
    # STAC extensions the harvester publishes
    "table:row_count": _Seed("Number of rows in the layer"),
    "processing:lineage": _Seed("How the data was produced"),
    "gsd": _Seed("Ground sample distance"),
    # GOAT extensions. `facet_name` keeps the published facet stable across the
    # harvester's schema changes and keeps extension prefixes out of public
    # aggregation names: the column is `goat:geometryType`, the facet has
    # always been `geometry_type_count`.
    "goat:geometryType": _Seed(
        "Geometry type of the layer", facetable=True, facet_name="geometry_type"
    ),
    "goat:geographical_code": _Seed(
        "Country or region code", facetable=True, facet_name="geographical_code"
    ),
    # Not facetable: a ranking input, not a filter a reader would pick from.
    "goat:topicRelevance": _Seed("Plan4Better topic relevance tier"),
    "goat:topicRelevanceScore": _Seed("Topic relevance as a score, higher first"),
    "year": _Seed("Calendar year of the data", json_type="integer", filter_param=True),
}


@dataclass(frozen=True)
class _Virtual:
    """A queryable that is an expression over the table, not a column of it.

    Registered only when ``requires`` is actually present in the loaded file,
    for the same reason a seeded facet is dropped when its column is gone: the
    expression would otherwise compile to SQL against something that does not
    exist. A real column of the same name always wins -- when the harvester
    starts publishing ``goat:geographical_code`` natively, the column-derived
    entry replaces this one with no code change.
    """

    expr: str
    json_type: str
    requires: str


#: Non-column queryables. Both were previously hardcoded as one-off ``if``
#: branches in ``build_filters``, which made them filterable via their query
#: parameter but *not* via CQL2 or ``sortby`` -- everything else in the API
#: supports all three. Expressing them here closes that gap.
_VIRTUAL_FIELDS: dict[str, _Virtual] = {
    # Makes the score sortable as `relevance` and CQL2-addressable.
    "relevance": _Virtual(
        expr=RELEVANCE_RANK_SQL,
        json_type="integer",
        requires=TOPIC_SCORE_FIELD,
    ),
    # The year a row's data STARTS in -- not every year it covers. A single
    # expression cannot say "overlaps 2016" (that needs two comparisons), and
    # `datetime` already does say it: `?datetime=2016-01-01T00:00:00Z/
    # 2016-12-31T23:59:59Z` selects everything running through 2016, ranged rows
    # included, which is the filter a client wanting "data from 2016" should
    # send. This one exists to make the year sortable and CQL2-addressable, and
    # is exact for the instant-dated rows that are most of the catalog.
    #
    # This one stays virtual because `date_part` over a native timestamp costs
    # 40 ms at the 1M-item target -- unlike the JSON-path extraction that
    # `geographical_code` used to need, which is why that one became a column.
    "year": _Virtual(
        # Off the interval's start, not `datetime`: a row that states a range
        # publishes `start_datetime`/`end_datetime` and MAY leave `datetime`
        # null (STAC allows exactly that), so faceting on `datetime` would drop
        # every ranged dataset out of the year list. For an instant the two are
        # the same value.
        expr="date_part('year', COALESCE(datetime_start, datetime_end))",
        json_type="integer",
        requires="datetime_start",
    ),
}

#: DuckDB type prefix -> (JSON Schema type, format). Prefix-matched after
#: upper-casing, so parameterised types (``DECIMAL(18,3)``,
#: ``TIMESTAMP WITH TIME ZONE``) resolve without enumerating every variant.
_TYPE_MAP: tuple[tuple[str, str, str | None], ...] = (
    ("BOOLEAN", "boolean", None),
    ("TIMESTAMP", "string", "date-time"),
    ("DATE", "string", "date-time"),
    ("TIME", "string", "time"),
    ("VARCHAR", "string", None),
    ("TEXT", "string", None),
    ("UUID", "string", None),
    ("DOUBLE", "number", None),
    ("FLOAT", "number", None),
    ("REAL", "number", None),
    ("DECIMAL", "number", None),
    ("HUGEINT", "integer", None),
    ("BIGINT", "integer", None),
    ("INTEGER", "integer", None),
    ("SMALLINT", "integer", None),
    ("TINYINT", "integer", None),
    ("UBIGINT", "integer", None),
    ("UINTEGER", "integer", None),
    ("GEOMETRY", "geometry", None),
)

#: JSON types that can be ordered by. Excludes geometry (no total order),
#: arrays and structs (ORDER BY would compare containers, not values).
_SORTABLE_TYPES = frozenset({"string", "number", "integer", "boolean"})


def _classify(duckdb_type: str) -> tuple[str, str | None] | None:
    """Map a DuckDB column type to ``(json_type, format)``.

    Returns ``None`` for types with no scalar JSON equivalent -- lists,
    structs and maps. Those are skipped rather than exposed: a CQL2
    comparison against a whole container is not meaningful, and the nested
    paths that *would* be meaningful need the path support noted on
    :class:`Queryable`.
    """
    t = duckdb_type.strip().upper()
    if t.endswith("[]") or t.startswith(("STRUCT", "MAP", "UNION", "LIST")):
        return None
    for prefix, json_type, json_format in _TYPE_MAP:
        if t.startswith(prefix):
            return json_type, json_format
    return None


def _definition(name: str, json_type: str, json_format: str | None) -> dict[str, Any]:
    seed = _FIELD_DEFS.get(name)
    description = seed.description if seed else f"The {name} of the item"
    if json_type == "geometry":
        return {"description": description, "$ref": _GEOJSON_GEOMETRY_SCHEMA}
    schema: dict[str, Any] = {"description": description, "type": json_type}
    if json_format:
        schema["format"] = json_format
    return schema


def _entry(name: str, expr: str, json_type: str, json_format: str | None) -> Queryable:
    """Assemble one :class:`Queryable` from a name, its SQL and its type."""
    seed = _FIELD_DEFS.get(name)
    # A seeded facet is offered only when its column is present, so a schema
    # change drops the facet instead of producing SQL against a column that no
    # longer exists.
    facetable = bool(seed and seed.facetable and json_type == "string")
    facet_name = seed.facet_name if seed and seed.facet_name else name
    param = seed.param if seed and seed.param else facet_name
    return Queryable(
        name=name,
        expr=expr,
        json_type=json_type,
        definition=_definition(name, json_type, json_format),
        sortable=json_type in _SORTABLE_TYPES,
        facetable=facetable,
        facet_name=facet_name,
        param=param,
        # Anything offered as a facet is also filterable by its parameter (the
        # UI needs to narrow by what it just showed a bucket list for); a seed
        # can opt in without being a facet.
        filterable_param=facetable or bool(seed and seed.filter_param),
    )


#: Columns hidden on the COLLECTIONS relation only.
#:
#: ``goat:geometryType`` is a real column there since mirror v5 -- the layers'
#: geometry type where they agree on one, so a dataset card can say what shape
#: the data is. It is not a *filter*, though: "datasets with a polygon layer" is
#: a question about members, and 569 of 1,207 bundles mix types, so this column
#: is NULL for exactly the datasets a filter must still find. Hidden here, the
#: parameter falls through to the item registry and compiles to the semi-join
#: that answers it (``build_filters``' ``promoted``).
_HIDDEN_COLLECTION_COLUMNS = frozenset({"goat:geometryType", "thumbnail_item"})


def build_registry(
    columns: dict[str, str], *, relation: str = "items"
) -> "QueryableRegistry":
    """Build the registry for a table with these ``{column: duckdb_type}``."""
    hidden = _HIDDEN_COLUMNS | (
        _HIDDEN_COLLECTION_COLUMNS if relation == "collections" else frozenset()
    )
    entries: dict[str, Queryable] = {}
    for name, duckdb_type in columns.items():
        if name in hidden:
            continue
        classified = _classify(duckdb_type)
        if classified is None:
            continue
        json_type, json_format = classified
        seed = _FIELD_DEFS.get(name)
        if seed and seed.json_type:
            json_type, json_format = seed.json_type, seed.json_format
        entries[name] = _entry(
            name,
            # Always quoted: harvester column names contain colons
            # (`table:row_count`, `goat:geometryType`), which are not valid
            # bare SQL identifiers.
            f'"{name}"',
            json_type,
            json_format,
        )

    for name, virtual in _VIRTUAL_FIELDS.items():
        if name in entries or virtual.requires not in columns:
            continue
        seed = _FIELD_DEFS.get(name)
        entries[name] = _entry(
            name,
            virtual.expr,
            virtual.json_type,
            seed.json_format if seed else None,
        )

    return QueryableRegistry(entries)


class QueryableRegistry:
    """The filterable/sortable/facetable properties of one loaded table."""

    def __init__(self, entries: dict[str, Queryable]) -> None:
        self._entries = entries

    def __contains__(self, name: object) -> bool:
        return isinstance(name, str) and self.resolve(name) is not None

    def __len__(self) -> int:
        return len(self._entries)

    @property
    def names(self) -> list[str]:
        return list(self._entries)

    def resolve(self, name: str) -> Queryable | None:
        """Look up a client-supplied property name.

        Accepts the STAC ``properties.``-prefixed spelling as an alias for the
        bare name (``properties.datetime`` and ``datetime`` are the same
        property), which is what pgstac's ``queryable()`` does before its own
        lookup -- clients and the Sort/Filter extensions use both forms.
        """
        entry = self._entries.get(name)
        if entry is not None:
            return entry
        if name.startswith("properties."):
            return self._entries.get(name[len("properties.") :])
        return None

    def sql_expr(self, name: str) -> str | None:
        entry = self.resolve(name)
        return entry.expr if entry else None

    def sortable(self) -> dict[str, Queryable]:
        return {n: q for n, q in self._entries.items() if q.sortable}

    def facets(self) -> dict[str, Queryable]:
        return {n: q for n, q in self._entries.items() if q.facetable}

    def filter_params(self) -> dict[str, Queryable]:
        """``{query-parameter name: queryable}`` for the scalar filters.

        This is the whole set of ``?license=``-style parameters the search
        endpoints accept: whatever the loaded file supports, rather than a list
        repeated in each handler signature.
        """
        return {q.param: q for q in self._entries.values() if q.filterable_param}

    def expr_map(self) -> dict[str, str]:
        """``{property name: SQL expression}`` for every queryable.

        Handed to the CQL2 evaluator so a filter compiles through the same
        expression the scalar parameters and facets use -- including the
        virtual ones, which are not columns and cannot be resolved by quoting
        their name. Both accepted spellings are included, since STAC clients
        send ``properties.datetime`` as readily as ``datetime``.
        """
        exprs = {n: q.expr for n, q in self._entries.items()}
        exprs.update({f"properties.{n}": q.expr for n, q in self._entries.items()})
        return exprs

    def schema_properties(self) -> dict[str, dict[str, Any]]:
        """The ``properties`` block of the queryables JSON Schema document."""
        return {n: q.definition for n, q in self._entries.items()}
