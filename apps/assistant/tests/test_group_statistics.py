"""project_group_statistics (spec 2026-10-23 §3.4): a statistic per group
through processes' aggregation-stats, shares computed by the server, and the
Restricted form."""

import json
from typing import Any

import httpx
import pytest

from assistant.context import parse_context
from assistant.tools.project import GROUP_STATISTICS
from assistant.tools.runtime import InputInvalid, execute
from assistant.tools.testing import Recorder, fake_clients, tool_env

PROJECT = "00000000-0000-0000-0000-0000000005e1"
PAGE = parse_context({"surface": "project.map", "project_id": PROJECT})
BANDS = "e1000000-0000-0000-0000-000000000090"
DISTRICTS = "e1000000-0000-0000-0000-000000000091"
LAYERS = [
    {
        "id": 90,
        "layer_id": BANDS,
        "name": "Einwohner je Bezirk und Band",
        "type": "feature",
    },
    {"id": 91, "layer_id": DISTRICTS, "name": "Bezirke", "type": "feature"},
]
QUERYABLES = {
    BANDS: {
        "properties": {
            "name": {"type": "string"},
            "band": {"type": "integer"},
            "einwohner": {"type": "integer"},
        }
    },
    DISTRICTS: {
        "properties": {"name": {"type": "string"}, "einwohner": {"type": "integer"}}
    },
}
ROWS = {
    BANDS: [
        {
            "grouped_value": "Mitte",
            "grouped_secondary_value": "5",
            "operation_value": 1200,
        },
        {
            "grouped_value": "Nord",
            "grouped_secondary_value": "5",
            "operation_value": 300,
        },
        {"grouped_value": "Ost", "grouped_secondary_value": "5", "operation_value": 3},
    ],
    DISTRICTS: [
        {
            "grouped_value": "Mitte",
            "grouped_secondary_value": None,
            "operation_value": 12000,
        },
        {
            "grouped_value": "Nord",
            "grouped_secondary_value": None,
            "operation_value": 3000,
        },
    ],
}


def _services(
    features: int = 42,
    rows: dict[str, list[dict[str, Any]]] | None = None,
    groups: dict[str, int] | None = None,
) -> tuple[Recorder, Recorder, Recorder]:
    """``rows`` and ``groups`` (total_items) per layer replace ROWS and the
    number of its rows."""
    core = Recorder({("GET", f"/api/v2/project/{PROJECT}/layer"): LAYERS})
    geoapi = Recorder(
        {
            ("GET", f"/collections/{layer}/queryables"): doc
            for layer, doc in QUERYABLES.items()
        }
    )

    def aggregate(request: httpx.Request) -> httpx.Response:
        inputs = json.loads(request.content)["inputs"]
        layer = inputs["collection"]
        items = {**ROWS, **(rows or {})}[layer]
        total = (groups or {}).get(layer, len(items))
        # As processes answers: the first `limit` groups, and how many there are.
        return httpx.Response(
            200,
            json={
                "items": items[: inputs.get("limit", 100)],
                "total_items": total,
                "total_count": features,
            },
        )

    processes = Recorder(
        {("POST", "/processes/aggregation-stats/execution"): aggregate}
    )
    return core, geoapi, processes


def _env(
    services: tuple[Recorder, Recorder, Recorder], policy: str = "standard"
) -> Any:
    core, geoapi, processes = services
    return tool_env(
        fake_clients(core=core, geoapi=geoapi, processes=processes),
        page=PAGE,
        data_policy=policy,  # type: ignore[arg-type]
    )


async def test_sums_per_district_and_band() -> None:
    services = _services()
    out = await execute(
        GROUP_STATISTICS,
        _env(services),
        {
            "layer_project_id": 90,
            "operation": "sum",
            "field": "einwohner",
            "group_by": "name",
            "then_by": "band",
        },
    )
    assert [(r["group"], r["then"], r["value"]) for r in out["rows"]] == [
        ("Mitte", "5", 1200.0),
        ("Nord", "5", 300.0),
        ("Ost", "5", 3.0),
    ]
    assert out["groups"] == 3 and out["features"] == 42
    [body] = services[2].bodies()
    assert body["inputs"] == {
        "collection": BANDS,
        "operation": "sum",
        "operation_column": "einwohner",
        "group_by_column": "name",
        "group_by_secondary_column": "band",
        "order": "descendent",
        "limit": 100,
    }


async def test_shares_are_computed_by_the_server() -> None:
    out = await execute(
        GROUP_STATISTICS,
        _env(_services()),
        {
            "layer_project_id": 90,
            "operation": "sum",
            "field": "einwohner",
            "group_by": "name",
            "then_by": "band",
            "share_of": {
                "layer_project_id": 91,
                "operation": "sum",
                "field": "einwohner",
                "group_by": "name",
            },
        },
    )
    shares = {(r["group"], r.get("share")) for r in out["rows"]}
    assert shares == {("Mitte", 0.1), ("Nord", 0.1), ("Ost", None)}
    assert out["unmatched"] == 1


