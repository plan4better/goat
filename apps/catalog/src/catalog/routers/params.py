"""Request parameters for the search endpoints, declared once.

``GET /stac/search``, ``POST /stac/search``, ``GET /stac/aggregate`` and
``GET /stac/collections`` take almost the same parameters. Spelling them out in
each handler signature meant four copies of the same twenty parameters, four
call sites threading them into ``SearchParams``, and one parser per verb for
values (``sortby``) that only differ in their JSON encoding. The models here
are that surface, declared once:

- the :data:`CsvList`/:data:`BboxCsv`/:data:`SortBy`/:data:`GeometryValue`
  annotated types carry the parsing, so every endpoint accepting a bbox parses
  it identically and GET/POST need no separate parsers -- each validator
  accepts both the string encoding a query parameter arrives in and the native
  JSON type a POST body carries
- :class:`FacetFilters` is the scalar facet surface, whose members must match
  what ``catalog.services.registry`` seeds as filterable (a test enforces it)
- :meth:`SearchQuery.to_search_params` is the single place a request becomes a
  ``catalog.services.search.SearchParams``, including CQL2 compilation

The endpoint-specific models stay separate rather than collapsing into one
"everything" model, because a parameter a handler ignores would still be
advertised in its OpenAPI operation.
"""

import json
from typing import Annotated, Any, Literal

from pydantic import AliasChoices, BaseModel, BeforeValidator, ConfigDict, Field

from catalog.errors import ApiError
from catalog.limits import DEFAULT_LIMIT, LIMIT_DESCRIPTION
from catalog.services.cql import compile_cql2
from catalog.services.registry import QueryableRegistry
from catalog.services.search import SearchParams

# --------------------------------------------------------------------------
# Annotated types: one definition per value shape, parsing included
# --------------------------------------------------------------------------


def _split_values(value: Any) -> list[Any] | None:
    """Normalise every encoding a list-valued parameter arrives in.

    A single comma-separated string (``?ids=a,b``), the repeated-parameter form
    FastAPI hands a list-typed query field (``?ids=a&ids=b`` -> ``["a", "b"]``,
    and ``?ids=a,b`` -> ``["a,b"]``), or a native JSON array from a POST body.
    Comma-splitting is applied to string members of a list too, so the two GET
    encodings mean the same thing instead of one of them yielding a single
    value with a comma in it.
    """
    if value is None:
        return None
    items = [value] if isinstance(value, str) else value
    if not isinstance(items, (list, tuple)):
        return [items]
    out: list[Any] = []
    for item in items:
        if isinstance(item, str):
            out.extend(v.strip() for v in item.split(",") if v.strip())
        else:
            out.append(item)
    return out


def _parse_csv(value: Any) -> Any:
    """``"a,b"``/``["a", "b"]`` -> ``["a", "b"]``; empty -> ``None``."""
    items = _split_values(value)
    return items or None


def _parse_bbox(value: Any) -> Any:
    """``"1,2,3,4"`` -> ``[1.0, 2.0, 3.0, 4.0]``.

    Only the encoding is handled here; the number of values and their ranges
    are checked by ``catalog.services.search`` so that ``bbox`` and
    ``bbox_boost`` cannot drift apart, and so an out-of-range box is reported
    with the same message however it arrived.
    """
    items = _split_values(value)
    if not items:
        return None
    try:
        return [float(v) for v in items]
    except (TypeError, ValueError) as exc:
        raise ApiError(400, f"invalid bbox: {value!r}") from exc


#: POST-body members that must arrive as JSON arrays.
#:
#: One model serves both verbs (see the module docstring), so the GET-side CSV
#: parsers are reachable from a JSON body too -- and `{"bbox": "1,2,3,4"}` then
#: succeeds where Item Search's POST schema types `bbox` as an array of numbers.
#: A string there is a client error, and stac-api-validator asserts the 400.
#:
#: Only the numeric boxes are strict. `sortby` stays lenient on purpose (clients
#: send the Sort extension's objects and `-field` strings interchangeably, and
#: both are unambiguous), as do `ids`/`collections`, where a comma is not valid
#: inside a value so the CSV reading cannot lose information.
_POST_ARRAY_ONLY = ("bbox", "bbox_boost")


