"""CQL2 filter-extension tests: compile_cql2 through search_items.

Audited against docs/goat-catalog-api.md's filter extension section --
these behaviors are non-negotiable: cql2-text and cql2-json must produce
equivalent results, spatial predicates must work end-to-end against the
`cat` table's geometry column, an unknown queryable must be a 400 (never a
silently-ignored filter), and only the CRS84 filter-crs is accepted.
"""

from typing import Any

import pytest
from goatlib.filter.area import CROSSES_ITSELF
from goatlib.filter.limits import REQUEST_MAX_DEPTH, REQUEST_MAX_VALUES

from catalog.errors import ApiError
from catalog.services.cql import compile_cql2
from catalog.services.queryables import queryables_schema
from catalog.services.registry import QueryableRegistry
from catalog.services.search import SearchParams, search_items
from catalog.store import CatalogStore

_CRS84 = "http://www.opengis.net/def/crs/OGC/1.3/CRS84"


def test_cql2_text_equality_and_and(store: CatalogStore) -> None:
    docs, n = search_items(
        store,
        SearchParams(
            cql=compile_cql2(
                "license = 'CC-BY-4.0' AND category = 'transportation'",
                "cql2-text",
                None,
                store.registry,
            ),
            limit=1000,
        ),
    )
    assert n > 0
    for doc in docs:
        props = doc
        assert props["license"] == "CC-BY-4.0"
        assert props["themes"][0]["concepts"][0]["id"] == "transportation"


def test_cql2_json_equivalent_same_count(store: CatalogStore) -> None:
    _, n_text = search_items(
        store,
        SearchParams(
            cql=compile_cql2(
                "license = 'CC-BY-4.0' AND category = 'transportation'",
                "cql2-text",
                None,
                store.registry,
            ),
            limit=1000,
        ),
    )
    filter_json = {
        "op": "and",
        "args": [
            {"op": "=", "args": [{"property": "license"}, "CC-BY-4.0"]},
            {"op": "=", "args": [{"property": "category"}, "transportation"]},
        ],
    }
    _, n_json = search_items(
        store,
        SearchParams(
            cql=compile_cql2(filter_json, "cql2-json", None, store.registry),
            limit=1000,
        ),
    )
    assert n_json == n_text
    assert n_json > 0


def test_cql2_text_default_lang_is_none(store: CatalogStore) -> None:
    """``filter_lang=None`` defaults to cql2-text (router picks per-verb)."""
    docs, n = search_items(
        store,
        SearchParams(
            cql=compile_cql2("license = 'CC-BY-4.0'", None, None, store.registry),
            limit=1000,
        ),
    )
    assert n > 0
    assert all(d["license"] == "CC-BY-4.0" for d in docs)


def test_spatial_s_intersects(store: CatalogStore) -> None:
    poly = "POLYGON((5 47, 16 47, 16 56, 5 56, 5 47))"
    docs, n = search_items(
        store,
        SearchParams(
            cql=compile_cql2(
                f"S_INTERSECTS(geometry, {poly})", "cql2-text", None, store.registry
            ),
            limit=1000,
        ),
    )
    assert n > 0
    assert len(docs) == n


def test_unknown_property_is_400(registry: QueryableRegistry) -> None:
    with pytest.raises(ApiError) as e:
        compile_cql2("nope = 'x'", "cql2-text", None, registry)
    assert e.value.status_code == 400
    assert "nope" in e.value.detail


def test_unknown_property_json_is_400(registry: QueryableRegistry) -> None:
    filter_json = {"op": "=", "args": [{"property": "not_a_queryable"}, "x"]}
    with pytest.raises(ApiError) as e:
        compile_cql2(filter_json, "cql2-json", None, registry)
    assert e.value.status_code == 400


def test_non_crs84_filter_crs_is_400(registry: QueryableRegistry) -> None:
    with pytest.raises(ApiError) as e:
        compile_cql2(
            "license = 'CC-BY-4.0'",
            "cql2-text",
            "http://www.opengis.net/def/crs/EPSG/0/25832",
            registry,
        )
    assert e.value.status_code == 400