async def test_a_sum_needs_a_numeric_field() -> None:
    with pytest.raises(InputInvalid):
        await execute(
            GROUP_STATISTICS,
            _env(_services()),
            {"layer_project_id": 90, "operation": "sum", "group_by": "name"},
        )
    with pytest.raises(InputInvalid):
        await execute(
            GROUP_STATISTICS,
            _env(_services()),
            {
                "layer_project_id": 90,
                "operation": "sum",
                "field": "name",
                "group_by": "name",
            },
        )
    with pytest.raises(InputInvalid):
        await execute(
            GROUP_STATISTICS,
            _env(_services()),
            {"layer_project_id": 90, "operation": "count", "group_by": "bezirk"},
        )


async def test_restricted_sends_counts_only_and_masks_small_groups() -> None:
    sums = await execute(
        GROUP_STATISTICS,
        _env(_services(), "restricted"),
        {
            "layer_project_id": 90,
            "operation": "sum",
            "field": "einwohner",
            "group_by": "name",
        },
    )
    assert sums.get("withheld") is True
    counts = await execute(
        GROUP_STATISTICS,
        _env(_services(), "restricted"),
        {"layer_project_id": 90, "operation": "count", "group_by": "name"},
    )
    assert [(r["group"], r.get("value")) for r in counts["rows"]] == [
        ("Mitte", 1200.0),
        ("Nord", 300.0),
        ("Ost", None),
    ]
    assert "fewer than 5" in counts["note"]


def _filtered_services(
    name_values: int, features: int = 42
) -> tuple[Recorder, Recorder, Recorder]:
    """Services whose unique-values answer counts "band" as a field of 3 values
    held by 40 features each, and "name" as one of ``name_values`` values."""
    core, geoapi, processes = _services(features)

    def unique(request: httpx.Request) -> httpx.Response:
        inputs = json.loads(request.content)["inputs"]
        total = {"band": 3, "name": name_values}[inputs["attribute"]]
        return httpx.Response(
            200, json={"values": [{"value": 5, "count": 40}], "total": total}
        )

    processes.routes[("POST", "/processes/unique-values/execution")] = unique
    return core, geoapi, processes


@pytest.mark.parametrize(("group_by", "then_by"), [("name", None), ("band", "name")])
async def test_restricted_with_a_filter_judges_the_groups_on_the_whole_layer(
    group_by: str, then_by: str | None
) -> None:
    """A filter can leave few groups of a field with many values (one name per
    feature): the group names would leave, although Restricted never sends the
    values of such a field."""
    request = {
        "layer_project_id": 90,
        "operation": "count",
        "group_by": group_by,
        "then_by": then_by,
        "filter": {"conditions": [{"field": "band", "op": "=", "value": 5}]},
    }
    many = await execute(
        GROUP_STATISTICS, _env(_filtered_services(120), "restricted"), request
    )
    assert many.get("withheld") is True
    few = await execute(
        GROUP_STATISTICS, _env(_filtered_services(3), "restricted"), request
    )
    assert [r["group"] for r in few["rows"]] == ["Mitte", "Nord", "Ost"]


async def test_restricted_withholds_a_filter_that_matches_few_features() -> None:
    """The number of features a filter matches is what project_count_features
    withholds below 5; the total and the groups would say it here."""
    request = {
        "layer_project_id": 90,
        "operation": "count",
        "group_by": "name",
        "filter": {"conditions": [{"field": "band", "op": "=", "value": 5}]},
    }
    few = await execute(
        GROUP_STATISTICS, _env(_filtered_services(3, features=4), "restricted"), request
    )
    assert few.get("withheld") is True
    enough = await execute(
        GROUP_STATISTICS, _env(_filtered_services(3, features=5), "restricted"), request
    )
    assert enough["features"] == 5


def _keys(value: Any) -> set[str]:
    """Every key anywhere in a JSON value."""
    if isinstance(value, dict):
        return set(value) | {key for item in value.values() for key in _keys(item)}
    if isinstance(value, list):
        return {key for item in value for key in _keys(item)}
    return set()


SHARE_OF = {
    "layer_project_id": 91,
    "operation": "sum",
    "field": "einwohner",
    "group_by": "name",
}


@pytest.mark.parametrize(
    ("args", "groups"),
    [
        pytest.param({"operation": "sum", "field": "einwohner"}, 3, id="sum"),
        pytest.param({"operation": "mean", "field": "einwohner"}, 3, id="mean"),
        pytest.param({"operation": "min", "field": "einwohner"}, 3, id="min"),
        pytest.param({"operation": "max", "field": "einwohner"}, 3, id="max"),
        pytest.param({"operation": "count"}, 51, id="count of more than 50 groups"),
        pytest.param(
            {"operation": "count", "share_of": SHARE_OF}, 3, id="count share_of"
        ),
        pytest.param(
            {"operation": "sum", "field": "einwohner", "share_of": SHARE_OF},
            3,
            id="sum share_of",
        ),
    ],
)
async def test_restricted_withholds_all_but_counts_of_few_groups(
    args: dict[str, Any], groups: int
) -> None:
    out = await execute(
        GROUP_STATISTICS,
        _env(_services(groups={BANDS: groups}), "restricted"),
        {"layer_project_id": 90, "group_by": "name", "then_by": "band", **args},
    )
    assert set(out) == {"withheld", "reason"}


