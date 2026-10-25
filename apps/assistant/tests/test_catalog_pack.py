"""The catalog pack (spec §7.2, §9.1.1) against the real catalog app and its
fixture catalog."""

import json
from typing import Any

import httpx
import pytest
from pydantic_ai.exceptions import ToolFailed

from assistant.context import parse_context
from assistant.login import StaticLogin
from assistant.tools.catalog import (
    CATALOG_TOOLS,
    DESCRIBE,
    FIND_REGION,
    GET_RECORD,
    NO_SUCH_WORD,
    NOTHING_FOUND,
    PROPOSE_FILTERS,
    SEARCH,
    SHOW_RECORDS,
    SUGGEST_TERMS,
)
from assistant.tools.runtime import MAX_RESULT_BYTES, InputInvalid, ToolEnv, execute
from assistant.tools.testing import Recorder, RecordingTransport, fake_clients, tool_env


@pytest.fixture
def env(catalog_transport: RecordingTransport) -> ToolEnv:
    return tool_env(fake_clients(catalog=catalog_transport))


async def test_search_returns_datasets(env: ToolEnv) -> None:
    result = await execute(SEARCH, env, {"q": "Radverkehrsnetz", "limit": 5})
    assert 0 < result["numberReturned"] <= 5
    assert all("id" in item for item in result["results"])
    assert "facets" in result
    assert "note" not in result


async def test_a_search_that_finds_nothing_says_what_that_means(env: ToolEnv) -> None:
    """Its facet lists would all be empty; given only those, a model searched
    on with other words until the answer's budget was gone (wf-05)."""
    result = await execute(SEARCH, env, {"q": "toilette,wc,toilet"})
    assert result == {
        "numberMatched": 0,
        "numberReturned": 0,
        "truncated": False,
        "results": [],
        "note": NOTHING_FOUND,
    }
    flat = " ".join(NOTHING_FOUND.split())
    assert "Search once more only if" in flat
    assert "the catalog has no such dataset for these filters: say so" in flat
    assert "leave that dataset step open" in flat


def test_the_search_text_asks_for_the_topics_words_in_one_search() -> None:
    described = SEARCH.input_model.model_fields["q"].description or ""
    assert "one search with a topic's German and English words" in described
    # The open-ended "Nothing found: try other words" is left to the result's note.
    assert "Nothing found" not in described


async def test_search_limit_is_clamped(env: ToolEnv) -> None:
    result = await execute(SEARCH, env, {"limit": 99999})
    # The fixture's datasets exceed the clamp: the large limit never reaches the query.
    assert result["numberMatched"] > 20
    assert result["numberReturned"] == 20


async def test_search_invalid_bbox_is_a_clean_failure(env: ToolEnv) -> None:
    # The catalog's 400 is the model's to fix: InputInvalid, with its message.
    with pytest.raises(InputInvalid, match="invalid bbox"):
        await execute(SEARCH, env, {"bbox": "not,a,bbox"})


async def test_get_record_item(env: ToolEnv) -> None:
    record = await execute(GET_RECORD, env, {"item_id": "radverkehrsnetz-dresden-0"})
    assert record["id"] == "radverkehrsnetz-dresden-0"
    assert record["type"] == "Feature"


async def test_get_record_bundle(env: ToolEnv) -> None:
    record = await execute(GET_RECORD, env, {"item_id": "src-1"})
    assert record["id"] == "src-1"
    assert record["type"] == "Collection"
    assert len(record["goat:items"]) == 4
    assert record["goat:items_truncated"] is False
    assert record["goat:member_count"] == 4


async def test_get_record_unknown_id_is_a_clean_failure(env: ToolEnv) -> None:
    with pytest.raises(ToolFailed) as caught:
        await execute(GET_RECORD, env, {"item_id": "does-not-exist"})
    assert caught.value.message == "Catalog record 'does-not-exist' not found"


OWN_DATASET = "bd000000-0000-0000-0000-0000000000d1"


async def test_get_record_names_the_tools_for_a_dataset_of_the_users_own(
    catalog_transport: RecordingTransport,
) -> None:
    """A dataset id from core_find given to the catalog: the error says
    what it is and which tools take it."""
    core = Recorder(
        {("GET", f"/api/v2/layer/{OWN_DATASET}"): {"id": OWN_DATASET, "name": "x"}}
    )
    env = tool_env(fake_clients(catalog=catalog_transport, core=core))
    with pytest.raises(ToolFailed) as caught:
        await execute(GET_RECORD, env, {"item_id": OWN_DATASET})
    assert caught.value.message == (
        f"Catalog record {OWN_DATASET!r} not found: it is a dataset of the user's "
        "own (core_find lists it), not a catalog record. On a project page, "
        "project_add_dataset adds it."
    )


