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