def reject_get_encodings(body: Any) -> None:
    """Raise 400 if a POST body spells an array parameter the GET way."""
    if not isinstance(body, dict):
        return
    for name in _POST_ARRAY_ONLY:
        if isinstance(body.get(name), str):
            raise ApiError(
                400, f"invalid {name}: must be an array of numbers in a POST body"
            )


_SORT_PREFIX_DIRECTION = {"+": "asc", "-": "desc"}


def _parse_sort_token(token: str) -> tuple[str, str] | None:
    token = token.strip()
    if not token:
        return None
    direction = "asc"
    if token[0] in _SORT_PREFIX_DIRECTION:
        direction = _SORT_PREFIX_DIRECTION[token[0]]
        token = token[1:]
    return token, direction


def _parse_sortby(value: Any) -> Any:
    """Accept every ``sortby`` encoding the API takes.

    ``"-properties.updated,+id"`` (GET), and for POST bodies both the Sort
    extension's ``[{"field": ..., "direction": ...}]`` objects and the same
    ``[+|-]field`` strings, which clients send interchangeably.
    """
    tokens = _split_values(value)
    if tokens is None:
        return None

    result: list[tuple[str, str]] = []
    for entry in tokens:
        if isinstance(entry, str):
            parsed = _parse_sort_token(entry)
            if parsed is not None:
                result.append(parsed)
        elif isinstance(entry, dict):
            field = entry.get("field")
            if not field:
                raise ApiError(400, "invalid sortby entry: missing 'field'")
            result.append((str(field), str(entry.get("direction", "asc"))))
        elif isinstance(entry, (list, tuple)) and len(entry) == 2:
            # A round-tripped model_dump of this very field.
            result.append((str(entry[0]), str(entry[1])))
        else:
            raise ApiError(400, f"invalid sortby entry: {entry!r}")
    return result or None


def _parse_geometry(value: Any) -> Any:
    """A GeoJSON geometry, given as a JSON string (GET) or an object (POST).

    Validates the envelope only -- that this is an object naming a type and
    carrying a shape. Whether the coordinates describe a geometry DuckDB can
    build is settled at query time (``search.safe_query``); duplicating that
    here would mean maintaining a second GeoJSON validator.
    """
    if value is None:
        return None
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as exc:
            raise ApiError(400, f"invalid intersects GeoJSON: {exc}") from exc
    if not isinstance(value, dict):
        raise ApiError(400, "invalid intersects GeoJSON: expected an object")

    # A GeometryCollection is the one geometry type carrying `geometries`
    # instead of `coordinates`, and Item Search must support every GeoJSON
    # geometry type -- demanding `coordinates` unconditionally rejected valid
    # input.
    has_shape = (
        "geometries" in value
        if value.get("type") == "GeometryCollection"
        else "coordinates" in value
    )
    if "type" not in value or not has_shape:
        raise ApiError(
            400,
            "invalid intersects GeoJSON: need 'type' plus 'coordinates' "
            "('geometries' for a GeometryCollection)",
        )
    return value


CsvList = Annotated[list[str] | None, BeforeValidator(_parse_csv)]
BboxCsv = Annotated[list[float] | None, BeforeValidator(_parse_bbox)]
SortBy = Annotated[list[tuple[str, str]] | None, BeforeValidator(_parse_sortby)]
GeometryValue = Annotated[dict[str, Any] | None, BeforeValidator(_parse_geometry)]

BboxDescription = "minx,miny,maxx,maxy"
BboxBoostDescription = "Rank results over this box first, without excluding others"
DatetimeDescription = "RFC 3339 instant or interval"
FilterLang = Literal["cql2-text", "cql2-json"]


# --------------------------------------------------------------------------
# Scalar facet filters
# --------------------------------------------------------------------------