@pytest.mark.parametrize("status", [403, 404])
async def test_get_record_of_an_id_neither_service_knows(
    catalog_transport: RecordingTransport, status: int
) -> None:
    """Another user's private dataset (403) reads as an unknown id (404)."""
    core = Recorder(
        {
            ("GET", f"/api/v2/layer/{OWN_DATASET}"): httpx.Response(
                status, json={"detail": "no"}
            )
        }
    )
    env = tool_env(fake_clients(catalog=catalog_transport, core=core))
    with pytest.raises(ToolFailed) as caught:
        await execute(GET_RECORD, env, {"item_id": OWN_DATASET})
    assert caught.value.message == f"Catalog record {OWN_DATASET!r} not found"


async def test_get_record_asks_core_only_about_a_uuid(
    catalog_transport: RecordingTransport,
) -> None:
    core = Recorder()
    env = tool_env(fake_clients(catalog=catalog_transport, core=core))
    with pytest.raises(ToolFailed):
        await execute(GET_RECORD, env, {"item_id": "does-not-exist"})
    await execute(GET_RECORD, env, {"item_id": "radverkehrsnetz-dresden-0"})
    assert core.requests == []


async def test_describe_lists_filters_with_real_values(env: ToolEnv) -> None:
    result = await execute(DESCRIBE, env, {})
    assert result["items"] > 0 and result["collections"] > 0
    by_param = {entry["parameter"]: entry for entry in result["filters"]}
    assert {"themes", "license", "publisher", "type", "year"} <= set(by_param)
    licenses = by_param["license"]["values"]
    assert licenses and all({"value", "count"} == set(v) for v in licenses)
    counts = [v["count"] for v in licenses]
    assert counts == sorted(counts, reverse=True)
    # Every listed value is a usable argument of catalog_search.
    search = await execute(SEARCH, env, {"license": licenses[0]["value"], "limit": 1})
    assert search["numberMatched"] > 0


async def test_describe_reports_sortable_and_aggregations(env: ToolEnv) -> None:
    result = await execute(DESCRIBE, env, {})
    assert "updated" in result["sortable"]
    # Datasets are sorted by the collection registry: `relevance` is there, an
    # item-only field is not.
    assert "relevance" in result["sortable"]
    assert "created" not in result["sortable"]
    assert "total_count" in result["aggregations"]


async def test_suggest_terms_finds_a_word_by_its_stem(env: ToolEnv) -> None:
    result = await execute(SUGGEST_TERMS, env, {"prefix": "radver"})
    assert any("Radverkehrsnetz" in match["title"] for match in result["matches"])


async def test_suggest_terms_anchors_at_word_boundaries(env: ToolEnv) -> None:
    assert (await execute(SUGGEST_TERMS, env, {"prefix": "erkehrsnetz"}))[
        "matches"
    ] == []


async def test_suggest_terms_blank_prefix_is_empty_not_everything(
    env: ToolEnv,
) -> None:
    assert await execute(SUGGEST_TERMS, env, {"prefix": "   "}) == {
        "prefix": "   ",
        "matches": [],
        "note": NO_SUCH_WORD,
    }


async def test_suggest_terms_says_when_no_word_starts_so(env: ToolEnv) -> None:
    found = await execute(SUGGEST_TERMS, env, {"prefix": "radver"})
    assert found["matches"] and "note" not in found
    assert (await execute(SUGGEST_TERMS, env, {"prefix": "toilet"}))[
        "note"
    ] == NO_SUCH_WORD


def test_the_catalog_searches_count_what_found_nothing() -> None:
    """The tools whose empty results end the answer's searching after
    ``FRUITLESS_SEARCHES`` in a row (assistant.tools.toolset)."""
    searching = {spec.wire_name for spec in CATALOG_TOOLS if spec.found_nothing}
    assert searching == {"catalog_search", "catalog_suggest_terms"}
    assert SEARCH.found_nothing is not None and SUGGEST_TERMS.found_nothing is not None
    assert SEARCH.found_nothing({"numberMatched": 0, "results": []})
    assert not SEARCH.found_nothing({"numberMatched": 3, "results": []})
    assert SUGGEST_TERMS.found_nothing({"prefix": "x", "matches": []})
    assert not SUGGEST_TERMS.found_nothing({"prefix": "x", "matches": [{"id": "a"}]})


async def test_catalog_calls_carry_the_users_token(
    catalog_transport: RecordingTransport,
) -> None:
    env = tool_env(
        fake_clients(catalog=catalog_transport), login=StaticLogin("user-token")
    )
    await execute(SUGGEST_TERMS, env, {"prefix": "rad"})
    assert catalog_transport.requests[0].headers["Authorization"] == "Bearer user-token"
    assert catalog_transport.requests[0].url.path == "/stac/suggest"