async def test_restricted_counts_of_50_groups_carry_no_shares() -> None:
    out = await execute(
        GROUP_STATISTICS,
        _env(_services(groups={BANDS: 50}), "restricted"),
        {"layer_project_id": 90, "operation": "count", "group_by": "name"},
    )
    assert len(out["rows"]) == 3
    assert not {"denominator", "share", "unmatched", "withheld"} & _keys(out)


def _band(district: str | None, band: str | None, value: float) -> dict[str, Any]:
    return {
        "grouped_value": district,
        "grouped_secondary_value": band,
        "operation_value": value,
    }


def _district(district: str | None, value: float) -> dict[str, Any]:
    return _band(district, None, value)


async def test_unmatched_counts_groups_not_rows() -> None:
    rows = {
        BANDS: [
            _band("Mitte", "5", 1200),
            _band("Mitte", "6", 600),
            _band("Ost", "5", 30),
            _band("Ost", "6", 20),
        ],
        DISTRICTS: [_district("Mitte", 12000)],
    }
    out = await execute(
        GROUP_STATISTICS,
        _env(_services(rows=rows)),
        {
            "layer_project_id": 90,
            "operation": "sum",
            "field": "einwohner",
            "group_by": "name",
            "then_by": "band",
            "share_of": SHARE_OF,
        },
    )
    assert [r.get("share") for r in out["rows"]] == [0.1, 0.05, None, None]
    assert out["unmatched"] == 1
    assert "1 group(s) have no matching value of 'name' in 'Bezirke'" in out["note"]


async def test_a_cut_list_of_the_other_layer_is_not_counted_as_unmatched() -> None:
    rows = {DISTRICTS: [_district("Mitte", 12000), _district("Nord", 3000)]}
    out = await execute(
        GROUP_STATISTICS,
        _env(_services(rows=rows, groups={DISTRICTS: 1500})),
        {
            "layer_project_id": 90,
            "operation": "sum",
            "field": "einwohner",
            "group_by": "name",
            "share_of": SHARE_OF,
        },
    )
    assert [r.get("share") for r in out["rows"]] == [0.1, 0.1, None]
    # Left out, not 0: a cut list cannot say that every group matched.
    assert "unmatched" not in out
    assert "first 1000" in out["note"] and "'Bezirke'" in out["note"]
    assert "no matching value" not in out["note"]


async def test_the_denominator_is_read_beyond_the_first_100_groups() -> None:
    """The first layer's groups may be anywhere in the other layer's list:
    it is read with up to 1000 groups, while the rows stay at 100."""
    districts = [_district(f"D{n:03d}", 1000 - n) for n in range(150)]
    services = _services(rows={BANDS: [_band("D140", None, 86)], DISTRICTS: districts})
    out = await execute(
        GROUP_STATISTICS,
        _env(services),
        {
            "layer_project_id": 90,
            "operation": "sum",
            "field": "einwohner",
            "group_by": "name",
            "share_of": SHARE_OF,
        },
    )
    [row] = out["rows"]
    assert row["denominator"] == 860 and row["share"] == 0.1
    assert out["unmatched"] == 0
    numerator, denominator = (body["inputs"] for body in services[2].bodies())
    assert numerator["limit"] == 100 and denominator["limit"] == 1000


DIFFERENT_LAYERS = (
    "Numerator and denominator are read from two layers ('Einwohner je Bezirk "
    "und Band', 'Bezirke'). If the layers come from different sources, check "
    "that both count the same population (source and year)."
)


async def test_a_share_over_another_layer_says_to_check_its_population() -> None:
    out = await execute(
        GROUP_STATISTICS,
        _env(_services()),
        {
            "layer_project_id": 90,
            "operation": "sum",
            "field": "einwohner",
            "group_by": "name",
            "share_of": SHARE_OF,
        },
    )
    assert DIFFERENT_LAYERS in out["note"]


async def test_a_share_over_the_same_layer_has_no_such_note() -> None:
    out = await execute(
        GROUP_STATISTICS,
        _env(_whole_services({BANDS: 6000})),
        {
            "layer_project_id": 90,
            "operation": "sum",
            "field": "einwohner",
            "share_of": {"layer_project_id": 90, "field": "einwohner"},
        },
    )
    assert "two layers" not in (out.get("note") or "")


async def test_a_zero_denominator_gives_no_share_and_says_so() -> None:
    rows = {
        DISTRICTS: [
            _district("Mitte", 12000),
            _district("Nord", 0),
            _district("Ost", 30),
        ]
    }
    out = await execute(
        GROUP_STATISTICS,
        _env(_services(rows=rows)),
        {
            "layer_project_id": 90,
            "operation": "sum",
            "field": "einwohner",
            "group_by": "name",
            "share_of": SHARE_OF,
        },
    )
    assert [r.get("share") for r in out["rows"]] == [0.1, None, 0.1]
    assert out["unmatched"] == 0
    assert "1 group(s) have no value or a denominator of 0" in out["note"]


