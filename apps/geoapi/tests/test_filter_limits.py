"""What `cql_filter_query` takes: a filter under the request ceilings
(`goatlib.filter.limits.REQUEST_MAX_*`) that the query path can parse.

Every client filter enters geoapi through `cql_filter_query` (the `filter`
query parameter of the features and tiles routes). One over a ceiling is
answered 400 before anything parses it; exactly at a ceiling, or over a save
limit but under the ceiling, it is taken as it was sent. One that does not
parse is answered 400 too: the query builder skips a filter it cannot read,
which would answer with every feature.
"""

import asyncio
import json
from typing import Any

import pytest
from fastapi import HTTPException
from goatlib.filter import limits

from geoapi.dependencies import cql_filter_query

P = {"property": "a"}
G = {"property": "geom"}


def conditions(n: int) -> dict[str, Any]:
    return {
        "op": "and",
        "args": [{"op": "=", "args": [{"property": f"f{i}"}, i]} for i in range(n)],
    }


def values(n: int) -> dict[str, Any]:
    return {"op": "in", "args": [P, list(range(n))]}


def nested(levels: int) -> dict[str, Any]:
    node: dict[str, Any] = {"op": "=", "args": [P, 1]}
    for _ in range(levels - 1):
        node = {"op": "and", "args": [node]}
    return node


def polygon(points: int, x: float = 0.0) -> dict[str, Any]:
    """A saw blade: teeth along the top, closed underneath."""
    teeth = [[x + i * 1e-4, (i % 2) * 1e-4] for i in range(points - 3)]
    ring = teeth + [[teeth[-1][0], -0.5], [x, -0.5], [x, 0.0]]
    return {"type": "Polygon", "coordinates": [ring]}


def shapes(n: int) -> dict[str, Any]:
    return {
        "op": "or",
        "args": [{"op": "s_intersects", "args": [G, polygon(5, i)]} for i in range(n)],
    }


def area(points: int) -> dict[str, Any]:
    return {
        "op": "and",
        "args": [
            {"op": "=", "args": [P, 1]},
            {"op": "s_intersects", "args": [G, polygon(points)]},
        ],
    }


def query(cql: Any, lang: str | None = None) -> dict[str, Any] | None:
    text = cql if isinstance(cql, str) else json.dumps(cql)
    return asyncio.run(cql_filter_query(filter=text, filter_lang=lang))


CEILINGS = [
    ("conditions", conditions, limits.REQUEST_MAX_CONDITIONS),
    ("values", values, limits.REQUEST_MAX_VALUES),
    ("depth", nested, limits.REQUEST_MAX_DEPTH),
    ("shapes", shapes, limits.REQUEST_MAX_SHAPES),
    ("points", area, limits.REQUEST_MAX_POINTS),
]


@pytest.mark.parametrize("name, build, ceiling", CEILINGS, ids=[c[0] for c in CEILINGS])
def test_exactly_at_a_ceiling_is_taken(name: str, build: Any, ceiling: int) -> None:
    text = json.dumps(build(ceiling))
    assert query(text) == {"filter": text, "lang": "cql2-json"}


@pytest.mark.parametrize("name, build, ceiling", CEILINGS, ids=[c[0] for c in CEILINGS])
def test_one_over_a_ceiling_is_400(name: str, build: Any, ceiling: int) -> None:
    with pytest.raises(HTTPException) as caught:
        query(build(ceiling + 1))
    assert caught.value.status_code == 400
    assert str(ceiling) in caught.value.detail


def test_a_saved_area_over_the_save_limit_is_taken() -> None:
    """A filter saved before the limits existed keeps filtering."""
    text = json.dumps(area(limits.MAX_POINTS + 400))
    assert query(text) == {"filter": text, "lang": "cql2-json"}


def test_the_filter_is_passed_on_as_it_was_sent() -> None:
    """The tile cache keys on the text as sent; nothing rewrites it here."""
    text = '{ "op" : "!=", "args": [{"property": "a"}, 1] }'
    assert query(text, "cql2-json") == {"filter": text, "lang": "cql2-json"}


def test_cql2_text_is_passed_on_as_it_was_sent() -> None:
    text = "name = 'x' AND pop > 3"
    assert query(text, "cql2-text") == {"filter": text, "lang": "cql2-text"}


UNPARSABLE = {
    "cut off": ('{"op":"and","args":[{"op":"=","args":[{"property":"a"},1]}', None),
    "no json": ("not json", None),
    "no object": ("[1, 2]", None),
    "a number": ("1", None),
    "unknown operator": ('{"op":"frobnicate","args":[{"property":"a"},1]}', None),
    "and of nothing": ('{"op":"and","args":[]}', None),
    "text": ("name = = 'x'", "cql2-text"),
    "json as text": ('{"op":"=","args":[{"property":"a"},1]}', "cql2-text"),
}