async def test_propose_filters_shows_a_card_with_the_page_state(
    catalog_transport: RecordingTransport,
) -> None:
    emitted: list[tuple[str, dict[str, Any]]] = []

    async def emit(name: str, data: dict[str, Any]) -> str:
        emitted.append((name, data))
        return "m1:1"

    env = tool_env(fake_clients(catalog=catalog_transport), emit_data=emit)
    describe = await execute(DESCRIBE, env, {})
    # The fixture catalog has no `themes` buckets; `license` has them.
    licence = next(f for f in describe["filters"] if f["parameter"] == "license")[
        "values"
    ][0]["value"]
    shown = await execute(
        PROPOSE_FILTERS,
        env,
        {
            "title": "Verkehrsdaten",
            "q": "rad",
            "facets": {"license": [licence]},
            "from_date": "2020-01-01",
        },
    )
    assert shown["proposal_id"] == "m1:1" and shown["status"] == "shown"
    [(name, data)] = emitted
    assert name == "proposal"
    assert data["version"] == 1 and data["kind"] == "catalog.filters"
    assert data["surface"] == "catalog" and data["target"] is None
    assert data["title"] == "Verkehrsdaten"
    payload = data["payload"]
    assert payload == {
        "q": "rad",
        "facets": {"license": [licence]},
        "from": "2020-01-01",
        "to": None,
        "nuts": [],
        "sortby": None,
        "number_matched": shown["number_matched"],
    }
    assert {"k": "license", "v": licence} in data["rows"]
    assert data["rows"][-1] == {
        "k": "number_matched",
        "v": str(shown["number_matched"]),
    }


@pytest.mark.parametrize(
    "page",
    [
        {"surface": "none"},
        {
            "surface": "project.map",
            "project_id": "00000000-0000-0000-0000-0000000005e1",
        },
    ],
)
async def test_propose_filters_off_the_catalog_page_still_targets_the_catalog(
    catalog_transport: RecordingTransport, page: dict[str, Any]
) -> None:
    """From Home or a project the card carries the same catalog proposal: its
    surface stays ``catalog`` and it names no project, so the web app offers
    "Open in catalog" instead of Apply. The model is told nothing was changed."""
    emitted: list[dict[str, Any]] = []

    async def emit(name: str, data: dict[str, Any]) -> str:
        emitted.append(data)
        return "m1:1"

    env = tool_env(
        fake_clients(catalog=catalog_transport),
        emit_data=emit,
        page=parse_context(page),
    )
    shown = await execute(PROPOSE_FILTERS, env, {"title": "Bevölkerung", "q": "rad"})
    [data] = emitted
    assert data["kind"] == "catalog.filters"
    assert data["surface"] == "catalog" and data["target"] is None
    assert data["payload"]["q"] == "rad"
    assert shown["status"] == "shown"
    assert "Nothing changes until the user applies it" in shown["note"]


async def test_propose_filters_rejects_unknown_filters_and_inverted_ranges(
    env: ToolEnv,
) -> None:
    async def emit(name: str, data: dict[str, Any]) -> str:
        raise AssertionError("nothing may be shown")

    env.emit_data = emit
    with pytest.raises(InputInvalid, match="Unknown filter 'colour'"):
        await execute(
            PROPOSE_FILTERS, env, {"title": "x", "facets": {"colour": ["red"]}}
        )
    with pytest.raises(InputInvalid, match="before"):
        await execute(
            PROPOSE_FILTERS,
            env,
            {"title": "x", "from_date": "2024-01-01", "to_date": "2020-01-01"},
        )
    with pytest.raises(InputInvalid, match="'colour'"):
        await execute(PROPOSE_FILTERS, env, {"title": "x", "sortby": "-colour"})
    # Sortable for layers only: the catalog's 400 for datasets reaches the model.
    with pytest.raises(InputInvalid, match="created"):
        await execute(PROPOSE_FILTERS, env, {"title": "x", "sortby": "-created"})
    with pytest.raises(InputInvalid, match="from_date and to_date"):
        await execute(
            PROPOSE_FILTERS, env, {"title": "x", "facets": {"year": ["2020"]}}
        )
    with pytest.raises(InputInvalid):
        await execute(PROPOSE_FILTERS, env, {"title": "x", "nuts": ["saxony"]})
    with pytest.raises(InputInvalid):
        await execute(PROPOSE_FILTERS, env, {"title": "x", "sortby": "updated; drop"})
    # A sortable field passes.
    env.emit_data = None
    with pytest.raises(ToolFailed, match="only be shown"):
        await execute(PROPOSE_FILTERS, env, {"title": "x", "sortby": "-updated"})


async def test_propose_filters_accepts_relevance_and_dataset_sorting(
    catalog_transport: RecordingTransport,
) -> None:
    emitted: list[dict[str, Any]] = []

    async def emit(name: str, data: dict[str, Any]) -> str:
        emitted.append(data)
        return f"m:{len(emitted)}"

    env = tool_env(fake_clients(catalog=catalog_transport), emit_data=emit)
    for sortby in ("relevance", "-updated"):
        await execute(PROPOSE_FILTERS, env, {"title": "x", "sortby": sortby})
    assert [data["payload"]["sortby"] for data in emitted] == ["relevance", "-updated"]