async def test_a_null_group_never_gets_a_share() -> None:
    rows = {
        BANDS: [_band("Mitte", "5", 1200), _band(None, "5", 50)],
        DISTRICTS: [_district("Mitte", 12000), _district(None, 500)],
    }
    out = await execute(
        GROUP_STATISTICS,
        # total_items is a COUNT(DISTINCT), which leaves the null group out.
        _env(_services(rows=rows, groups={DISTRICTS: 1})),
        {
            "layer_project_id": 90,
            "operation": "sum",
            "field": "einwohner",
            "group_by": "name",
            "then_by": "band",
            "share_of": SHARE_OF,
        },
    )
    mitte, empty = out["rows"]
    assert mitte["share"] == 0.1
    assert "group" not in empty and not {"denominator", "share"} & set(empty)
    assert out["unmatched"] == 0
    assert out["note"] == (
        f"{DIFFERENT_LAYERS} A row without group holds the features with no value "
        "in 'name'."
    )


async def test_null_values_are_named_in_the_note_under_both_policies() -> None:
    rows = {
        BANDS: [
            _band("Mitte", "5", 1200),
            _band("Mitte", None, 300),
            _band(None, None, 3),
        ]
    }
    request = {
        "layer_project_id": 90,
        "operation": "count",
        "group_by": "name",
        "then_by": "band",
    }
    standard = await execute(GROUP_STATISTICS, _env(_services(rows=rows)), request)
    assert standard["note"] == (
        "A row without group holds the features with no value in 'name'. "
        "A row without then holds the features with no value in 'band'."
    )
    restricted = await execute(
        GROUP_STATISTICS, _env(_services(rows=rows), "restricted"), request
    )
    assert restricted["note"] == (
        "A row without group holds the features with no value in 'name'. "
        "A row without then holds the features with no value in 'band'. "
        "1 group(s) have fewer than 5 features; the data policy (Restricted) withholds their counts."
    )


def _whole_services(
    totals: dict[str, float], features: int = 50
) -> tuple[Recorder, Recorder, Recorder]:
    """aggregation-stats answers one ungrouped row per call: the total of the
    layer for that request's filter, keyed by (layer, filter text or None), and
    ``features`` matching features. unique-values counts "band" as a field of
    3 values held by 40 features each, for filters under Restricted."""
    core, geoapi, _ = _services()
    seen: list[dict[str, Any]] = []

    def aggregate(request: httpx.Request) -> httpx.Response:
        inputs = json.loads(request.content)["inputs"]
        seen.append(inputs)
        key = f"{inputs['collection']}|{inputs.get('filter')}"
        value = totals[key] if key in totals else totals[inputs["collection"]]
        return httpx.Response(
            200,
            json={
                "items": [
                    {
                        "grouped_value": None,
                        "grouped_secondary_value": None,
                        "operation_value": value,
                    }
                ],
                "total_items": 1,
                "total_count": features,
            },
        )

    def unique(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"values": [{"value": 5, "count": 40}], "total": 3}
        )

    processes = Recorder(
        {
            ("POST", "/processes/aggregation-stats/execution"): aggregate,
            ("POST", "/processes/unique-values/execution"): unique,
        }
    )
    processes.seen = seen  # type: ignore[attr-defined]
    return core, geoapi, processes


async def test_one_row_for_the_whole_filtered_layer() -> None:
    services = _whole_services({BANDS: 1503})
    out = await execute(
        GROUP_STATISTICS,
        _env(services),
        {
            "layer_project_id": 90,
            "operation": "sum",
            "field": "einwohner",
            "filter": {"conditions": [{"field": "band", "op": "=", "value": 5}]},
        },
    )
    # None fields are left out of the result.
    assert out.get("group_by") is None
    assert [(r.get("group"), r["value"]) for r in out["rows"]] == [(None, 1503)]
    assert (
        "group_by_column" not in services[2].seen[0]
        or services[2].seen[0]["group_by_column"] is None
    )
    assert "note" not in out


async def test_a_share_whose_denominator_has_its_own_filter() -> None:
    """Residents in band 5 over residents of the whole layer: the same layer,
    the numerator filtered, the denominator not."""
    services = _whole_services({BANDS: 6000})
    numerator_filter = {"conditions": [{"field": "band", "op": "=", "value": 5}]}
    out = await execute(
        GROUP_STATISTICS,
        _env(services),
        {
            "layer_project_id": 90,
            "operation": "sum",
            "field": "einwohner",
            "filter": numerator_filter,
            "share_of": {
                "layer_project_id": 90,
                "operation": "sum",
                "field": "einwohner",
            },
        },
    )
    numerator, denominator = services[2].seen
    assert numerator["filter"] is not None
    assert denominator.get("filter") is None
    [row] = out["rows"]
    assert row["share"] == 1.0  # the fake answers 6000 for both


async def test_the_share_filter_reaches_the_denominator_only() -> None:
    services = _whole_services({BANDS: 1000})
    out = await execute(
        GROUP_STATISTICS,
        _env(services),
        {
            "layer_project_id": 90,
            "operation": "sum",
            "field": "einwohner",
            "share_of": {
                "layer_project_id": 90,
                "operation": "sum",
                "field": "einwohner",
                "filter": {"conditions": [{"field": "band", "op": "<=", "value": 10}]},
            },
        },
    )
    numerator, denominator = services[2].seen
    assert numerator.get("filter") is None
    assert "band" in denominator["filter"]
    assert out["rows"][0]["share"] == 1.0


