"""The catalog pack (spec §7.2): search with facets, describe the catalog, get a
record, suggest terms, look up a region, show the recommended records as cards,
and a proposal that sets the catalog page's search (or, from another page, opens
the catalog with it).

The first four were the catalog service's MCP tools; they now call the catalog
over its HTTP API with the user's token (spec §9.1.1) and keep that module's
result shaping, caps and descriptions. Catalog metadata is not a data value in
the sense of the data policy, so none of these is flagged ``returns_data``.
"""

import asyncio
import json
import logging
from datetime import date
from typing import Annotated, Any
from urllib.parse import quote

from pydantic import BaseModel, ConfigDict, Field, RootModel, field_validator
from pydantic_ai.exceptions import ToolFailed

from assistant.context import (
    NUTS_ID_PATTERN,
    RECORD_ID_PATTERN,
    SORTBY_PATTERN,
    FacetKey,
    FacetValues,
)
from assistant.llm import failures
from assistant.surfaces import SURFACES, Surface
from assistant.tools.ask import users_dataset
from assistant.tools.http import ServiceError
from assistant.tools.proposals import (
    CatalogFiltersPayload,
    Proposal,
    ProposalRow,
    ProposalShown,
    facet_row,
    proposal_row,
    show,
)
from assistant.tools.runtime import MAX_RESULT_BYTES, InputInvalid, ToolEnv, ToolSpec

logger = logging.getLogger(__name__)

#: Every surface: the public catalog is searchable from any page, and a filter
#: suggestion opens the catalog from pages other than the catalog itself.
CATALOG_SURFACES: frozenset[Surface] = frozenset(SURFACES)

_MAX_RESULT_ITEMS = 5000
#: Left free below the hard limit in ``execute``: the cap counts bytes one way
#: and the executor another (ASCII escapes, wrappers), so the two never meet.
_RESULT_MARGIN_BYTES = 8 * 1024
#: A page of search results; more come with ``offset``. Each result is resent
#: with every later model call of the answer.
_MAX_SEARCH_LIMIT = 20
#: A search result's description, as one line cut to this many characters.
#: Every later model call of the answer resends the results, and full
#: descriptions (often long German texts) made one answer cost hundreds of
#: thousands of tokens. ``catalog_get_record`` returns the full text.
_SEARCH_DESCRIPTION_CHARS = 160
#: For the same reason, per facet only the most frequent values (publishers
#: alone run into the hundreds).
_SEARCH_FACET_VALUES = 10
#: Decimals of a search result's bbox: about a kilometre, enough to tell where
#: a dataset lies.
_SEARCH_BBOX_DECIMALS = 2
_SORTABLE_TYPES = frozenset({"string", "number", "integer", "boolean"})

#: Filter descriptions, from ``catalog.routers.params.FacetFilters``: HTTP has no
#: parameter-to-property map, and these parameters are declared statically there too.
FILTER_DESCRIPTIONS: dict[str, str] = {
    "themes": "Thematic categories, comma-separated",
    "language": "Metadata language",
    "year": "Calendar year of the data",
    "license": "SPDX license identifiers",
    "publisher": "Publishing organisations",
    "type": "feature | table | raster",
    "geometry_type": "Geometry type of the layer",
    "geographical_code": "Country or region codes",
}
#: Scalar filters that are not facets, so ``/aggregations`` does not list them.
_NON_FACET_FILTERS = {"year": "integer"}


def _json_size(value: object) -> int:
    return len(json.dumps(value, separators=(",", ":"), default=str))


def _cap_items(
    items: list[dict[str, Any]], *, reserved: int = 0
) -> tuple[list[dict[str, Any]], bool]:
    """Trim ``items`` to at most ``_MAX_RESULT_ITEMS`` entries that fit the result
    limit next to the rest of the result (``reserved`` bytes of serialized JSON)
    and a margin, so ``execute`` never has to refuse what was already trimmed.
    Returns ``(kept, truncated)``."""
    truncated = len(items) > _MAX_RESULT_ITEMS
    kept: list[dict[str, Any]] = []
    budget = MAX_RESULT_BYTES - _RESULT_MARGIN_BYTES - reserved
    size = 64
    for item in items[:_MAX_RESULT_ITEMS]:
        item_bytes = _json_size(item) + 1
        if size + item_bytes > budget:
            truncated = True
            break
        kept.append(item)
        size += item_bytes
    return kept, truncated