class FacetFilters(BaseModel):
    """The ``?license=``-style scalar filters, shared by every search endpoint.

    These mirror the registry entries seeded as filterable
    (``QueryableRegistry.filter_params``) and are declared statically here
    rather than generated from it, for two reasons: the parameters a request
    may carry belong in the OpenAPI document, and generating the model would
    make it invisible to the type checker. ``test_params`` asserts the two
    stay in step, so a new seeded facet fails the suite instead of silently
    lacking a query parameter.

    Values are comma-separated (``?license=CC-BY-4.0,ODbL-1.0`` means either).
    """

    model_config = ConfigDict(populate_by_name=True)

    themes: str | None = Field(
        default=None,
        # `data_category` is what the collections endpoint has always called
        # this; accepted everywhere now rather than on that one endpoint.
        validation_alias=AliasChoices("themes", "data_category"),
        description="Thematic categories, comma-separated",
    )
    language: str | None = Field(default=None, description="Metadata language")
    year: int | None = Field(default=None, description="Calendar year of the data")
    license: str | None = Field(default=None, description="SPDX license identifiers")
    publisher: str | None = Field(default=None, description="Publishing organisations")
    type: str | None = Field(default=None, description="feature | table | raster")
    geometry_type: str | None = Field(
        default=None,
        validation_alias=AliasChoices("geometry_type", "geom_type"),
        description="Geometry type of the layer",
    )
    geographical_code: str | None = Field(
        default=None, description="Country or region codes"
    )

    def filter_fields(self) -> dict[str, str]:
        """``{parameter name: value}`` for whatever was supplied.

        Keyed by the *canonical* parameter name (the field name), which is what
        ``QueryableRegistry.filter_params`` keys on -- an alias used by the
        caller never reaches the query builder.
        """
        return {
            name: str(value)
            for name, value in self.__dict__.items()
            if name in FacetFilters.model_fields and value is not None
        }


# --------------------------------------------------------------------------
# Endpoint request models
# --------------------------------------------------------------------------


class _FilterMixin(FacetFilters):
    """CQL2 filter parameters, plus the spatial/temporal/free-text core."""

    bbox: BboxCsv = Field(default=None, description=BboxDescription)
    datetime: str | None = Field(default=None, description=DatetimeDescription)
    q: str | None = Field(
        default=None, description="Free-text over title/description/keywords"
    )
    filter: str | dict[str, Any] | None = Field(default=None, description="CQL2 filter")
    # `alias` (not just the validation aliases) so the parameter is *documented*
    # under its canonical hyphenated wire name; the underscored spelling stays
    # accepted because clients and older callers send it.
    filter_lang: FilterLang | None = Field(
        default=None,
        alias="filter-lang",
        validation_alias=AliasChoices("filter-lang", "filter_lang"),
        description="cql2-text or cql2-json",
    )
    filter_crs: str | None = Field(
        default=None,
        alias="filter-crs",
        validation_alias=AliasChoices("filter-crs", "filter_crs"),
    )
    bbox_mode: Literal["strict", "relevant"] = Field(
        default="strict",
        description="strict (default) matches any intersection; relevant drops slivers",
    )
    nuts: CsvList = Field(
        default=None,
        description=(
            "NUTS region ids (e.g. AT13, DE21). Matches datasets intersecting the"
            " region's geometry, not merely its bounding box. Combinable with bbox."
        ),
    )

    def _base_params(
        self,
        registry: QueryableRegistry,
        *,
        default_filter_lang: FilterLang,
        **overrides: Any,
    ) -> SearchParams:
        cql = None
        if self.filter is not None:
            cql = compile_cql2(
                self.filter,
                self.filter_lang or default_filter_lang,
                self.filter_crs,
                registry,
            )
        return SearchParams(
            bbox=self.bbox,
            datetime=self.datetime,
            q=self.q,
            fields=self.filter_fields(),
            cql=cql,
            bbox_mode=self.bbox_mode,
            nuts=self.nuts,
            **overrides,
        )


class ItemsQuery(BaseModel):
    """``GET /stac/collections/{cid}/items`` parameters.

    OGC API - Features core only: the collection is already fixed by the path,
    so this is the spatial/temporal window and the page, nothing else.
    """

    bbox: BboxCsv = Field(default=None, description=BboxDescription)
    datetime: str | None = Field(default=None, description=DatetimeDescription)
    limit: int = Field(default=DEFAULT_LIMIT, description=LIMIT_DESCRIPTION)
    offset: int = Field(default=0, ge=0)

    def to_search_params(self, *, collection_id: str, limit: int) -> SearchParams:
        return SearchParams(
            collections=[collection_id],
            bbox=self.bbox,
            datetime=self.datetime,
            limit=limit,
            offset=self.offset,
        )