async def test_each_group_over_one_total() -> None:
    """Groups over the other layer's ungrouped total: the share of each
    district in the whole."""
    services = _services(
        rows={
            DISTRICTS: [
                {
                    "grouped_value": None,
                    "grouped_secondary_value": None,
                    "operation_value": 15000,
                }
            ]
        }
    )
    out = await execute(
        GROUP_STATISTICS,
        _env(services),
        {
            "layer_project_id": 90,
            "operation": "sum",
            "field": "einwohner",
            "group_by": "name",
            "share_of": {
                "layer_project_id": 91,
                "operation": "sum",
                "field": "einwohner",
            },
        },
    )
    shares = {r["group"]: r["share"] for r in out["rows"]}
    assert shares["Mitte"] == round(1200 / 15000, 6)
    assert shares["Ost"] == round(3 / 15000, 6)
    # Every group is divided by the one total: none is unmatched.
    assert "unmatched" not in out and out["note"] == DIFFERENT_LAYERS


async def test_a_grouped_denominator_needs_a_grouped_numerator() -> None:
    with pytest.raises(InputInvalid, match="share_of.group_by needs group_by"):
        await execute(
            GROUP_STATISTICS,
            _env(_services()),
            {
                "layer_project_id": 90,
                "operation": "count",
                "share_of": {
                    "layer_project_id": 91,
                    "operation": "count",
                    "group_by": "name",
                },
            },
        )


async def test_then_by_needs_group_by() -> None:
    with pytest.raises(InputInvalid, match="then_by needs group_by"):
        await execute(
            GROUP_STATISTICS,
            _env(_services()),
            {"layer_project_id": 90, "operation": "count", "then_by": "band"},
        )


async def test_shares_keep_six_decimals() -> None:
    services = _services(
        rows={DISTRICTS: [_district("Mitte", 12000), _district("Nord", 7000)]}
    )
    out = await execute(
        GROUP_STATISTICS,
        _env(services),
        {
            "layer_project_id": 90,
            "operation": "sum",
            "field": "einwohner",
            "group_by": "name",
            "share_of": {
                "layer_project_id": 91,
                "operation": "sum",
                "field": "einwohner",
                "group_by": "name",
            },
        },
    )
    shares = {r["group"]: r.get("share") for r in out["rows"]}
    assert shares["Mitte"] == round(1200 / 12000, 6)
    # 0.042857 at six decimals, 0.0429 at four.
    assert shares["Nord"] == round(300 / 7000, 6)


async def test_restricted_counts_the_whole_filtered_layer_from_five() -> None:
    """Without group_by there is no grouping field to judge, so the count of
    the filtered layer is sent from 5 matching features and withheld below,
    as project_count_features does."""
    request = {
        "layer_project_id": 90,
        "operation": "count",
        "filter": {"conditions": [{"field": "band", "op": "=", "value": 5}]},
    }
    few = await execute(
        GROUP_STATISTICS,
        _env(_whole_services({BANDS: 4}, features=4), policy="restricted"),
        request,
    )
    assert few.get("withheld") is True
    enough = await execute(
        GROUP_STATISTICS,
        _env(_whole_services({BANDS: 5}, features=5), policy="restricted"),
        request,
    )
    assert [(r.get("group"), r["value"]) for r in enough["rows"]] == [(None, 5)]
    assert enough["features"] == 5


async def test_restricted_withholds_a_share_without_groups() -> None:
    out = await execute(
        GROUP_STATISTICS,
        _env(_whole_services({BANDS: 50}), policy="restricted"),
        {
            "layer_project_id": 90,
            "operation": "count",
            "share_of": {"layer_project_id": 90, "operation": "count"},
        },
    )
    assert set(out) == {"withheld", "reason"}


SHARE_OF_TOTAL = {"layer_project_id": 91, "operation": "sum", "field": "einwohner"}


async def test_the_row_without_a_group_is_divided_by_the_total_too() -> None:
    rows = {
        BANDS: [_district("Mitte", 1200), _district(None, 300)],
        DISTRICTS: [_district(None, 15000)],
    }
    out = await execute(
        GROUP_STATISTICS,
        _env(_services(rows=rows)),
        {
            "layer_project_id": 90,
            "operation": "sum",
            "field": "einwohner",
            "group_by": "name",
            "share_of": SHARE_OF_TOTAL,
        },
    )
    assert [(r.get("group"), r["share"]) for r in out["rows"]] == [
        ("Mitte", 0.08),
        (None, 0.02),
    ]
    assert out["note"] == (
        f"{DIFFERENT_LAYERS} A row without group holds the features with no value "
        "in 'name'."
    )


async def test_a_total_of_0_gives_no_share_and_says_so() -> None:
    out = await execute(
        GROUP_STATISTICS,
        _env(_services(rows={DISTRICTS: [_district(None, 0)]})),
        {
            "layer_project_id": 90,
            "operation": "sum",
            "field": "einwohner",
            "group_by": "name",
            "share_of": SHARE_OF_TOTAL,
        },
    )
    assert not any("share" in r for r in out["rows"])
    assert "3 row(s) have no value or a denominator of 0" in out["note"]