def test_crs84_filter_crs_passes(registry: QueryableRegistry) -> None:
    sql, params = compile_cql2("license = 'CC-BY-4.0'", "cql2-text", _CRS84, registry)
    assert params == ["CC-BY-4.0"]
    assert "license" in sql.lower()


def test_malformed_text_is_400(registry: QueryableRegistry) -> None:
    with pytest.raises(ApiError) as e:
        compile_cql2("this is not valid cql !!!", "cql2-text", None, registry)
    assert e.value.status_code == 400


def test_malformed_json_is_400(registry: QueryableRegistry) -> None:
    with pytest.raises(ApiError) as e:
        compile_cql2("{not valid json", "cql2-json", None, registry)
    assert e.value.status_code == 400


def _weave(lines: int) -> dict[str, Any]:
    """An area swept in rows and then in columns: every row crosses every column."""
    size = lines + 1
    ring: list[list[float]] = []
    for i in range(1, lines + 1):
        start, end = (0, size) if i % 2 else (size, 0)
        ring += [[start, i], [end, i]]
    for i in range(1, lines + 1):
        start, end = (0, size) if i % 2 else (size, 0)
        ring += [[i, start], [i, end]]
    return {"type": "Polygon", "coordinates": [ring + [ring[0]]]}


def _wkt(polygon: dict[str, Any]) -> str:
    ring = ", ".join(f"{x} {y}" for x, y in polygon["coordinates"][0])
    return f"POLYGON(({ring}))"


def test_json_over_a_request_ceiling_is_400(registry: QueryableRegistry) -> None:
    listed = [str(i) for i in range(REQUEST_MAX_VALUES + 1)]
    with pytest.raises(ApiError) as e:
        compile_cql2(
            {"op": "in", "args": [{"property": "license"}, listed]},
            "cql2-json",
            None,
            registry,
        )
    assert e.value.status_code == 400
    assert e.value.detail == (
        f"A condition takes at most {REQUEST_MAX_VALUES} values; "
        f"this one has {REQUEST_MAX_VALUES + 1}."
    )


def test_text_over_a_request_ceiling_is_400(registry: QueryableRegistry) -> None:
    listed = ", ".join(f"'{i}'" for i in range(REQUEST_MAX_VALUES + 1))
    with pytest.raises(ApiError) as e:
        compile_cql2(f"license IN ({listed})", "cql2-text", None, registry)
    assert e.value.status_code == 400
    assert e.value.detail == (
        f"A condition takes at most {REQUEST_MAX_VALUES} values; "
        f"this one has {REQUEST_MAX_VALUES + 1}."
    )


def test_a_long_text_chain_is_within_the_ceilings(registry: QueryableRegistry) -> None:
    """`a AND b AND c` parses as pairs in pairs: no deeper than its one `and`."""
    chain = " AND ".join(f"license <> '{i}'" for i in range(REQUEST_MAX_DEPTH * 2))
    sql, params = compile_cql2(chain, "cql2-text", None, registry)
    assert len(params) == REQUEST_MAX_DEPTH * 2


@pytest.mark.parametrize("lang", ["cql2-json", "cql2-text"])
def test_an_area_that_crosses_itself_too_often_is_400(
    registry: QueryableRegistry, lang: str
) -> None:
    area = _weave(20)
    source: Any = (
        {"op": "s_intersects", "args": [{"property": "geometry"}, area]}
        if lang == "cql2-json"
        else f"S_INTERSECTS(geometry, {_wkt(area)})"
    )
    with pytest.raises(ApiError) as e:
        compile_cql2(source, lang, None, registry)
    assert e.value.status_code == 400
    assert e.value.detail == CROSSES_ITSELF


def test_invalid_filter_lang_is_400(registry: QueryableRegistry) -> None:
    with pytest.raises(ApiError) as e:
        compile_cql2("license = 'CC-BY-4.0'", "cql2-bogus", None, registry)
    assert e.value.status_code == 400