async def test_propose_filters_number_matched_is_what_the_catalog_counts(
    catalog_transport: RecordingTransport,
) -> None:
    emitted: list[dict[str, Any]] = []

    async def emit(name: str, data: dict[str, Any]) -> str:
        emitted.append(data)
        return "m1:1"

    env = tool_env(fake_clients(catalog=catalog_transport), emit_data=emit)
    describe = await execute(DESCRIBE, env, {})
    licence = next(f for f in describe["filters"] if f["parameter"] == "license")[
        "values"
    ][0]["value"]
    shown = await execute(
        PROPOSE_FILTERS,
        env,
        {"title": "x", "facets": {"license": [licence]}, "sortby": "-updated"},
    )
    direct = await fake_clients(catalog=catalog_transport).catalog.get(
        "/stac/collections",
        params={"license": licence, "sortby": "-updated", "limit": 1},
    )
    assert direct.status_code == 200
    expected = direct.json()["numberMatched"]
    assert 0 < expected < (await execute(SEARCH, env, {"limit": 1}))["numberMatched"]
    assert shown["number_matched"] == expected
    assert emitted[0]["payload"]["number_matched"] == expected
    assert emitted[0]["rows"][-1] == {"k": "number_matched", "v": str(expected)}


async def test_propose_filters_with_a_region_counts_what_the_catalog_counts(
    catalog_transport: RecordingTransport,
) -> None:
    """A valid NUTS id goes through to the catalog's region filter: the card's
    count is the page's count for that region."""
    emitted: list[dict[str, Any]] = []

    async def emit(name: str, data: dict[str, Any]) -> str:
        emitted.append(data)
        return f"m:{len(emitted)}"

    env = tool_env(fake_clients(catalog=catalog_transport), emit_data=emit)
    catalog = fake_clients(catalog=catalog_transport).catalog
    total = (await execute(SEARCH, env, {"limit": 1}))["numberMatched"]
    # The fixture's regions are random rectangles: take one that narrows.
    for region in ("DED", "DE1", "DE2", "DE3", "DE4", "DE9", "DEA"):
        direct = await catalog.get(
            "/stac/collections", params={"nuts": region, "limit": 1}
        )
        assert direct.status_code == 200
        expected = direct.json()["numberMatched"]
        if 0 < expected < total:
            break
    else:
        pytest.fail("no fixture region narrows the catalog")
    shown = await execute(PROPOSE_FILTERS, env, {"title": "x", "nuts": [region]})
    assert shown["number_matched"] == expected
    [data] = emitted
    assert data["payload"]["nuts"] == [region]
    assert data["payload"]["number_matched"] == expected
    assert {"k": "nuts", "v": region} in data["rows"]


async def test_record_ids_are_single_path_segments(env: ToolEnv) -> None:
    for bad in ("..", ".", "a/b", "src-1?x=1"):
        with pytest.raises(InputInvalid):
            await execute(GET_RECORD, env, {"item_id": bad})


async def test_propose_filters_needs_the_in_app_assistant(env: ToolEnv) -> None:
    with pytest.raises(ToolFailed, match="only be shown"):
        await execute(PROPOSE_FILTERS, env, {"title": "x", "q": "rad"})


def test_every_catalog_argument_is_described() -> None:
    for spec in CATALOG_TOOLS:
        for name, sub in spec.json_schema().get("properties", {}).items():
            assert "description" in sub, f"{spec.wire_name}.{name}"


def test_the_proposal_and_the_cards_are_not_published_over_mcp() -> None:
    assert {spec.wire_name for spec in CATALOG_TOOLS if spec.mcp} == {
        "catalog_search",
        "catalog_describe",
        "catalog_get_record",
        "catalog_suggest_terms",
        "catalog_find_region",
    }
    assert not any(spec.returns_data for spec in CATALOG_TOOLS)


def _strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [text for item in value for text in _strings(item)]
    if isinstance(value, dict):
        return [text for item in value.values() for text in _strings(item)]
    return []


@pytest.mark.parametrize("item_id", ["radverkehrsnetz-dresden-0", "src-1"])
async def test_records_never_show_the_catalogs_internal_host(
    env: ToolEnv, item_id: str
) -> None:
    record = await execute(GET_RECORD, env, {"item_id": item_id})
    texts = _strings(record)
    assert not [text for text in texts if text.startswith("http://catalog")]
    # Its own links became paths; other origins are untouched.
    assert any(
        text.startswith("/stac/") or text.startswith("/assets/") for text in texts
    )
    assert any(text.startswith("https://") for text in texts)


def test_internal_hrefs_are_made_relative_and_others_kept() -> None:
    from assistant.tools.catalog import _relative

    base = "http://catalog:8400"
    value = {
        "href": f"{base}/stac/collections/a",
        "root": base,
        "other": "http://catalog:84001/x",
        "external": "https://data.example.org/a",
        "nested": [{"href": f"{base}/assets/a/thumbnail"}, 3, None],
    }
    assert _relative(value, base) == {
        "href": "/stac/collections/a",
        "root": "/",
        "other": "http://catalog:84001/x",
        "external": "https://data.example.org/a",
        "nested": [{"href": "/assets/a/thumbnail"}, 3, None],
    }