ABOVE_WHOLE = (
    "2 group(s) have a share above 100 %: numerator and denominator were "
    "assigned to the groups differently. Rebuild the share from one "
    "assignment, both counted per group the same way, before you answer; "
    "never present a share above 100 %."
)
ABOVE_WHOLE_ROWS = {
    BANDS: [_district("Mitte", 1212), _district("Nord", 303), _district("Ost", 3)],
    DISTRICTS: [
        _district("Mitte", 1200),
        _district("Nord", 300),
        _district("Ost", 30),
    ],
}
ABOVE_WHOLE_REQUEST = {
    "layer_project_id": 90,
    "operation": "sum",
    "field": "einwohner",
    "group_by": "name",
    "share_of": SHARE_OF,
}


async def test_a_share_above_100_percent_says_to_rebuild_it() -> None:
    """A part never exceeds its whole: a share above 100 % comes from a
    numerator and a denominator assigned to the groups in different ways,
    such as reached residents split over districts by area share against
    census points counted per district. The note counts those groups and
    names none of them, nor any value."""
    out = await execute(
        GROUP_STATISTICS,
        _env(_services(rows=ABOVE_WHOLE_ROWS)),
        ABOVE_WHOLE_REQUEST,
    )
    assert [r["share"] for r in out["rows"]] == [1.01, 1.01, 0.1]
    assert ABOVE_WHOLE in out["note"]
    for named in ("Mitte", "Nord", "Ost", "1.01", "1212", "1200", "303", "101"):
        assert named not in out["note"], named


async def test_restricted_withholds_a_share_above_100_percent_too() -> None:
    out = await execute(
        GROUP_STATISTICS,
        _env(_services(rows=ABOVE_WHOLE_ROWS), "restricted"),
        ABOVE_WHOLE_REQUEST,
    )
    assert set(out) == {"withheld", "reason"}


async def test_a_whole_share_and_a_ratio_of_means_carry_no_such_note() -> None:
    """100 % is a whole, not above it; a ratio of means is no part of a
    whole and may pass 1."""
    whole = await execute(
        GROUP_STATISTICS,
        _env(
            _services(
                rows={
                    BANDS: [_district("Mitte", 1200)],
                    DISTRICTS: [_district("Mitte", 1200)],
                }
            )
        ),
        ABOVE_WHOLE_REQUEST,
    )
    assert whole["rows"][0]["share"] == 1.0
    assert "above 100 %" not in whole["note"]
    means = await execute(
        GROUP_STATISTICS,
        _env(
            _services(
                rows={
                    BANDS: [_district("Mitte", 12)],
                    DISTRICTS: [_district("Mitte", 6)],
                }
            )
        ),
        {
            **ABOVE_WHOLE_REQUEST,
            "operation": "mean",
            "share_of": {**SHARE_OF, "operation": "mean"},
        },
    )
    assert means["rows"][0]["share"] == 2.0
    assert "above 100 %" not in means["note"]


async def test_a_total_above_its_whole_says_so_too() -> None:
    out = await execute(
        GROUP_STATISTICS,
        _env(_whole_services({BANDS: 1100, DISTRICTS: 1000})),
        {
            "layer_project_id": 90,
            "operation": "sum",
            "field": "einwohner",
            "share_of": SHARE_OF_TOTAL,
        },
    )
    assert out["rows"][0]["share"] == 1.1
    assert (
        "The share is above 100 %: numerator and denominator were counted from "
        "different features. Rebuild the share from one assignment before you "
        "answer; never present a share above 100 %."
    ) in out["note"]


#: Districts by residents in the worst classes (the numerator, by value) and
#: by all their residents: the smallest district lies wholly in them, and
#: processes lists it last of 150.
RANKED = {
    BANDS: [
        _district("Gross", 5000),
        _district("Mittel", 1000),
        *(_district(f"D{n:03d}", 900 - n) for n in range(147)),
        _district("Klein", 126),
    ],
    DISTRICTS: [
        _district("Gross", 20000),
        _district("Mittel", 2000),
        *(_district(f"D{n:03d}", 10 * (900 - n)) for n in range(147)),
        _district("Klein", 126),
    ],
}
RANK_BY_SHARE = {
    "layer_project_id": 90,
    "operation": "sum",
    "field": "einwohner",
    "group_by": "name",
    "share_of": SHARE_OF,
    "order_by": "share",
}


async def test_ranked_by_share_a_small_group_of_100_percent_comes_first() -> None:
    """Live pass 8 (Q42): the top three by share left out a district of 126
    residents, all in the worst classes, which came last of the rows sorted
    by value. Ranked by share, it comes first, also from beyond the first
    100 groups by value."""
    services = _services(rows=RANKED)
    out = await execute(GROUP_STATISTICS, _env(services), {**RANK_BY_SHARE, "limit": 3})
    assert [(r["group"], r["value"], r["share"]) for r in out["rows"]] == [
        ("Klein", 126.0, 1.0),
        ("Mittel", 1000.0, 0.5),
        ("Gross", 5000.0, 0.25),
    ]
    assert out["groups"] == 150
    numerator, denominator = (body["inputs"] for body in services[2].bodies())
    assert numerator["limit"] == 1000 and numerator["order"] == "descendent"
    assert denominator["limit"] == 1000