def _clip(text: Any, limit: int) -> Any:
    if not isinstance(text, str) or len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def _top_facets(aggregations: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    """Each facet with its ``limit`` most frequent values; a facet that had more
    says how many in ``total_values``."""
    out = []
    for facet in aggregations:
        buckets = facet.get("buckets")
        if not isinstance(buckets, list) or len(buckets) <= limit:
            out.append(facet)
            continue
        top = sorted(buckets, key=lambda b: -(b.get("frequency") or 0))[:limit]
        out.append({**facet, "buckets": top, "total_values": len(buckets)})
    return out


def _trim_dataset(collection: dict[str, Any]) -> dict[str, Any]:
    """Reduce a full STAC Collection to the fields useful for an LLM.

    A dataset *is* a Collection, so this reads the dataset's own metadata rather
    than a designated layer's.
    """
    contacts = [c for c in collection.get("contacts") or [] if isinstance(c, dict)]
    publisher = next(
        (c for c in contacts if "publisher" in (c.get("roles") or [])),
        contacts[0] if contacts else None,
    )
    providers = [p for p in collection.get("providers") or [] if isinstance(p, dict)]
    producer = next(
        (p for p in providers if "producer" in (p.get("roles") or [])),
        providers[0] if providers else None,
    )
    keywords = [
        kw.get("value") if isinstance(kw, dict) else kw
        for kw in collection.get("keywords") or []
    ]
    themes = [
        concept.get("id")
        for theme in collection.get("themes") or []
        for concept in (theme.get("concepts") or [])
        if isinstance(concept, dict)
    ]
    language = collection.get("language")
    if isinstance(language, dict):
        language = language.get("code")
    spatial = ((collection.get("extent") or {}).get("spatial") or {}).get("bbox") or []
    return {
        "id": collection.get("id"),
        "title": collection.get("title"),
        "description": collection.get("description"),
        "type": collection.get("goat:layerType"),
        "publisher": (publisher or producer or {}).get("name") or None,
        "license": collection.get("license"),
        "keywords": [kw for kw in keywords if kw] or None,
        "themes": themes or None,
        "language": language,
        "updated": collection.get("updated"),
        "bbox": spatial[0] if spatial else None,
        "member_count": collection.get("goat:member_count") or 1,
    }


def _years(collection: dict[str, Any]) -> str | None:
    """The dataset's temporal extent in years: '2024', '2018-2024', 'from 2018'
    or 'until 2024'."""
    temporal = (collection.get("extent") or {}).get("temporal") or {}
    intervals = temporal.get("interval")
    first = (
        intervals[0]
        if isinstance(intervals, list) and intervals and isinstance(intervals[0], list)
        else []
    )
    start, end = (
        value[:4] if isinstance(value, str) and value[:4].isdigit() else None
        for value in (first + [None, None])[:2]
    )
    if start and end:
        return start if start == end else f"{start}-{end}"
    if start:
        return f"from {start}"
    return f"until {end}" if end else None


def _search_row(collection: dict[str, Any]) -> dict[str, Any]:
    """A search result: enough to tell whether a dataset fits, nothing more.
    License, keywords and the full description come with ``catalog_get_record``."""
    dataset = _trim_dataset(collection)
    description = dataset["description"]
    bbox = dataset["bbox"]
    row = {
        "id": dataset["id"],
        "title": dataset["title"],
        "description": (
            _clip(" ".join(description.split()), _SEARCH_DESCRIPTION_CHARS)
            if isinstance(description, str)
            else None
        )
        or None,
        "type": dataset["type"],
        "publisher": dataset["publisher"],
        "years": _years(collection),
        "bbox": (
            [round(value, _SEARCH_BBOX_DECIMALS) for value in bbox]
            if isinstance(bbox, list)
            and all(isinstance(value, int | float) for value in bbox)
            else None
        ),
        "member_count": dataset["member_count"]
        if dataset["member_count"] > 1
        else None,
    }
    return {key: value for key, value in row.items() if value is not None}


def _note_found(env: ToolEnv, records: list[Any]) -> None:
    """Keeps the title of each catalog dataset a result shows the model, by
    id (``ToolEnv.catalog_titles``): a card option that names one adds it."""
    for record in records:
        if not isinstance(record, dict):
            continue
        item, title = record.get("id"), record.get("title")
        if title is None and isinstance(record.get("properties"), dict):
            title = record["properties"].get("title")
        if isinstance(item, str) and isinstance(title, str) and title.strip():
            env.catalog_titles[item] = title


def _sortable(queryables: dict[str, Any]) -> list[str]:
    """The names a ``sortby`` may use, from the catalog's queryables document."""
    return sorted(
        name
        for name, schema in (queryables.get("properties") or {}).items()
        if isinstance(schema, dict) and schema.get("type") in _SORTABLE_TYPES
    )


async def _get(env: ToolEnv, path: str, params: dict[str, object] | None = None) -> Any:
    return await env.call("catalog", "GET", f"/stac{path}", params=params)


def _rejection(env: ToolEnv, what: str, exc: ServiceError) -> InputInvalid:
    """A catalog 400 is the model's to fix: the catalog says which argument."""
    return InputInvalid(
        f"The catalog rejected {what}: {failures.redact(exc.detail, env.secrets())}"
    )


def _relative(value: Any, base: str) -> Any:
    """Hrefs the catalog built from its own address become paths on it, so
    neither the model nor an MCP client is shown an internal host name."""
    if isinstance(value, str):
        if value == base:
            return "/"
        return value[len(base) :] if value.startswith(base + "/") else value
    if isinstance(value, list):
        return [_relative(item, base) for item in value]
    if isinstance(value, dict):
        return {key: _relative(item, base) for key, item in value.items()}
    return value


# -- catalog.search ------------------------------------------------------------


class SearchInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    q: str | None = Field(
        default=None,
        description=(
            "Free text over title, description and keywords: spaces mean AND, "
            "commas OR ('radweg,fahrrad,cycle'), rows matching several alternatives "
            "rank first, so one search with a topic's German and English words "
            "covers it. Substring match in any case: prefer the shorter stem "
            "('grünfläche' finds 'Grünflächen', not the reverse). Prefer a "
            "structured filter when catalog_describe shows a matching value."
        ),
    )
    bbox: str | None = Field(
        default=None,
        description="Spatial filter 'west,south,east,north' in WGS84 lon/lat.",
    )
    bbox_boost: str | None = Field(
        default=None,
        description="'west,south,east,north' for ranking only (nothing excluded).",
    )
    themes: str | None = Field(
        default=None,
        description=(
            "Comma-separated categories (catalog_describe lists them), e.g. "
            "transportation, environment."
        ),
    )
    language: str | None = Field(
        default=None, description="ISO 639-1 code, e.g. 'de' or 'en'."
    )
    year: int | None = Field(
        default=None, description="Data reference year, e.g. 2023."
    )
    license: str | None = Field(default=None, description="Comma-separated licenses.")
    publisher: str | None = Field(
        default=None, description="Comma-separated publisher/distributor names."
    )
    type: str | None = Field(
        default=None,
        description=("Comma-separated layer types: feature, raster, table, bundle."),
    )
    geographical_code: str | None = Field(
        default=None, description="Comma-separated ISO 3166-1 alpha-2 codes."
    )
    nuts: list[Annotated[str, Field(pattern=NUTS_ID_PATTERN)]] = Field(
        default_factory=list,
        max_length=20,
        description=(
            "Region ids from catalog_find_region: a state, a district or a "
            "district-free city; datasets whose area intersects them."
        ),
    )
    geometry_type: str | None = Field(
        default=None,
        description=(
            "Comma-separated: point, line, polygon; a dataset matches when any of "
            "its layers has it."
        ),
    )
    datetime: str | None = Field(
        default=None,
        description="RFC 3339 instant or interval, e.g. '2023-01-01/2024-12-31'.",
    )
    sortby: str | None = Field(
        default=None, description="e.g. '-updated'; prefix '-' for descending."
    )
    limit: int = Field(
        default=10, description="Max datasets to return (1-20, default 10)."
    )
    offset: int = Field(
        default=0, description="Number of datasets to skip for pagination."
    )


#: The note of a search that found nothing, in place of its facet lists, which
#: would all be empty: what an empty result means and when to stop searching.
NOTHING_FOUND = (
    "Nothing matches. q finds its words inside titles, descriptions and keywords, "
    "in any case and also within longer words; of words joined by spaces all must "
    "match, of words separated by commas one is enough. Search once more only if q "
    "joined words with spaces or lacked the topic's German or English word, then "
    "with them separated by commas. Otherwise the catalog has no such dataset for "
    "these filters: say so, and in a workflow leave that dataset step open."
)


class SearchResult(BaseModel):
    number_matched: int = Field(serialization_alias="numberMatched")
    number_returned: int = Field(serialization_alias="numberReturned")
    truncated: bool
    results: list[dict[str, Any]]
    #: Only with the first page of a search that found something: later pages
    #: share its filters, so the counts would only repeat.
    facets: list[dict[str, Any]] | None = None
    #: What a search that found nothing means (``NOTHING_FOUND``).
    note: str | None = None


_FILTER_FIELDS = (
    "q",
    "bbox",
    "datetime",
    "themes",
    "language",
    "year",
    "license",
    "publisher",
    "type",
    "geographical_code",
    "geometry_type",
)


async def _search(env: ToolEnv, args: SearchInput) -> SearchResult:
    limit = max(1, min(args.limit, _MAX_SEARCH_LIMIT))
    offset = max(args.offset, 0)
    filters: dict[str, object] = {name: getattr(args, name) for name in _FILTER_FIELDS}
    filters["nuts"] = ",".join(args.nuts) or None
    page_params = {
        **filters,
        "bbox_boost": args.bbox_boost,
        "sortby": args.sortby,
        "limit": limit,
        "offset": offset,
    }
    # Collection Search, not Item Search: one row per dataset, and the facet
    # counts in the same unit, so a count and its result set agree.
    try:
        if offset:
            page, aggregated = await _get(env, "/collections", page_params), None
        else:
            page, aggregated = await asyncio.gather(
                _get(env, "/collections", page_params),
                _get(env, "/aggregate", {**filters, "unit": "collections"}),
            )
    except ServiceError as exc:
        if exc.status == 400:
            raise _rejection(env, "this search", exc) from exc
        raise
    facets = (
        _top_facets(aggregated.get("aggregations", []), _SEARCH_FACET_VALUES)
        if aggregated is not None
        else None
    )
    trimmed, truncated = _cap_items(
        [_search_row(c) for c in page.get("collections", [])],
        reserved=_json_size(facets or []),
    )
    matched = int(page.get("numberMatched") or 0)
    _note_found(env, trimmed)
    return SearchResult(
        number_matched=matched,
        number_returned=len(trimmed),
        truncated=truncated,
        results=trimmed,
        facets=facets if matched else None,
        note=None if matched else NOTHING_FOUND,
    )


def _no_datasets(result: dict[str, Any]) -> bool:
    return not result.get("numberMatched")


SEARCH: ToolSpec[SearchInput, SearchResult] = ToolSpec(
    name="catalog.search",
    description=(
        "Search the GOAT data catalog: one row per dataset (member_count: several "
        "layers bundled under it) and, with the first page, facet counts over the "
        "same filters, so counts and results agree. Rows are short (one line of "
        "description, years, bbox); facets list their most frequent values "
        "(total_values says how many). catalog_get_record(id) has the full record, "
        "catalog_describe() every filter value. Place names in q only match "
        "datasets whose text names the place: pass the place's region as nuts. "
        "Search the topic broadly (cycling: 'rad,fahrrad,radverkehr')."
    ),
    input_model=SearchInput,
    output_model=SearchResult,
    run=_search,
    surfaces=CATALOG_SURFACES,
    returns_data=False,
    mcp=True,
    found_nothing=_no_datasets,
)


# -- catalog.describe ----------------------------------------------------------


class DescribeInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    max_values: int = Field(
        default=40,
        ge=1,
        le=200,
        description=(
            "Maximum distinct values to list per filter (most frequent first). "
            "Filters with more values than this are marked truncated."
        ),
    )


class DescribeResult(BaseModel):
    items: int
    collections: int
    filters: list[dict[str, Any]]
    sortable: list[str]
    aggregations: list[str]


async def _describe(env: ToolEnv, args: DescribeInput) -> DescribeResult:
    discovery, aggregated, queryables, collections, items = await asyncio.gather(
        _get(env, "/aggregations", {"unit": "collections"}),
        _get(env, "/aggregate", {"unit": "collections"}),
        # The collection registry: `sortby` is applied to datasets.
        _get(env, "/queryables", {"unit": "collections"}),
        _get(env, "/collections", {"limit": 1}),
        _get(env, "/search", {"limit": 1}),
    )
    # `{aggregation name: the parameter that narrows it}`, as the catalog
    # publishes it: never the name minus "_count" (`category_count` is `?themes=`).
    param_of = {
        entry["name"]: entry["goat:filter_param"]
        for entry in discovery.get("aggregations", [])
        if entry.get("goat:filter_param")
    }
    buckets_of = {
        param_of[entry["name"]]: entry["buckets"]
        for entry in aggregated.get("aggregations", [])
        if entry.get("buckets") is not None and entry.get("name") in param_of
    }
    filters: list[dict[str, Any]] = []
    for param in sorted(set(buckets_of) | set(_NON_FACET_FILTERS)):
        entry: dict[str, Any] = {
            "parameter": param,
            "description": FILTER_DESCRIPTIONS.get(param),
            "type": _NON_FACET_FILTERS.get(param, "string"),
        }
        buckets = buckets_of.get(param)
        if buckets is not None:
            entry["values"] = [
                {"value": bucket["key"], "count": bucket["frequency"]}
                for bucket in buckets[: args.max_values]
            ]
            entry["truncated"] = len(buckets) > args.max_values
        filters.append(entry)
    return DescribeResult(
        items=int(items.get("numberMatched") or 0),
        collections=int(collections.get("numberMatched") or 0),
        filters=filters,
        sortable=_sortable(queryables),
        aggregations=[entry["name"] for entry in discovery.get("aggregations", [])],
    )


DESCRIBE: ToolSpec[DescribeInput, DescribeResult] = ToolSpec(
    name="catalog.describe",
    description=(
        "List the catalog's filters and the values they actually hold; every value "
        "is a valid argument to the catalog_search parameter of the same name. "
        "Call it before searching, to map the user's words onto real values "
        "instead of guessing keywords."
    ),
    input_model=DescribeInput,
    output_model=DescribeResult,
    run=_describe,
    surfaces=CATALOG_SURFACES,
    returns_data=False,
    mcp=True,
)


# -- catalog.suggest_terms -----------------------------------------------------


class SuggestInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prefix: str = Field(
        max_length=100, description="Word beginning, e.g. 'radver'. Case-insensitive."
    )
    limit: int = Field(default=10, description="Maximum titles to return.")


class TermMatch(BaseModel):
    title: str | None
    id: str


#: The note of a prefix no word starts with.
NO_SUCH_WORD = "No dataset's text has a word starting with this prefix."


class SuggestResult(BaseModel):
    prefix: str
    matches: list[TermMatch]
    note: str | None = None


async def _suggest(env: ToolEnv, args: SuggestInput) -> SuggestResult:
    body = await _get(env, "/suggest", {"prefix": args.prefix, "limit": args.limit})
    result = SuggestResult.model_validate(body)
    if not result.matches:
        result.note = NO_SUCH_WORD
    return result


def _no_words(result: dict[str, Any]) -> bool:
    return not result.get("matches")


SUGGEST_TERMS: ToolSpec[SuggestInput, SuggestResult] = ToolSpec(
    name="catalog.suggest_terms",
    description=(
        "Check cheaply whether a word occurs in the catalog: returns titles of "
        "datasets whose text has a word starting with prefix. German compounds "
        "('Radverkehrsnetz') often need a shorter stem than the user's word."
    ),
    input_model=SuggestInput,
    output_model=SuggestResult,
    run=_suggest,
    surfaces=CATALOG_SURFACES,
    returns_data=False,
    mcp=True,
    found_nothing=_no_words,
)


# -- catalog.get_record --------------------------------------------------------


class GetRecordInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    #: Catalog ids are slugs; the pattern keeps an id a single path segment.
    item_id: str = Field(
        pattern=RECORD_ID_PATTERN, description="An id from catalog_search results."
    )

    @field_validator("item_id")
    @classmethod
    def _not_a_dot_segment(cls, value: str) -> str:
        if value in (".", ".."):
            raise ValueError("not a catalog id")
        return value


class CatalogRecord(RootModel[dict[str, Any]]):
    pass


#: What a record keeps of its layers, and how many layers and fields it lists.
#: The full STAC documents carry each layer's geometry, links and assets: one
#: bundle came to 150 000 characters, resent with every later model call. The
#: dataset itself keeps its links and assets (the source page, the downloads).
_RECORD_DROP = ("stac_extensions", "geometry")
_RECORD_MEMBERS = 25
_RECORD_COLUMNS = 60
_MEMBER_DESCRIPTION_CHARS = 300


def _compact_columns(columns: Any) -> Any:
    if not isinstance(columns, list):
        return columns
    keep = ("name", "type", "description")
    return [
        {key: column[key] for key in keep if column.get(key) is not None}
        for column in columns[:_RECORD_COLUMNS]
        if isinstance(column, dict)
    ]


def _compact_member(item: dict[str, Any]) -> dict[str, Any]:
    """A layer of a record: what it is and which fields it has, without its
    geometry, links and assets."""
    props = item.get("properties") or {}
    columns = props.get("table:columns")
    return {
        "id": item.get("id"),
        "title": props.get("title"),
        "description": _clip(props.get("description"), _MEMBER_DESCRIPTION_CHARS),
        "geometry_type": props.get("goat:geometryType"),
        "row_count": props.get("table:row_count"),
        "bbox": item.get("bbox"),
        "columns": _compact_columns(columns),
        "columns_truncated": isinstance(columns, list)
        and len(columns) > _RECORD_COLUMNS,
    }


def _compact_record(document: dict[str, Any]) -> dict[str, Any]:
    out = {key: value for key, value in document.items() if key not in _RECORD_DROP}
    props = out.get("properties")
    if isinstance(props, dict) and "table:columns" in props:
        out["properties"] = {
            **props,
            "table:columns": _compact_columns(props["table:columns"]),
        }
    return out


async def _get_record(env: ToolEnv, args: GetRecordInput) -> CatalogRecord:
    try:
        resolved = await _get(env, f"/resolve/{quote(args.item_id, safe='')}")
    except ServiceError as exc:
        if exc.status == 404:
            # Asked on this failure alone: a dataset id from core_find looks
            # like a catalog id.
            if await users_dataset(env, args.item_id):
                raise ToolFailed(
                    f"Catalog record {args.item_id!r} not found: it is a dataset "
                    "of the user's own (core_find lists it), not a catalog "
                    "record. On a project page, project_add_dataset adds it."
                ) from exc
            raise ToolFailed(f"Catalog record {args.item_id!r} not found") from exc
        raise
    base = str(env.services.catalog.base_url).rstrip("/")
    if resolved.get("kind") == "item":
        item = _relative(_compact_record(resolved["item"]), base)
        _note_found(env, [item])
        return CatalogRecord(item)
    collection = _relative(_compact_record(dict(resolved["collection"])), base)
    all_members = [m for m in resolved.get("items") or [] if isinstance(m, dict)]
    members = _relative(
        [_compact_member(m) for m in all_members[:_RECORD_MEMBERS]], base
    )
    member_count = int(resolved.get("goat:member_count") or len(all_members))
    # Two sources of truncation can apply: the catalog caps the members it
    # returns, and `_cap_items` caps again for transport size, next to the
    # collection's own metadata.
    kept, cap_truncated = _cap_items(members, reserved=_json_size(collection))
    collection["goat:items"] = kept
    collection["goat:items_truncated"] = member_count > len(members) or cap_truncated
    collection["goat:member_count"] = member_count
    _note_found(env, [collection, *kept])
    return CatalogRecord(collection)


GET_RECORD: ToolSpec[GetRecordInput, CatalogRecord] = ToolSpec(
    name="catalog.get_record",
    description=(
        "The full catalog record for an id from catalog_search: description, "
        "license, keywords, extent. A bundle lists its member layers under "
        "goat:items, each with title, short description, geometry type, row "
        "count, extent and fields; never geometry, links or assets."
    ),
    input_model=GetRecordInput,
    output_model=CatalogRecord,
    run=_get_record,
    surfaces=CATALOG_SURFACES,
    returns_data=False,
    mcp=True,
)


# -- catalog.propose_filters ---------------------------------------------------


class ProposeFiltersInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(
        min_length=1,
        max_length=80,
        description="A short title for the suggestion card, in the user's language.",
    )
    q: str | None = Field(
        default=None,
        max_length=500,
        description="Search text, as for catalog_search.",
    )
    facets: dict[FacetKey, FacetValues] = Field(
        default_factory=dict,
        max_length=20,
        description=(
            "Filter values per facet parameter, e.g. {'themes': ['transportation'], "
            "'license': ['CC-BY-4.0']}. Use parameters and values catalog_describe() lists."
        ),
    )
    from_date: date | None = Field(
        default=None, description="Start of the data's time range, YYYY-MM-DD."
    )
    to_date: date | None = Field(
        default=None, description="End of the data's time range, YYYY-MM-DD."
    )
    nuts: list[Annotated[str, Field(pattern=NUTS_ID_PATTERN)]] = Field(
        default_factory=list,
        max_length=20,
        description=(
            "NUTS region ids from catalog_find_region, such as a state's or a "
            "district's."
        ),
    )
    sortby: str | None = Field(
        default=None,
        max_length=100,
        pattern=SORTBY_PATTERN,
        description=(
            "e.g. '-updated'; fields must be in the sortable list of "
            "catalog_describe. Leave out for relevance."
        ),
    )


def _interval(start: date | None, end: date | None) -> str | None:
    if start is None and end is None:
        return None
    left = f"{start.isoformat()}T00:00:00Z" if start else ".."
    right = f"{end.isoformat()}T23:59:59Z" if end else ".."
    return f"{left}/{right}"


def _squash(value: str) -> str:
    return "".join(ch for ch in value.casefold() if ch.isalnum())


def _canonical_facets(
    facets: dict[str, list[str]], values_doc: dict[str, Any]
) -> dict[str, list[str]]:
    """Each facet value as the catalog spells it. An exact match stays; a match
    up to case and punctuation, or the one value it is the start of (ODbL for
    ODbL-1.0), takes the catalog's spelling; anything else is the model's to
    fix, with the values it may use."""
    by_param = {
        entry.get("goat:filter_param"): [
            str(bucket.get("key"))
            for bucket in entry.get("buckets") or []
            if bucket.get("key") is not None
        ]
        for entry in values_doc.get("aggregations", [])
    }
    out: dict[str, list[str]] = {}
    for key, values in facets.items():
        valid = by_param.get(key)
        if not valid:
            # A filter without a value list (geographical_code here) is checked
            # by the search alone.
            out[key] = values
            continue
        mapped: list[str] = []
        for value in values:
            if value in valid:
                mapped.append(value)
                continue
            squashed = _squash(value)
            same = [v for v in valid if _squash(v) == squashed]
            starts = [v for v in valid if squashed and _squash(v).startswith(squashed)]
            if len(same) == 1:
                mapped.append(same[0])
            elif not same and len(starts) == 1:
                mapped.append(starts[0])
            else:
                near = [v for v in valid if squashed and squashed in _squash(v)]
                listed = (near or valid)[:20]
                more = "" if len(near or valid) <= 20 else ", ..."
                label = "Close values" if near else "Values"
                raise InputInvalid(
                    f"The catalog has no {key} {value!r}. {label}: "
                    f"{', '.join(listed)}{more}."
                )
        out[key] = list(dict.fromkeys(mapped))
    return out


async def _propose_filters(env: ToolEnv, args: ProposeFiltersInput) -> ProposalShown:
    if args.from_date and args.to_date and args.from_date > args.to_date:
        raise InputInvalid("from_date must be on or before to_date.")
    facets = {key: values for key, values in args.facets.items() if values}
    # The filter names and every filter's values first: a value the catalog does
    # not have (ODbL for ODbL-1.0) would make a card that matches nothing.
    discovery: Any
    values_doc: Any
    discovery, values_doc = await asyncio.gather(
        _get(env, "/aggregations", {"unit": "collections"}),
        _get(env, "/aggregate", {"unit": "collections"}),
    )
    known = sorted(
        {
            entry["goat:filter_param"]
            for entry in discovery.get("aggregations", [])
            if entry.get("goat:filter_param")
        }
    )
    for key in facets:
        if key == "year":
            raise InputInvalid(
                "'year' is not a facet filter. Use from_date and to_date for a time range."
            )
        if key not in known:
            raise InputInvalid(f"Unknown filter {key!r}. Filters: {', '.join(known)}.")
    facets = _canonical_facets(facets, values_doc)
    # The search is the validation: what the page will show is what the card says.
    try:
        outcome: Any = await _get(
            env,
            "/collections",
            {
                "q": args.q,
                **{key: ",".join(values) for key, values in facets.items()},
                "datetime": _interval(args.from_date, args.to_date),
                "nuts": ",".join(args.nuts) or None,
                "sortby": args.sortby,
                "limit": 1,
            },
        )
    except ServiceError as exc:
        if exc.status == 400:
            raise _rejection(env, "these filters", exc) from exc
        raise
    page = outcome
    matched = int(page.get("numberMatched") or 0)
    rows: list[ProposalRow] = []
    if args.q:
        rows.append(proposal_row("q", args.q))
    rows.extend(facet_row(key, values) for key, values in facets.items())
    if args.from_date:
        rows.append(proposal_row("from", args.from_date.isoformat()))
    if args.to_date:
        rows.append(proposal_row("to", args.to_date.isoformat()))
    if args.nuts:
        rows.append(proposal_row("nuts", ", ".join(args.nuts)))
    if args.sortby:
        rows.append(proposal_row("sortby", args.sortby))
    rows.append(proposal_row("number_matched", str(matched)))
    proposal = Proposal(
        kind="catalog.filters",
        surface="catalog",
        target=None,
        title=args.title,
        rows=rows,
        payload=CatalogFiltersPayload(
            q=args.q,
            facets=facets,
            from_date=args.from_date,
            to_date=args.to_date,
            nuts=args.nuts,
            sortby=args.sortby,
            number_matched=matched,
        ),
    )
    return await show(env, proposal, number_matched=matched)


PROPOSE_FILTERS: ToolSpec[ProposeFiltersInput, ProposalShown] = ToolSpec(
    name="catalog.propose_filters",
    description=(
        "Suggest a catalog search and filters as a card; nothing changes unless "
        "the user acts on it (apply on the catalog page, open the catalog "
        "elsewhere). Use it when the user wants to see datasets in the catalog, "
        "not only in your answer. The result says how many datasets match."
    ),
    input_model=ProposeFiltersInput,
    output_model=ProposalShown,
    run=_propose_filters,
    surfaces=CATALOG_SURFACES,
    returns_data=False,
    risk="propose",
)

# -- catalog.find_region -------------------------------------------------------

_MAX_REGIONS = 10

#: The NUTS countries by their English and German names. NUTS names a country
#: only in its own languages ('Shqipëria'), so a question about "Albania" found
#: no region and the model went on guessing other searches.
_COUNTRY_NAMES: dict[str, tuple[str, ...]] = {
    "AL": ("Albania", "Albanien"),
    "AT": ("Austria", "Österreich"),
    "BA": ("Bosnia and Herzegovina", "Bosnia", "Bosnien und Herzegowina", "Bosnien"),
    "BE": ("Belgium", "Belgien"),
    "BG": ("Bulgaria", "Bulgarien"),
    "CH": ("Switzerland", "Schweiz"),
    "CY": ("Cyprus", "Zypern"),
    "CZ": ("Czechia", "Czech Republic", "Tschechien"),
    "DE": ("Germany", "Deutschland"),
    "DK": ("Denmark", "Dänemark"),
    "EE": ("Estonia", "Estland"),
    "EL": ("Greece", "Griechenland"),
    "ES": ("Spain", "Spanien"),
    "FI": ("Finland", "Finnland"),
    "FR": ("France", "Frankreich"),
    "HR": ("Croatia", "Kroatien"),
    "HU": ("Hungary", "Ungarn"),
    "IE": ("Ireland", "Irland"),
    "IS": ("Iceland", "Island"),
    "IT": ("Italy", "Italien"),
    "LI": ("Liechtenstein",),
    "LT": ("Lithuania", "Litauen"),
    "LU": ("Luxembourg", "Luxemburg"),
    "LV": ("Latvia", "Lettland"),
    "ME": ("Montenegro",),
    "MK": ("North Macedonia", "Nordmazedonien"),
    "MT": ("Malta",),
    "NL": ("Netherlands", "Niederlande"),
    "NO": ("Norway", "Norwegen"),
    "PL": ("Poland", "Polen"),
    "PT": ("Portugal",),
    "RO": ("Romania", "Rumänien"),
    "RS": ("Serbia", "Serbien"),
    "SE": ("Sweden", "Schweden"),
    "SI": ("Slovenia", "Slowenien"),
    "SK": ("Slovakia", "Slowakei"),
    "TR": ("Türkiye", "Turkey", "Türkei"),
    "UA": ("Ukraine",),
    "XK": ("Kosovo",),
}


class FindRegionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(
        min_length=2,
        max_length=80,
        description=(
            "The place in its local spelling, as its own country writes it; a "
            "country also in English or German. Part of the name is enough."
        ),
    )


class Region(BaseModel):
    nuts_id: str
    name: str
    #: 0 country, 1 state (Bundesland), 2 Regierungsbezirk, 3 district or
    #: district-free city.
    level: int
    country: str | None = None
    #: The names of the state and the country the region lies in, nearest
    #: first; only those the catalog returned by their ids, None for neither.
    parents: list[str] | None = None


class FindRegionResult(BaseModel):
    regions: list[Region]


#: A region's parents: its state (level 1) and its country (level 0).
_PARENT_LEVELS = (1, 0)
#: The catalog's largest page. A parent is looked up by its id, which also
#: matches as part of other ids and names, so every match is asked for and
#: the exact one picked.
_ALL_MATCHES = 100


def _parent_ids(nuts_id: str, level: int) -> list[str]:
    """The ids of a region's state and country, nearest first: a NUTS id is
    its country's two letters and one character more per level, so its
    parents are its prefixes."""
    return [nuts_id[: 2 + parent] for parent in _PARENT_LEVELS if parent < level]


async def _parent_rows(env: ToolEnv, parent: str) -> Any:
    """The catalog's matches of a parent's id; None when it cannot be asked
    now, so the parent is left out as one it does not have and the regions
    found are still the answer."""
    try:
        return await _get(
            env, "/nuts", {"q": parent, "level": len(parent) - 2, "limit": _ALL_MATCHES}
        )
    except ToolFailed:
        logger.warning("Looking up the NUTS region %r failed", parent, exc_info=True)
        return None


async def _parent_names(env: ToolEnv, regions: list[Region]) -> dict[str, str]:
    """The names of the regions' parents by id, each looked up once, side
    by side; a parent among the regions found needs no lookup, and one the
    catalog does not return by its exact id is left out."""
    names = {region.nuts_id: region.name for region in regions}
    wanted = sorted(
        {
            parent
            for region in regions
            for parent in _parent_ids(region.nuts_id, region.level)
        }
        - names.keys()
    )
    answers = await asyncio.gather(*(_parent_rows(env, parent) for parent in wanted))
    for parent, rows in zip(wanted, answers, strict=True):
        for row in rows or []:
            if (
                isinstance(row, dict)
                and row.get("nuts_id") == parent
                and row.get("nuts_name")
            ):
                names[parent] = str(row["nuts_name"])
    return names


async def _find_region(env: ToolEnv, args: FindRegionInput) -> FindRegionResult:
    name = args.name.strip()
    squashed = _squash(name)
    country = next(
        (
            code
            for code, names in _COUNTRY_NAMES.items()
            if any(_squash(known) == squashed for known in names)
        ),
        None,
    )
    by_name = _get(env, "/nuts", {"q": name, "limit": _MAX_REGIONS})
    if country is None:
        rows = await by_name
    else:
        # The country leads: it is what the user named. Its id also matches
        # other countries' names ('EL' in 'België'), so the exact one is picked.
        countries, named = await asyncio.gather(
            _get(env, "/nuts", {"q": country, "level": 0, "limit": _MAX_REGIONS}),
            by_name,
        )
        rows = [
            row
            for row in countries or []
            if isinstance(row, dict) and row.get("nuts_id") == country
        ] + list(named or [])
    regions: dict[str, Region] = {}
    for row in rows or []:
        if isinstance(row, dict) and row.get("nuts_id"):
            regions.setdefault(
                row["nuts_id"],
                Region(
                    nuts_id=row["nuts_id"],
                    name=row["nuts_name"],
                    level=int(row["level"]),
                    country=row.get("country"),
                ),
            )
    found = list(regions.values())[:_MAX_REGIONS]
    names = await _parent_names(env, found)
    for region in found:
        parents = [
            names[parent]
            for parent in _parent_ids(region.nuts_id, region.level)
            if parent in names
        ]
        region.parents = parents or None
    return FindRegionResult(regions=found)


FIND_REGION: ToolSpec[FindRegionInput, FindRegionResult] = ToolSpec(
    name="catalog.find_region",
    description=(
        "Look up a place's NUTS region ids to filter catalog_search (nuts) or a "
        "filter suggestion by area. Levels: 0 country, 1 state, 2 government "
        "region, 3 district or district-free city ('<city>, Kreisfreie "
        "Stadt'); names in the local language, countries also in English or "
        "German. Each region names its parents (state, country): a "
        "region of the same name in another state is not the place asked "
        "about. A part of a city (one of its districts or quarters) is not a "
        "NUTS region: search the catalog with the city's region, and in a "
        "workflow filter the part by name or geometry in the city's own "
        "boundary layer, never with a region of the same name. Nothing "
        "matches: try the containing city or district."
    ),
    input_model=FindRegionInput,
    output_model=FindRegionResult,
    run=_find_region,
    surfaces=CATALOG_SURFACES,
    returns_data=False,
    mcp=True,
)


# -- catalog.show_records ------------------------------------------------------

_MAX_SHOWN = 10
_MAX_SHOWN_GROUPS = 4


class ShownEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(
        pattern=RECORD_ID_PATTERN,
        description="An id from catalog_search or catalog_get_record results.",
    )
    note: str | None = Field(
        default=None,
        max_length=160,
        description=(
            "One short line, in the user's language, on what the dataset offers "
            "for the user's question. Not its title again."
        ),
    )

    @field_validator("id")
    @classmethod
    def _not_a_dot_segment(cls, value: str) -> str:
        if value in (".", ".."):
            raise ValueError("not a catalog id")
        return value


class ShownGroupInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(
        default=None,
        max_length=60,
        description="A short heading for the group, in the user's language.",
    )
    records: list[ShownEntry] = Field(min_length=1, max_length=_MAX_SHOWN)


class ShowRecordsInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    groups: list[ShownGroupInput] = Field(
        min_length=1,
        max_length=_MAX_SHOWN_GROUPS,
        description=(
            f"The recommended datasets in up to {_MAX_SHOWN_GROUPS} groups, in the "
            f"order you present them; the first {_MAX_SHOWN} are shown. One group "
            "without a title is fine."
        ),
    )

    @field_validator("groups")
    @classmethod
    def _each_once(cls, groups: list[ShownGroupInput]) -> list[ShownGroupInput]:
        seen: set[str] = set()
        kept: list[ShownGroupInput] = []
        for group in groups:
            records = []
            for record in group.records:
                if record.id not in seen:
                    seen.add(record.id)
                    records.append(record)
            if records:
                kept.append(group.model_copy(update={"records": records}))
        return kept


class ShownRecord(BaseModel):
    id: str
    title: str | None = None
    type: str | None = None
    publisher: str | None = None
    license: str | None = None
    note: str | None = None


class ShownGroup(BaseModel):
    title: str | None = None
    records: list[ShownRecord]


class ShowRecordsResult(BaseModel):
    groups: list[ShownGroup]
    not_found: list[str]
    #: Named beyond the first ``_MAX_SHOWN``: not shown, so the text must not
    #: count them among the cards.
    left_out: list[str]


async def _shown(env: ToolEnv, entry: ShownEntry) -> ShownRecord | None:
    try:
        resolved = await _get(env, f"/resolve/{quote(entry.id, safe='')}")
    except ServiceError as exc:
        if exc.status == 404:
            return None
        raise
    if resolved.get("kind") == "item":
        props = (resolved.get("item") or {}).get("properties") or {}
        title, kind, publisher, license_ = (
            props.get("title"),
            props.get("goat:layerType"),
            props.get("goat:publisher"),
            props.get("license"),
        )
    else:
        dataset = _trim_dataset(dict(resolved.get("collection") or {}))
        title, kind, publisher, license_ = (
            dataset["title"],
            dataset["type"],
            dataset["publisher"],
            dataset.get("license"),
        )
    note = (entry.note or "").strip() or None
    # A note that only repeats the title says nothing the card does not.
    if note and title and note.casefold().rstrip(".") == str(title).casefold():
        note = None
    return ShownRecord(
        id=entry.id,
        title=title,
        type=kind,
        publisher=publisher,
        license=license_ if isinstance(license_, str) and license_ else None,
        note=note,
    )


async def _show_records(env: ToolEnv, args: ShowRecordsInput) -> ShowRecordsResult:
    entries = [entry for group in args.groups for entry in group.records]
    shown_ids = {entry.id for entry in entries[:_MAX_SHOWN]}
    left_out = [entry.id for entry in entries[_MAX_SHOWN:]]
    kept = [entry for entry in entries if entry.id in shown_ids]
    found = iter(await asyncio.gather(*(_shown(env, entry) for entry in kept)))
    groups: list[ShownGroup] = []
    not_found: list[str] = []
    for group in args.groups:
        records = []
        for entry in group.records:
            if entry.id not in shown_ids:
                continue
            record = next(found)
            if record is None:
                not_found.append(entry.id)
            else:
                records.append(record)
        if records:
            title = (group.title or "").strip() or None
            groups.append(ShownGroup(title=title, records=records))
    return ShowRecordsResult(groups=groups, not_found=not_found, left_out=left_out)


SHOW_RECORDS: ToolSpec[ShowRecordsInput, ShowRecordsResult] = ToolSpec(
    name="catalog.show_records",
    description=(
        "Show the catalog datasets your answer recommends as cards with an Open "
        "button, under short headings, each with a one-line note. Call it once, "
        "right before the final answer, with only those; without it no card is "
        f"shown. At most {_MAX_SHOWN} are shown: more come back as left_out, "
        "unknown ids as not_found; count only what is shown."
    ),
    input_model=ShowRecordsInput,
    output_model=ShowRecordsResult,
    run=_show_records,
    surfaces=CATALOG_SURFACES,
    returns_data=False,
)

CATALOG_TOOLS: tuple[ToolSpec[Any, Any], ...] = (
    SEARCH,
    DESCRIBE,
    SUGGEST_TERMS,
    GET_RECORD,
    FIND_REGION,
    SHOW_RECORDS,
    PROPOSE_FILTERS,
)