def _recorded(routes: dict[tuple[str, str], Any]) -> ToolEnv:
    return tool_env(fake_clients(catalog=Recorder(routes)))


async def test_a_bundle_too_big_for_the_limit_is_truncated_not_refused() -> None:
    member = {"type": "Feature", "id": "m", "properties": {"description": "x" * 6000}}
    env = _recorded(
        {
            ("GET", "/stac/resolve/big"): {
                "kind": "collection",
                "collection": {
                    "type": "Collection",
                    "id": "big",
                    "description": "y" * 8000,
                },
                "items": [{**member, "id": f"m{n}"} for n in range(100)],
                "goat:member_count": 100,
            }
        }
    )
    record = await execute(GET_RECORD, env, {"item_id": "big"})
    assert record["goat:items_truncated"] is True
    assert 0 < len(record["goat:items"]) < 100
    assert record["goat:member_count"] == 100
    size = len(json.dumps(record, separators=(",", ":"), ensure_ascii=False).encode())
    assert size <= MAX_RESULT_BYTES


async def test_a_search_page_too_wide_for_the_limit_is_truncated_not_refused() -> None:
    page = {
        "collections": [
            # Search results cut descriptions, so the width comes from the title.
            {"id": f"d{n}", "title": "x" * 6000, "description": "y"}
            for n in range(100)
        ],
        "numberMatched": 100,
    }
    # Wide facets take their share of the limit too.
    facets = {
        "aggregations": [
            {
                "name": "publisher_count",
                "buckets": [
                    {"key": f"publisher {n}", "frequency": n} for n in range(900)
                ],
            }
        ]
    }
    env = _recorded(
        {("GET", "/stac/collections"): page, ("GET", "/stac/aggregate"): facets}
    )
    result = await execute(SEARCH, env, {"limit": 100})
    assert result["truncated"] is True
    assert 0 < result["numberReturned"] < 100
    assert result["numberMatched"] == 100
    size = len(json.dumps(result, separators=(",", ":"), ensure_ascii=False).encode())
    assert size <= MAX_RESULT_BYTES


async def test_every_filter_card_row_key_is_a_known_one(
    catalog_transport: RecordingTransport,
) -> None:
    """The row keys are a contract with the web app (ProposalRowKey); facet
    rows use the facet's filter parameter."""
    from typing import get_args

    from assistant.tools.proposals import ProposalRowKey

    emitted: list[dict[str, Any]] = []

    async def emit(name: str, data: dict[str, Any]) -> str:
        emitted.append(data)
        return "m:1"

    env = tool_env(fake_clients(catalog=catalog_transport), emit_data=emit)
    describe = await execute(DESCRIBE, env, {})
    licence = next(f for f in describe["filters"] if f["parameter"] == "license")[
        "values"
    ][0]["value"]
    await execute(
        PROPOSE_FILTERS,
        env,
        {
            "title": "x",
            "q": "rad",
            "facets": {"license": [licence]},
            "from_date": "2010-01-01",
            "to_date": "2030-01-01",
            "nuts": ["DE"],
            "sortby": "-updated",
        },
    )
    [data] = emitted
    keys = [row["k"] for row in data["rows"]]
    facets = set(data["payload"]["facets"])
    assert facets == {"license"}
    assert {key for key in keys if key not in facets} <= set(get_args(ProposalRowKey))
    assert set(keys) - facets == {"q", "from", "to", "nuts", "sortby", "number_matched"}


# -- regions, short descriptions and the cards ------------------------------------


async def test_search_filters_by_region_and_cuts_descriptions() -> None:
    recorder = Recorder(
        {
            ("GET", "/stac/collections"): {
                "collections": [
                    {
                        "id": "rad-muc",
                        "title": "Radwege München",
                        "description": "x" * 900,
                    }
                ],
                "numberMatched": 1,
            },
            ("GET", "/stac/aggregate"): {"aggregations": []},
        }
    )
    env = tool_env(fake_clients(catalog=recorder))
    result = await execute(SEARCH, env, {"q": "rad", "nuts": ["DE212", "DE21H"]})
    # The region reaches the result page and the facet counts alike.
    assert {r.url.params["nuts"] for r in recorder.requests} == {"DE212,DE21H"}
    [row] = result["results"]
    assert len(row["description"]) == 160 and row["description"].endswith("…")


async def test_search_without_a_region_sends_none() -> None:
    recorder = Recorder(
        {
            ("GET", "/stac/collections"): {"collections": [], "numberMatched": 0},
            ("GET", "/stac/aggregate"): {"aggregations": []},
        }
    )
    await execute(SEARCH, tool_env(fake_clients(catalog=recorder)), {"q": "rad"})
    assert all("nuts" not in r.url.params for r in recorder.requests)