async def test_ranked_by_share_the_lowest_first() -> None:
    out = await execute(
        GROUP_STATISTICS,
        _env(_services(rows=RANKED)),
        {**RANK_BY_SHARE, "lowest_first": True, "limit": 2},
    )
    assert [(r["group"], r["share"]) for r in out["rows"]] == [
        ("D000", 0.1),
        ("D001", 0.1),
    ]


@pytest.mark.parametrize("lowest_first", [False, True])
async def test_groups_without_a_share_come_last(lowest_first: bool) -> None:
    """A group the other layer has no value for, and one with a denominator
    of 0, have no share: they come last in either order, however large
    their value."""
    rows = {
        BANDS: [
            _district("Fehlt", 9000),
            _district("Null", 8000),
            _district("Mitte", 1200),
            _district("Nord", 600),
        ],
        DISTRICTS: [
            _district("Mitte", 12000),
            _district("Nord", 3000),
            _district("Null", 0),
        ],
    }
    out = await execute(
        GROUP_STATISTICS,
        _env(_services(rows=rows)),
        {**RANK_BY_SHARE, "lowest_first": lowest_first},
    )
    ranked = [(r["group"], r.get("share")) for r in out["rows"]]
    shared = [("Nord", 0.2), ("Mitte", 0.1)]
    assert ranked == [
        *(shared[::-1] if lowest_first else shared),
        ("Fehlt", None),
        ("Null", None),
    ]
    assert out["unmatched"] == 1
    # Counted over the groups read, which the limit may cut.
    assert "1 group(s) of the 4 read have no matching value of 'name'" in (out["note"])
    assert (
        "1 group(s) of the 4 read have no value or a denominator of 0" in (out["note"])
    )


#: Residents in reach per district over all residents per district: no one
#: in Sued is in reach, so the filtered numerator has no row for it.
IN_REACH = {
    BANDS: [_district("Mitte", 1200), _district("Nord", 600)],
    DISTRICTS: [
        _district("Mitte", 12000),
        _district("Sued", 5000),
        _district("Nord", 3000),
    ],
}


@pytest.mark.parametrize("lowest_first", [False, True])
async def test_a_group_with_no_features_ranks_with_a_share_of_0(
    lowest_first: bool,
) -> None:
    """A sum or count over no features is 0: a district the numerator's
    filter leaves without a row gets one, 0 of its residents, and ranks
    first among the lowest shares and last among the highest."""
    out = await execute(
        GROUP_STATISTICS,
        _env(_services(rows=IN_REACH)),
        {**RANK_BY_SHARE, "lowest_first": lowest_first, "limit": 3},
    )
    ranked = [
        (r["group"], r["value"], r["denominator"], r["share"]) for r in out["rows"]
    ]
    by_share = [
        ("Nord", 600.0, 3000.0, 0.2),
        ("Mitte", 1200.0, 12000.0, 0.1),
        ("Sued", 0.0, 5000.0, 0.0),
    ]
    assert ranked == (by_share[::-1] if lowest_first else by_share)
    assert out["groups"] == 3 and out["unmatched"] == 0
    assert (
        "1 group(s) of 'Bezirke' have no features in 'Einwohner je Bezirk und "
        "Band': their rows hold 0 and a share of 0."
    ) in out["note"]


async def test_groups_with_no_features_are_added_only_where_0_is_their_value() -> None:
    """No row is made up for a mean (no features have no mean), in value
    order, with then_by (no band to give it), or for a denominator of 0;
    unmatched names are named beside them."""
    mean = await execute(
        GROUP_STATISTICS,
        _env(_services(rows=IN_REACH)),
        {**RANK_BY_SHARE, "operation": "mean"},
    )
    by_value = await execute(
        GROUP_STATISTICS,
        _env(_services(rows=IN_REACH)),
        {**RANK_BY_SHARE, "order_by": "value"},
    )
    assert [r["group"] for r in mean["rows"]] == ["Nord", "Mitte"]
    assert [r["group"] for r in by_value["rows"]] == ["Mitte", "Nord"]
    for out in (mean, by_value):
        assert "no features" not in (out.get("note") or "")
    bands = await execute(
        GROUP_STATISTICS,
        _env(_services(rows=IN_REACH)),
        {**RANK_BY_SHARE, "then_by": "band"},
    )
    assert [r["group"] for r in bands["rows"]] == ["Nord", "Mitte"]
    assert (
        "1 group(s) of 'Bezirke' have no features in 'Einwohner je Bezirk und "
        "Band', so a share of 0, but no row: then_by has no value for them."
    ) in bands["note"]
    rows = {
        BANDS: [_district("Mitte", 1200), _district("Nordx", 600)],
        DISTRICTS: [*IN_REACH[DISTRICTS], _district("Leer", 0)],
    }
    misspelt = await execute(
        GROUP_STATISTICS, _env(_services(rows=rows)), RANK_BY_SHARE
    )
    assert [r["group"] for r in misspelt["rows"]] == ["Mitte", "Sued", "Nord", "Nordx"]
    assert (
        "2 group(s) of 'Bezirke' have no features in 'Einwohner je Bezirk und "
        "Band': their rows hold 0 and a share of 0. Check their names against "
        "the 1 group(s) without a match first."
    ) in misspelt["note"]