@pytest.mark.parametrize("text, lang", UNPARSABLE.values(), ids=list(UNPARSABLE))
def test_a_filter_that_does_not_parse_is_400(text: str, lang: str | None) -> None:
    with pytest.raises(HTTPException) as caught:
        query(text, lang)
    assert caught.value.status_code == 400
    detail = caught.value.detail
    # one sentence, without the filter or the parser's dump of it
    assert detail.startswith("The filter is not valid ") and detail.endswith(".")
    assert len(detail) < 60 and "\n" not in detail


LEGACY = [
    {"op": "!=", "args": [P, 1]},
    {"op": "isNull", "args": P},
    {"op": "between", "args": [P, 1, 2]},
    {"op": ">", "args": [P, {"date": "2020-01-01"}]},
    {"op": "s_intersects", "args": [G, {"bbox": [1, 2, 3, 4]}]},
    {"op": "=", "args": [{"op": "casei", "args": [P]}, "x"]},
    {"filter": {"op": "=", "args": [P, 1]}},
]


@pytest.mark.parametrize("cql", LEGACY, ids=[json.dumps(c)[:28] for c in LEGACY])
def test_the_spellings_normalize_rewrites_parse(cql: dict[str, Any]) -> None:
    """The check parses what the query path parses: the filter after
    `goatlib.filter.normalize`, so a saved legacy spelling keeps filtering."""
    text = json.dumps(cql)
    assert query(text) == {"filter": text, "lang": "cql2-json"}


@pytest.mark.parametrize("text", ["", "   "])
@pytest.mark.parametrize("lang", [None, "cql2-json", "cql2-text"])
def test_an_empty_filter_is_no_filter(text: str, lang: str | None) -> None:
    assert query(text, lang) is None


@pytest.mark.parametrize("text", ["{}", " { } "])
def test_an_empty_object_is_no_filter(text: str) -> None:
    """What a client sends for a layer without conditions."""
    assert query(text) is None
    assert query(text, "cql2-json") is None


def _wkt(points: int) -> str:
    ring = polygon(points)["coordinates"][0]
    return "POLYGON((" + ",".join(f"{x:.6f} {y:.6f}" for x, y in ring) + "))"


def _text_nested(levels: int) -> str:
    text = "aa = 1"
    for level in range(levels - 1):
        text = f"(b{level} = 1 {'AND' if level % 2 else 'OR'} {text})"
    return text


TEXT_CEILINGS = [
    (
        "conditions",
        lambda n: " AND ".join(f"f{i} = {i}" for i in range(n)),
        limits.REQUEST_MAX_CONDITIONS,
    ),
    (
        "values",
        lambda n: "aa IN (" + ",".join(str(i) for i in range(n)) + ")",
        limits.REQUEST_MAX_VALUES,
    ),
    ("depth", _text_nested, limits.REQUEST_MAX_DEPTH),
    (
        "shapes",
        lambda n: " OR ".join(f"S_INTERSECTS(geom, {_wkt(5)})" for _ in range(n)),
        limits.REQUEST_MAX_SHAPES,
    ),
    (
        "points",
        lambda n: f"S_INTERSECTS(geom, {_wkt(n)})",
        limits.REQUEST_MAX_POINTS,
    ),
]


@pytest.mark.parametrize(
    "name, build, ceiling", TEXT_CEILINGS, ids=[c[0] for c in TEXT_CEILINGS]
)
def test_the_ceilings_hold_for_cql2_text(name: str, build: Any, ceiling: int) -> None:
    """`a AND b AND c` reads as pairs in pairs; it is measured as the one
    `and` its JSON form is, so a long chain is counted, not called deep."""
    at = build(ceiling)
    assert query(at, "cql2-text") == {"filter": at, "lang": "cql2-text"}
    with pytest.raises(HTTPException) as caught:
        query(build(ceiling + 1), "cql2-text")
    assert caught.value.status_code == 400
    assert str(ceiling) in caught.value.detail


def test_a_chain_of_cql2_text_alternatives_is_one_condition() -> None:
    """Read pair by pair the chain would be far deeper than the depth ceiling."""
    text = " OR ".join(f"aa = {i}" for i in range(10 * limits.REQUEST_MAX_DEPTH))
    assert query(text, "cql2-text") == {"filter": text, "lang": "cql2-text"}


def test_cql2_text_too_deep_to_read_is_400() -> None:
    """The query path walks the pairs one in the other, so a chain it could
    not walk is refused instead of answered unfiltered."""
    text = " AND ".join(f"f{i} = {i}" for i in range(5_000))
    with pytest.raises(HTTPException) as caught:
        query(text, "cql2-text")
    assert caught.value.status_code == 400
    assert caught.value.detail == "The filter nests too deeply."


def test_a_repeated_filter_is_checked_once() -> None:
    """A screen of tiles brings the same filter once per tile."""
    from unittest.mock import patch

    import geoapi.dependencies as dependencies

    text = json.dumps(area(limits.MAX_POINTS))
    broken = text[:-1]
    dependencies._filter_problems.clear()
    with patch.object(
        dependencies, "over_request_limits", wraps=dependencies.over_request_limits
    ) as measured:
        for _ in range(3):
            assert query(text) == {"filter": text, "lang": "cql2-json"}
            with pytest.raises(HTTPException):
                query(broken)
    measured.assert_called_once()