async def test_search_rejects_a_region_that_is_not_a_nuts_id() -> None:
    with pytest.raises(InputInvalid):
        await execute(SEARCH, _recorded({}), {"nuts": ["München"]})


def _nuts_answer(request: httpx.Request) -> httpx.Response:
    """The catalog's /nuts: a substring of the native name or the id."""
    rows = [
        {"nuts_id": "AL", "nuts_name": "Shqipëria", "level": 0, "country": "AL"},
        {"nuts_id": "BE", "nuts_name": "Belgique/België", "level": 0, "country": "BE"},
        {"nuts_id": "EL", "nuts_name": "Elláda", "level": 0, "country": "EL"},
        {"nuts_id": "IT", "nuts_name": "Italia", "level": 0, "country": "IT"},
    ]
    q = request.url.params["q"].casefold()
    return httpx.Response(
        200,
        json=[
            row
            for row in rows
            if q in row["nuts_name"].casefold() or q in row["nuts_id"].casefold()
        ],
    )


@pytest.mark.parametrize(
    ("name", "nuts_id"), [("Albania", "AL"), (" albanien ", "AL"), ("Greece", "EL")]
)
async def test_find_region_knows_countries_by_their_english_and_german_names(
    name: str, nuts_id: str
) -> None:
    """NUTS names countries in their own languages only."""
    recorder = Recorder({("GET", "/stac/nuts"): _nuts_answer})
    result = await execute(
        FIND_REGION, tool_env(fake_clients(catalog=recorder)), {"name": name}
    )
    assert [region["nuts_id"] for region in result["regions"]] == [nuts_id]
    assert result["regions"][0]["level"] == 0


async def test_find_region_returns_the_catalogs_nuts_regions() -> None:
    recorder = Recorder(
        {
            ("GET", "/stac/nuts"): [
                {
                    "nuts_id": "DE212",
                    "nuts_name": "München, Kreisfreie Stadt",
                    "level": 3,
                    "country": "DE",
                    "bbox": [11.3, 48.0, 11.7, 48.2],
                },
                {
                    "nuts_id": "DE21H",
                    "nuts_name": "München, Landkreis",
                    "level": 3,
                    "country": "DE",
                    "bbox": [11.2, 47.9, 11.9, 48.3],
                },
            ]
        }
    )
    result = await execute(
        FIND_REGION, tool_env(fake_clients(catalog=recorder)), {"name": " München "}
    )
    assert recorder.requests[0].url.params["q"] == "München"
    assert result == {
        "regions": [
            {
                "nuts_id": "DE212",
                "name": "München, Kreisfreie Stadt",
                "level": 3,
                "country": "DE",
            },
            {
                "nuts_id": "DE21H",
                "name": "München, Landkreis",
                "level": 3,
                "country": "DE",
            },
        ]
    }


def _resolve(record_id: str, title: str) -> dict[str, Any]:
    return {
        "kind": "collection",
        "collection": {
            "id": record_id,
            "title": title,
            "goat:layerType": "feature",
            "contacts": [{"name": "Landeshauptstadt München", "roles": ["publisher"]}],
        },
    }


async def test_show_records_keeps_groups_order_and_notes_and_reports_unknown_ids() -> (
    None
):
    recorder = Recorder(
        {
            ("GET", "/stac/resolve/bezirke"): _resolve(
                "bezirke", "Stadtbezirke München"
            ),
            ("GET", "/stac/resolve/radwege"): _resolve("radwege", "Radwege München"),
            ("GET", "/stac/resolve/oepnv"): _resolve("oepnv", "ÖPNV-Linien"),
            ("GET", "/stac/resolve/gone"): httpx.Response(404, json={"detail": "x"}),
        }
    )
    result = await execute(
        SHOW_RECORDS,
        tool_env(fake_clients(catalog=recorder)),
        {
            "groups": [
                {
                    "title": "Grundlage",
                    "records": [
                        {"id": "bezirke", "note": "Zum Ausschneiden von Allach"}
                    ],
                },
                {
                    "title": " Radverkehr ",
                    "records": [
                        {"id": "radwege", "note": "radwege münchen."},
                        {"id": "gone", "note": "x"},
                        # A dataset already shown in an earlier group is dropped.
                        {"id": "bezirke"},
                    ],
                },
                {"records": [{"id": "gone"}]},
                {"records": [{"id": "oepnv"}]},
            ]
        },
    )
    assert result == {
        "groups": [
            {
                "title": "Grundlage",
                "records": [
                    {
                        "id": "bezirke",
                        "title": "Stadtbezirke München",
                        "type": "feature",
                        "publisher": "Landeshauptstadt München",
                        "note": "Zum Ausschneiden von Allach",
                    }
                ],
            },
            {
                "title": "Radverkehr",
                "records": [
                    {
                        "id": "radwege",
                        "title": "Radwege München",
                        "type": "feature",
                        "publisher": "Landeshauptstadt München",
                        # Only the title again: dropped (empty values are left out).
                    }
                ],
            },
            {
                "records": [
                    {
                        "id": "oepnv",
                        "title": "ÖPNV-Linien",
                        "type": "feature",
                        "publisher": "Landeshauptstadt München",
                    }
                ],
            },
        ],
        "not_found": ["gone"],
        "left_out": [],
    }