async def test_groups_with_no_features_beyond_a_cut_list_are_not_ranked() -> None:
    """The other layer's groups tell which have no features: beyond its
    first 1000, the note says those are not ranked."""
    out = await execute(
        GROUP_STATISTICS,
        _env(_services(rows=IN_REACH, groups={DISTRICTS: 1500})),
        RANK_BY_SHARE,
    )
    assert [r["group"] for r in out["rows"]] == ["Nord", "Mitte", "Sued"]
    assert (
        "Groups with no features among the values of 'name' in 'Bezirke' beyond "
        "its first 1000 are not ranked."
    ) in out["note"]


async def test_a_ranking_beyond_the_groups_read_says_so() -> None:
    """Rows ranked by share are read with up to 1000 groups; with more, the
    note says the others are not ranked."""
    rows = {
        BANDS: [_district(f"D{n:04d}", 2000 - n) for n in range(1000)],
        DISTRICTS: [_district(f"D{n:04d}", 4000) for n in range(1000)],
    }
    out = await execute(
        GROUP_STATISTICS,
        _env(_services(rows=rows, groups={BANDS: 1200})),
        {**RANK_BY_SHARE, "limit": 1},
    )
    assert [r["group"] for r in out["rows"]] == ["D0000"]
    assert (
        "'Einwohner je Bezirk und Band' has more than 1000 groups: the ranking "
        "by share covers the 1000 with the largest values, not the others, nor "
        "the groups with no features."
    ) in out["note"]
    # A group missing from a cut list may lie beyond it: none is made up.
    assert "their rows hold 0" not in out["note"]
    complete = await execute(
        GROUP_STATISTICS, _env(_services(rows=RANKED)), RANK_BY_SHARE
    )
    assert "ranking" not in (complete.get("note") or "")


async def test_the_rows_ranked_by_share_stop_at_100() -> None:
    out = await execute(GROUP_STATISTICS, _env(_services(rows=RANKED)), RANK_BY_SHARE)
    assert len(out["rows"]) == 100 and out["rows"][0]["group"] == "Klein"


async def test_limit_keeps_the_first_rows_by_value() -> None:
    services = _services()
    out = await execute(
        GROUP_STATISTICS,
        _env(services),
        {
            "layer_project_id": 90,
            "operation": "sum",
            "field": "einwohner",
            "group_by": "name",
            "limit": 2,
        },
    )
    assert [r["group"] for r in out["rows"]] == ["Mitte", "Nord"]
    assert out["groups"] == 3
    [body] = services[2].bodies()
    assert body["inputs"]["limit"] == 2 and body["inputs"]["order"] == "descendent"


async def test_the_lowest_value_first_is_asked_of_processes() -> None:
    """By value, processes sorts: the lowest of more groups than are read
    only come from its own order."""
    services = _services()
    await execute(
        GROUP_STATISTICS,
        _env(services),
        {
            "layer_project_id": 90,
            "operation": "count",
            "group_by": "name",
            "lowest_first": True,
        },
    )
    [body] = services[2].bodies()
    assert body["inputs"]["order"] == "ascendent"


@pytest.mark.parametrize(
    ("limit", "bound"),
    [(0, "greater than or equal to 1"), (101, "less than or equal to 100")],
)
async def test_limit_is_bounded(limit: int, bound: str) -> None:
    with pytest.raises(InputInvalid, match=f"limit: Input should be {bound}"):
        await execute(
            GROUP_STATISTICS,
            _env(_services()),
            {
                "layer_project_id": 90,
                "operation": "count",
                "group_by": "name",
                "limit": limit,
            },
        )


async def test_order_by_share_needs_share_of() -> None:
    with pytest.raises(InputInvalid, match="order_by share needs share_of"):
        await execute(
            GROUP_STATISTICS,
            _env(_services()),
            {
                "layer_project_id": 90,
                "operation": "count",
                "group_by": "name",
                "order_by": "share",
            },
        )


async def test_restricted_withholds_a_ranking_by_share_and_limits_counts() -> None:
    """Restricted sends counts only: a ranking by share has a share_of and
    is withheld; a limit on counts keeps the masking of small groups."""
    ranked = await execute(
        GROUP_STATISTICS,
        _env(_services(rows=RANKED, groups={BANDS: 3}), "restricted"),
        {**RANK_BY_SHARE, "operation": "count", "field": None, "limit": 3},
    )
    assert set(ranked) == {"withheld", "reason"}
    counts = await execute(
        GROUP_STATISTICS,
        _env(_services(), "restricted"),
        {
            "layer_project_id": 90,
            "operation": "count",
            "group_by": "name",
            "limit": 2,
        },
    )
    assert [(r["group"], r.get("value")) for r in counts["rows"]] == [
        ("Mitte", 1200.0),
        ("Nord", 300.0),
    ]
    assert not {"denominator", "share", "note"} & _keys(counts)
    # The fake ignores the order: the rows as processes lists them, the
    # group under 5 masked as without a limit.
    lowest = await execute(
        GROUP_STATISTICS,
        _env(_services(), "restricted"),
        {
            "layer_project_id": 90,
            "operation": "count",
            "group_by": "name",
            "lowest_first": True,
            "limit": 3,
        },
    )
    assert [r.get("value") for r in lowest["rows"]] == [1200.0, 300.0, None]
    assert "fewer than 5" in lowest["note"]