def test_registry_is_derived_from_the_loaded_table(
    store: CatalogStore, registry: QueryableRegistry
) -> None:
    """Every scalar column of the loaded table is queryable, and only those.

    Asserted against the table itself rather than a copied list, so adding a
    column to the parquet makes it filterable without touching code -- the
    point of deriving the registry.
    """
    columns = {
        row[0]: row[1] for row in store.query(f"DESCRIBE SELECT * FROM {store.ITEMS}")
    }
    for name in (
        "id",
        "collection",
        "datetime",
        "created",
        "updated",
        "title",
        "description",
        "license",
        "category",
        # The published `language` is a STRUCT and cannot be compared; the
        # mirror derives this scalar beside it.
        "language_code",
        "publisher",
        "geometry",
    ):
        assert name in registry, f"{name} should be queryable"
        assert registry.sql_expr(name) == f'"{name}"'

    # The free-text haystack is internal: `q` is the way to search it.
    assert "search_text" in columns
    assert "search_text" not in registry

    # And nothing is advertised the table cannot answer: every queryable is
    # either a column of it or one of the expression-backed (virtual) entries,
    # whose SQL is an expression rather than a bare column reference.
    for name in registry.names:
        if name in columns:
            continue
        expr = registry.sql_expr(name)
        assert (
            expr is not None and expr != f'"{name}"'
        ), f"{name} is neither a column nor an expression-backed queryable"


def test_virtual_queryables_are_filterable_and_sortable(
    registry: QueryableRegistry,
) -> None:
    """``year`` is not a column of the mirror but is queryable anyway.

    It used to be reachable only through its own query parameter, so a CQL2
    filter or a ``sortby`` naming it was rejected while every other queryable
    accepted all three. It now resolves like anything else, via an expression
    rather than a column reference.

    ``geographical_code`` took the other route: it was a JSON path into the
    stored document (1.4 s per query at 1M rows) and the mirror now promotes it
    to a real column, so it resolves to a plain quoted identifier.
    """
    assert (
        registry.sql_expr("year")
        == "date_part('year', COALESCE(datetime_start, datetime_end))"
    )
    year = registry.resolve("year")
    assert year is not None and year.sortable

    # The mirror keeps the published name, so the queryable is the prefixed one.
    assert registry.sql_expr("goat:geographical_code") == '"goat:geographical_code"'
    assert registry.resolve("goat:geographical_code") is not None


def test_properties_prefixed_alias_resolves(registry: QueryableRegistry) -> None:
    """STAC clients write `properties.datetime`; pgstac strips the prefix."""
    assert registry.resolve("properties.datetime") == registry.resolve("datetime")
    assert registry.resolve("properties.nope") is None


def test_queryables_schema_shape(registry: QueryableRegistry) -> None:
    schema = queryables_schema("https://catalog.example.com/stac", registry)
    assert schema["$schema"] == "https://json-schema.org/draft/2019-09/schema"
    assert schema["$id"] == "https://catalog.example.com/stac/queryables"
    assert schema["type"] == "object"
    assert schema["additionalProperties"] is False
    props = schema["properties"]
    for required in ("id", "collection", "geometry", "datetime"):
        assert required in props
    assert props["id"]["type"] == "string"
    assert props["collection"]["type"] == "string"
    assert props["datetime"]["type"] == "string"
    assert props["datetime"]["format"] == "date-time"
    assert "$ref" in props["geometry"]


def test_queryables_schema_collection_scoped(registry: QueryableRegistry) -> None:
    schema = queryables_schema("https://catalog.example.com/stac", registry, "src-1")
    assert (
        schema["$id"] == "https://catalog.example.com/stac/collections/src-1/queryables"
    )


def test_private_columns_are_never_queryable(registry: QueryableRegistry) -> None:
    """``parquet_url`` is the private s3:// data location.

    Responses strip every ``s3://`` href (design S14), so it must not be
    advertised in ``/queryables`` or be filterable -- either would publish the
    storage layout those response rules exist to hide.
    """
    assert "parquet_url" not in registry
    assert "search_text" not in registry