class SearchQuery(_FilterMixin):
    """``GET /stac/search`` parameters and the ``POST /stac/search`` body.

    One model for both verbs: the annotated types accept either encoding, so
    the only thing that differs is the default ``filter-lang`` the caller's
    handler passes to :meth:`to_search_params` (cql2-text for GET, cql2-json
    for POST, per the API brief).
    """

    collections: CsvList = Field(default=None, description="Collection ids")
    ids: CsvList = Field(default=None, description="Item ids")
    intersects: GeometryValue = Field(
        default=None, description="GeoJSON geometry (URL-encoded for GET)"
    )
    sortby: SortBy = Field(default=None, description="e.g. -properties.updated")
    bbox_boost: BboxCsv = Field(default=None, description=BboxBoostDescription)
    limit: int = Field(default=DEFAULT_LIMIT, description=LIMIT_DESCRIPTION)
    offset: int = Field(default=0, ge=0)

    def to_search_params(
        self,
        registry: QueryableRegistry,
        *,
        default_filter_lang: FilterLang,
        limit: int,
    ) -> SearchParams:
        """Compile this request into ``SearchParams``.

        ``limit`` is passed in already clamped: the ceiling differs per
        endpoint and, per STAC, an over-large value must be served as the
        maximum rather than rejected, so it cannot be a field constraint.
        """
        return self._base_params(
            registry,
            default_filter_lang=default_filter_lang,
            collections=self.collections,
            ids=self.ids,
            intersects=self.intersects,
            sortby=self.sortby,
            bbox_boost=self.bbox_boost,
            limit=limit,
            offset=self.offset,
        )


class CollectionSearchQuery(_FilterMixin):
    """``GET /stac/collections`` (Collection Search) parameters."""

    source: CsvList = Field(
        default=None,
        validation_alias=AliasChoices("source", "collections"),
        description="Filter to one or more source ids",
    )
    # On the collections relation `id` IS the collection id — this is what the
    # favourites filter feeds ("show my favourites" = the caller's saved ids).
    ids: CsvList = Field(default=None, description="Collection ids")
    # A drawn shape or a buffered point. Declared here or FastAPI drops the
    # query parameter without a word, and a spatial filter that is not a bbox
    # or a NUTS region silently returns the whole catalog.
    intersects: GeometryValue = Field(
        default=None, description="GeoJSON geometry (URL-encoded)"
    )
    sortby: SortBy = Field(default=None, description="e.g. -properties.updated")
    bbox_boost: BboxCsv = Field(default=None, description=BboxBoostDescription)
    limit: int = Field(default=DEFAULT_LIMIT, description=LIMIT_DESCRIPTION)
    offset: int = Field(default=0, ge=0)

    def to_search_params(
        self, registry: QueryableRegistry, *, limit: int
    ) -> SearchParams:
        return self._base_params(
            registry,
            default_filter_lang="cql2-text",
            collections=self.source,
            ids=self.ids,
            intersects=self.intersects,
            sortby=self.sortby,
            bbox_boost=self.bbox_boost,
            limit=limit,
            offset=self.offset,
        )


class AggregateQuery(_FilterMixin):
    """``GET /stac/aggregate`` parameters.

    The same predicates as Item Search minus everything that only shapes a
    result page (``sortby``, ``limit``/``offset``, ``bbox_boost``):
    an aggregation counts the whole matching set.
    """

    collections: CsvList = Field(default=None, description="Collection ids")
    ids: CsvList = Field(default=None, description="Item ids")
    intersects: GeometryValue = Field(
        default=None, description="GeoJSON geometry (URL-encoded for GET)"
    )
    aggregations: CsvList = Field(
        default=None, description="Aggregation names (default: all)"
    )
    unit: Literal["items", "collections"] = Field(
        default="items",
        description=(
            "What a count counts: 'items' counts layers, 'collections' counts"
            " datasets. A client listing datasets must ask for 'collections', or"
            " its facet counts describe a different set of things than its"
            " results (10,793 layers live in 3,834 datasets)."
        ),
    )

    def to_search_params(self, registry: QueryableRegistry) -> SearchParams:
        return self._base_params(
            registry,
            default_filter_lang="cql2-text",
            collections=self.collections,
            ids=self.ids,
            intersects=self.intersects,
        )