def test_no_filter_and_an_unknown_language() -> None:
    assert asyncio.run(cql_filter_query(filter=None, filter_lang=None)) is None
    with pytest.raises(HTTPException) as caught:
        query(conditions(1), "sql")
    assert caught.value.status_code == 400


def test_json_too_deep_to_read_is_400() -> None:
    text = '{"op": "not", "args": [' * 100_000 + "]}" * 100_000
    with pytest.raises(HTTPException) as caught:
        query(text)
    assert caught.value.status_code == 400


@pytest.mark.parametrize(
    "path",
    [
        "/collections/{id}/items",
        "/collections/{id}/tiles/WebMercatorQuad/1/0/0",
    ],
)
def test_the_routes_answer_400(test_client: Any, path: str) -> None:
    layer = "abcdef12-3456-7890-abcd-ef1234567890"
    over = json.dumps(conditions(limits.REQUEST_MAX_CONDITIONS + 1))
    response = test_client.get(path.format(id=layer), params={"filter": over})
    assert response.status_code == 400, response.text
    assert str(limits.REQUEST_MAX_CONDITIONS) in response.json()["detail"]


@pytest.mark.parametrize(
    "path, params",
    [
        ("/collections/{id}/items", {}),
        ("/collections/{id}/tiles/WebMercatorQuad/1/0/0", {}),
        ("/collections/{id}/tiles/WebMercatorQuad/1/0/0", {"h3": "auto"}),
        ("/collections/{id}/tiles/WebMercatorQuad/1/0/0", {"dynamic": "true"}),
    ],
    ids=["items", "tiles", "h3 tiles", "dynamic tiles"],
)
@pytest.mark.parametrize(
    "query_filter",
    [
        {"filter": '{"op":"=","args":[{"property":"a"},1]'},
        {"filter": "name = = 'x'", "filter-lang": "cql2-text"},
    ],
    ids=["cql2-json", "cql2-text"],
)
def test_the_routes_answer_400_to_a_filter_that_does_not_parse(
    test_client: Any, path: str, params: dict[str, str], query_filter: dict[str, str]
) -> None:
    layer = "abcdef12-3456-7890-abcd-ef1234567890"
    response = test_client.get(path.format(id=layer), params=params | query_filter)
    assert response.status_code == 400, response.text
    assert response.json()["detail"].startswith("The filter is not valid ")


@pytest.mark.parametrize("lang", ["cql2-json", "cql2-text"])
def test_a_filter_text_over_the_length_bound_is_400_without_a_parse(
    lang: str,
) -> None:
    """A text longer than any filter the web sends is refused by its length:
    nothing parses it, and its verdict is not kept."""
    from unittest.mock import patch

    import geoapi.dependencies as dependencies

    dependencies._filter_problems.clear()
    text = "a" * (dependencies._FILTER_TEXT_MAX + 1)
    with patch.object(dependencies, "_filter_problem") as checked:
        with pytest.raises(HTTPException) as caught:
            query(text, lang)
    assert caught.value.status_code == 400
    checked.assert_not_called()
    assert not dependencies._filter_problems


def test_the_length_bound_lies_above_what_the_web_sends() -> None:
    """The web stops a filter at `limits.MAX_LENGTH` URL characters, and a
    filter's text is never longer than its URL form."""
    import geoapi.dependencies as dependencies

    assert dependencies._FILTER_TEXT_MAX > limits.MAX_LENGTH


def test_a_filter_is_checked_off_the_event_loop() -> None:
    """The parse runs in a worker thread, so other requests are served
    meanwhile."""
    import threading
    from unittest.mock import patch

    import geoapi.dependencies as dependencies

    dependencies._filter_problems.clear()
    loop_thread = threading.get_ident()
    threads: list[int] = []
    check = dependencies._filter_problem

    def recorded(text: str, lang: str) -> str | None:
        threads.append(threading.get_ident())
        return check(text, lang)

    with patch.object(dependencies, "_filter_problem", recorded):
        assert query(conditions(2)) is not None
    assert threads and loop_thread not in threads


def test_requests_with_one_filter_at_once_share_one_check() -> None:
    """A screen of tiles brings the same filter at once: the first request's
    check answers them all."""
    from unittest.mock import patch

    import geoapi.dependencies as dependencies

    dependencies._filter_problems.clear()
    text = json.dumps(conditions(3))
    calls: list[str] = []
    check = dependencies._filter_problem

    def counted(text: str, lang: str) -> str | None:
        calls.append(text)
        return check(text, lang)

    async def screen() -> list[Any]:
        return await asyncio.gather(
            *(cql_filter_query(filter=text, filter_lang=None) for _ in range(8))
        )

    with patch.object(dependencies, "_filter_problem", counted):
        answers = asyncio.run(screen())
    assert answers == [{"filter": text, "lang": "cql2-json"}] * 8
    assert len(calls) == 1
    assert not dependencies._filter_problems_running