@pytest.mark.parametrize(
    "groups",
    [
        [],
        [{"records": []}],
        [{"records": [{"id": f"d{n}"}]} for n in range(5)],
        [{"records": [{"id": "d", "note": "n" * 161}]}],
    ],
)
async def test_show_records_limits(groups: list[dict[str, Any]]) -> None:
    """At least one dataset, at most four groups and ten datasets in a group,
    and short notes."""
    with pytest.raises(InputInvalid):
        await execute(SHOW_RECORDS, _recorded({}), {"groups": groups})


async def test_search_lists_the_most_frequent_facet_values() -> None:
    env = _recorded(
        {
            ("GET", "/stac/collections"): {
                "collections": [{"id": "d", "title": "D"}],
                "numberMatched": 1,
            },
            ("GET", "/stac/aggregate"): {
                "aggregations": [
                    {
                        "name": "publisher_count",
                        "buckets": [
                            {"key": f"p{n}", "frequency": n} for n in range(30)
                        ],
                    },
                    {
                        "name": "type_count",
                        "buckets": [{"key": "feature", "frequency": 1}],
                    },
                ]
            },
        }
    )
    result = await execute(SEARCH, env, {"q": "x"})
    publishers, types = result["facets"]
    assert [b["key"] for b in publishers["buckets"]] == [
        f"p{n}" for n in range(29, 19, -1)
    ]
    assert publishers["total_values"] == 30
    assert "total_values" not in types


def _collection(**extra: Any) -> dict[str, Any]:
    return {
        "type": "Collection",
        "id": "d",
        "title": "Haltestellen",
        "description": "Alle Haltestellen\nim Verbund. " + "x" * 400,
        "keywords": ["öpnv", "mobilität"],
        "license": "ODbL-1.0",
        "language": {"code": "de"},
        "themes": [{"concepts": [{"id": "transportation"}]}],
        "providers": [{"name": "MVV", "roles": ["producer"]}],
        "goat:layerType": "feature",
        "extent": {
            "spatial": {"bbox": [[11.123456789, 48.0, 11.987654321, 48.4]]},
            "temporal": {
                "interval": [["2018-01-01T00:00:00Z", "2024-12-31T00:00:00Z"]]
            },
        },
        **extra,
    }


async def test_search_rows_are_short() -> None:
    """Enough to tell whether a dataset fits: the rest is one get_record away."""
    env = _recorded(
        {
            ("GET", "/stac/collections"): {
                "collections": [
                    _collection(),
                    _collection(id="b", **{"goat:member_count": 3}),
                ],
                "numberMatched": 2,
            },
            ("GET", "/stac/aggregate"): {"aggregations": []},
        }
    )
    single, bundle = (await execute(SEARCH, env, {"q": "haltestellen"}))["results"]
    assert single == {
        "id": "d",
        "title": "Haltestellen",
        "description": single["description"],
        "type": "feature",
        "publisher": "MVV",
        "years": "2018-2024",
        "bbox": [11.12, 48.0, 11.99, 48.4],
    }
    assert single["description"].startswith("Alle Haltestellen im Verbund. xxx")
    assert len(single["description"]) == 160
    assert bundle["member_count"] == 3


@pytest.mark.parametrize(
    ("interval", "years"),
    [
        (["2024-03-25T19:36:07Z", "2024-03-25T19:36:07Z"], "2024"),
        (["2018-01-01T00:00:00Z", None], "from 2018"),
        ([None, "2020-01-01T00:00:00Z"], "until 2020"),
        ([None, None], None),
    ],
)
def test_search_rows_give_the_years(
    interval: list[str | None], years: str | None
) -> None:
    from assistant.tools.catalog import _search_row

    row = _search_row(_collection(extent={"temporal": {"interval": [interval]}}))
    assert row.get("years") == years


async def test_later_search_pages_skip_the_facet_counts() -> None:
    recorder = Recorder(
        {
            ("GET", "/stac/collections"): {
                "collections": [{"id": "d", "title": "D"}],
                "numberMatched": 30,
            }
        }
    )
    env = tool_env(fake_clients(catalog=recorder))
    result = await execute(SEARCH, env, {"q": "x", "offset": 10})
    assert recorder.paths() == ["/stac/collections"]
    assert "facets" not in result


async def test_a_record_lists_its_layers_without_geometry_links_or_assets() -> None:
    member = {
        "type": "Feature",
        "id": "m1",
        "bbox": [11.5, 48.1, 11.6, 48.2],
        "geometry": {"type": "MultiPolygon", "coordinates": [[[[0, 0]] * 500]]},
        "links": [{"rel": "self", "href": "http://catalog:8400/stac/x"}],
        "assets": {"data": {"href": "https://data.example.org/m1.zip"}},
        "properties": {
            "title": "Radwege",
            "description": "d" * 900,
            "goat:geometryType": "line",
            "table:row_count": 148,
            "table:columns": [{"name": "art", "type": "string", "extra": "x"}],
        },
    }
    env = _recorded(
        {
            ("GET", "/stac/resolve/b"): {
                "kind": "collection",
                "collection": {
                    "type": "Collection",
                    "id": "b",
                    "links": [{"rel": "about", "href": "https://data.example.org/b"}],
                    "stac_extensions": ["https://stac-extensions.github.io/x"],
                },
                "items": [{**member, "id": f"m{n}"} for n in range(30)],
                "goat:member_count": 30,
            }
        }
    )
    record = await execute(GET_RECORD, env, {"item_id": "b"})
    # The dataset keeps its source link; the extensions list goes.
    assert record["links"] == [{"rel": "about", "href": "https://data.example.org/b"}]
    assert "stac_extensions" not in record
    assert len(record["goat:items"]) == 25 and record["goat:items_truncated"] is True
    first = record["goat:items"][0]
    assert set(first) == {
        "id",
        "title",
        "description",
        "geometry_type",
        "row_count",
        "bbox",
        "columns",
        "columns_truncated",
    }
    assert first["columns"] == [{"name": "art", "type": "string"}]
    assert len(first["description"]) == 300


async def test_show_records_shows_the_first_ten_and_reports_the_rest() -> None:
    routes = {
        ("GET", f"/stac/resolve/d{n}"): _resolve(f"d{n}", f"D {n}") for n in range(13)
    }
    recorder = Recorder(routes)
    result = await execute(
        SHOW_RECORDS,
        tool_env(fake_clients(catalog=recorder)),
        {
            "groups": [
                {"title": "A", "records": [{"id": f"d{n}"} for n in range(8)]},
                {"title": "B", "records": [{"id": f"d{n}"} for n in range(8, 13)]},
            ]
        },
    )
    assert [[r["id"] for r in g["records"]] for g in result["groups"]] == [
        [f"d{n}" for n in range(8)],
        ["d8", "d9"],
    ]
    assert result["left_out"] == ["d10", "d11", "d12"]
    # Left-out datasets are not looked up.
    assert len(recorder.requests) == 10


async def test_show_records_shows_a_dataset_named_twice_once() -> None:
    recorder = Recorder({("GET", "/stac/resolve/d1"): _resolve("d1", "D 1")})
    result = await execute(
        SHOW_RECORDS,
        tool_env(fake_clients(catalog=recorder)),
        {"groups": [{"records": [{"id": "d1"}, {"id": "d1", "note": "again"}]}]},
    )
    assert [r["id"] for r in result["groups"][0]["records"]] == ["d1"]
    assert len(recorder.requests) == 1


_VALUES = {
    "aggregations": [
        {
            "name": "license_count",
            "goat:filter_param": "license",
            "buckets": [
                {"key": "ODbL-1.0", "frequency": 3},
                {"key": "CC0-1.0", "frequency": 9},
                {"key": "CC-BY-4.0", "frequency": 7},
                {"key": "CC-BY-SA-4.0", "frequency": 2},
            ],
        },
        {
            "name": "category_count",
            "goat:filter_param": "themes",
            "buckets": [{"key": "transportation", "frequency": 5}],
        },
        {
            "name": "geographical_code_count",
            "goat:filter_param": "geographical_code",
            "buckets": [],
        },
    ]
}


def test_filter_values_take_the_catalogs_spelling() -> None:
    from assistant.tools.catalog import _canonical_facets

    assert _canonical_facets(
        {
            "license": ["ODbL", "cc0-1.0", "CC-BY-4.0"],
            "themes": ["Transportation"],
            # No value list to check against: left to the search.
            "geographical_code": ["DE"],
        },
        _VALUES,
    ) == {
        "license": ["ODbL-1.0", "CC0-1.0", "CC-BY-4.0"],
        "themes": ["transportation"],
        "geographical_code": ["DE"],
    }


@pytest.mark.parametrize(
    ("value", "message"),
    [
        # Two values start with it: not guessed.
        ("CC-BY", "Close values: CC-BY-4.0, CC-BY-SA-4.0"),
        ("MIT", "Values: ODbL-1.0, CC0-1.0, CC-BY-4.0, CC-BY-SA-4.0"),
    ],
)
def test_an_unknown_or_unclear_value_is_the_models_to_fix(
    value: str, message: str
) -> None:
    from assistant.tools.catalog import _canonical_facets

    with pytest.raises(InputInvalid, match=message):
        _canonical_facets({"license": [value]}, _VALUES)
