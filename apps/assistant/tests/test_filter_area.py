"""A layer filter's area as the model sets it (`assistant.maps.filter_area`):
the row operations set_area and clear_area, the area built from their
sources as the web's filter panel builds it (`goatlib.filter.areas`), and
the area in words for the model.

The land use layer of the map evals holds an active drawn area, an ordinary
row, a switched-off row and a custom row.
"""

import copy
import json
import math
import time
from pathlib import Path
from typing import Any

import pytest
from goatlib.filter.areas import (
    REGION_SOURCE,
    Feature,
    FeaturesPiece,
    ShapePiece,
    ViewPiece,
    add_feature,
    add_view,
    area_of,
    area_polygons,
    filter_fits,
    over_limits,
    point_count,
    polygons_of,
    read_area,
    round_polygons,
)
from goatlib.filter.limits import MAX_FEATURES, MAX_LENGTH, MAX_POINTS
from goatlib.filter.rows import Row, Rows, read_rows, write_rows
from pydantic import TypeAdapter, ValidationError

from assistant.maps.filter_area import (
    REPLACED_OFF,
    THIN_ABOVE,
    AreaSources,
    Outline,
    layer_labels,
    thinned,
)
from assistant.maps.filter_rows import (
    FilterBrief,
    FilterRowView,
    RowOp,
    apply_filter_ops,
    apply_row_ops,
    brief,
)
from assistant.tools.runtime import InputInvalid
from evals.map_fixture import LAND_USE_QUERY

FIELDS = {"use": "string", "area_m2": "number", "name": "string"}
DRAWN = LAND_USE_QUERY["cql"]["args"][0]
DRAWN_NOTES = LAND_USE_QUERY["ui"]["area"]
LAYER = "e3000000-0000-0000-0000-000000000031"
ROW_OPS: TypeAdapter[list[RowOp]] = TypeAdapter(list[RowOp])
FIXTURE = (
    Path(__file__).parents[3]
    / "packages/python/goatlib/tests/unit/filter/fixtures/filter_areas.json"
)


def ops(*items: dict[str, Any]) -> list[RowOp]:
    return ROW_OPS.validate_python(list(items))


def box(west: float, south: float, east: float, north: float) -> dict[str, Any]:
    ring = [[west, south], [east, south], [east, north], [west, north], [west, south]]
    return {"type": "Polygon", "coordinates": [ring]}


def wiggly(positions: int, *, lon: float = 12.4, lat: float = 51.35) -> dict[str, Any]:
    """A star-shaped ring of many positions that never crosses itself."""
    ring = []
    for i in range(positions - 1):
        angle = 2 * math.pi * i / (positions - 1)
        radius = 0.05 + 0.004 * math.sin(37 * angle) + 0.002 * math.sin(301 * angle)
        ring.append(
            [
                round(lon + radius * math.cos(angle), 7),
                round(lat + radius * math.sin(angle), 7),
            ]
        )
    ring.append(ring[0])
    return {"type": "Polygon", "coordinates": [ring]}


REGION_A = Outline(id="DEZ01", name="Region A", geometry=box(12.3, 51.3, 12.4, 51.4))
REGION_B = Outline(id="DEZ02", name="Region B", geometry=box(12.4, 51.3, 12.5, 51.4))
BOUNDS = (12.35, 51.32, 12.45, 51.38)


def regions(*outlines: Outline) -> AreaSources:
    return AreaSources(regions=outlines)


def stored(query: Any) -> Rows:
    return read_rows(query, FIELDS)


def land_use() -> dict[str, Any]:
    return copy.deepcopy(LAND_USE_QUERY)


# ---- the operations -------------------------------------------------------------


def test_set_area_needs_a_source() -> None:
    for given in ({}, {"view": False}, {"outside": True}, {"add": True}):
        with pytest.raises(ValidationError, match="at least one of regions"):
            ops({"do": "set_area", **given})
    with pytest.raises(ValidationError):
        ops({"do": "set_area", "view": True, "colour": "red"})
    with pytest.raises(ValidationError):
        ops({"do": "set_area", "features_of": {"layer_project_id": 31, "x": 1}})
    with pytest.raises(ValidationError):
        ops({"do": "set_area", "regions": ["not a region"]})
    with pytest.raises(ValidationError):
        ops({"do": "clear_area", "view": True})
    [op] = ops(
        {
            "do": "set_area",
            "regions": ["DE212"],
            "features_of": {
                "layer_project_id": 31,
                "filter": {"conditions": [{"field": "name", "op": "=", "value": "A"}]},
            },
            "view": True,
        }
    )
    assert op.do == "set_area"


def test_one_filter_operation_takes_one_area_operation() -> None:
    with pytest.raises(InputInvalid, match="at most one set_area or clear_area"):
        apply_filter_ops(
            None,
            ops({"do": "set_area", "view": True}, {"do": "clear_area"}),
            FIELDS,
            sources=AreaSources(bounds=BOUNDS),
        )


# ---- each source, and together ----------------------------------------------------


def _expected(pieces: Any, rows: Rows, *, outside: bool = False) -> Any:
    cql, notes = area_of(pieces, outside=outside)
    return write_rows(
        Rows(
            match=rows.match,
            rows=rows.rows,
            area=cql,
            area_notes=notes,
            metadata=rows.metadata,
        )
    )


def test_a_region_alone_is_written_as_the_panel_writes_it() -> None:
    change = apply_filter_ops(
        None,
        ops({"do": "set_area", "regions": ["DEZ01"]}),
        FIELDS,
        sources=regions(REGION_A),
    )
    added = add_feature(
        (),
        REGION_SOURCE,
        "DEZ01",
        REGION_A.geometry,
        name="Region A",
        fits=filter_fits(),
    )
    assert added is not None
    assert change.query == _expected(added.pieces, Rows(match="all", rows=()))
    assert change.said == []


def test_regions_features_and_the_view_together_are_one_area_in_that_order() -> None:
    feature = Outline(
        id="7", name="District 7", geometry=box(12.31, 51.31, 12.33, 51.33)
    )
    sources = AreaSources(
        regions=(REGION_A, REGION_B), layer=LAYER, features=(feature,), bounds=BOUNDS
    )
    change = apply_filter_ops(
        None,
        ops(
            {
                "do": "set_area",
                "regions": ["DEZ01", "DEZ02"],
                "features_of": {"layer_project_id": 31},
                "view": True,
            }
        ),
        FIELDS,
        sources=sources,
    )
    area = read_area(*_area(change.query))
    assert area is not None
    kinds = [type(piece) for piece in area.pieces]
    assert kinds == [FeaturesPiece, FeaturesPiece, ViewPiece]
    first, second, _ = area.pieces
    assert isinstance(first, FeaturesPiece) and first.source == REGION_SOURCE
    assert [f.id for f in first.features] == ["DEZ01", "DEZ02"]
    assert isinstance(second, FeaturesPiece) and second.source == LAYER
    assert second.features == (Feature(id="7", n=1, name="District 7"),)


def _area(query: Any) -> tuple[Any, Any]:
    rows = read_rows(query, FIELDS)
    return rows.area, rows.area_notes


def test_the_view_alone() -> None:
    change = apply_filter_ops(
        None,
        ops({"do": "set_area", "view": True}),
        FIELDS,
        sources=AreaSources(bounds=BOUNDS),
    )
    added = add_view((), BOUNDS, fits=filter_fits())
    assert added is not None
    assert change.query == _expected(added.pieces, Rows(match="all", rows=()))


def test_a_feature_without_a_polygon_is_left_out_as_the_panel_leaves_it() -> None:
    point = Outline(
        id="3", name="A point", geometry={"type": "Point", "coordinates": [12.3, 51.3]}
    )
    feature = Outline(id="4", name="Block", geometry=box(12.31, 51.31, 12.33, 51.33))
    change = apply_filter_ops(
        None,
        ops({"do": "set_area", "features_of": {"layer_project_id": 31}}),
        FIELDS,
        sources=AreaSources(layer=LAYER, features=(point, feature)),
    )
    area = read_area(*_area(change.query))
    assert area is not None
    [piece] = area.pieces
    assert isinstance(piece, FeaturesPiece) and [f.id for f in piece.features] == ["4"]
    assert any(
        "1 feature without a polygon outline was left out" in s for s in change.said
    )
    with pytest.raises(
        InputInvalid, match="None of the features has a polygon outline"
    ):
        apply_filter_ops(
            None,
            ops({"do": "set_area", "features_of": {"layer_project_id": 31}}),
            FIELDS,
            sources=AreaSources(layer=LAYER, features=(point,)),
        )


# ---- the area there is ------------------------------------------------------------


def test_add_false_makes_the_area_exactly_the_new_pieces_and_keeps_the_rows() -> None:
    before = stored(LAND_USE_QUERY)
    change = apply_filter_ops(
        land_use(),
        ops({"do": "set_area", "regions": ["DEZ01"]}),
        FIELDS,
        sources=regions(REGION_A),
    )
    after = stored(change.query)
    assert after.rows == before.rows
    area = read_area(after.area, after.area_notes)
    assert area is not None
    assert [type(piece) for piece in area.pieces] == [FeaturesPiece]


def test_add_true_keeps_the_drawn_shape_and_adds_the_new_pieces() -> None:
    change = apply_filter_ops(
        land_use(),
        ops({"do": "set_area", "regions": ["DEZ01"], "add": True}),
        FIELDS,
        sources=regions(REGION_A),
    )
    after = stored(change.query)
    area = read_area(after.area, after.area_notes)
    assert area is not None
    shape, region = area.pieces
    assert isinstance(shape, ShapePiece) and shape.label == "Study area"
    assert shape.polygons == read_area(DRAWN, DRAWN_NOTES).pieces[0].polygons  # type: ignore[union-attr]
    assert isinstance(region, FeaturesPiece)
    assert after.rows == stored(LAND_USE_QUERY).rows
    assert brief(change.query, FIELDS).area == (  # type: ignore[union-attr]
        'a drawn shape "Study area"; regions: "Region A" (DEZ01)'
    )


def test_outside_keeps_what_lies_outside_and_add_keeps_the_areas_side() -> None:
    change = apply_filter_ops(
        None,
        ops({"do": "set_area", "regions": ["DEZ01"], "outside": True}),
        FIELDS,
        sources=regions(REGION_A),
    )
    rows = stored(change.query)
    assert rows.area["op"] == "not"
    assert brief(change.query, FIELDS).area == 'outside: regions: "Region A" (DEZ01)'  # type: ignore[union-attr]
    added = apply_filter_ops(
        change.query,
        ops({"do": "set_area", "regions": ["DEZ02"], "add": True}),
        FIELDS,
        sources=regions(REGION_B),
    )
    assert stored(added.query).area["op"] == "not"
    replaced = apply_filter_ops(
        change.query,
        ops({"do": "set_area", "regions": ["DEZ02"]}),
        FIELDS,
        sources=regions(REGION_B),
    )
    assert stored(replaced.query).area["op"] == "s_intersects"


def test_clear_area_removes_the_area_and_keeps_the_rows() -> None:
    before = stored(LAND_USE_QUERY)
    change = apply_filter_ops(land_use(), ops({"do": "clear_area"}), FIELDS)
    after = stored(change.query)
    assert after.area is None and after.area_notes is None
    assert after.rows == before.rows and after.match == before.match
    # Without an area there is nothing to clear, and nothing changes.
    plain = {
        "cql": {
            "op": "and",
            "args": [{"op": ">", "args": [{"property": "area_m2"}, 5]}],
        }
    }
    assert (
        apply_filter_ops(copy.deepcopy(plain), ops({"do": "clear_area"}), FIELDS).query
        == plain
    )
    assert apply_filter_ops(None, ops({"do": "clear_area"}), FIELDS).query is None
    # The rows' clear keeps the area, and clear_area beside it leaves nothing.
    assert (
        apply_filter_ops(
            land_use(), ops({"do": "clear"}, {"do": "clear_area"}), FIELDS
        ).query
        is None
    )


def test_adding_to_a_switched_off_area_keeps_it_off_and_replacing_it_switches_on() -> (
    None
):
    """As the Filter tab: adding to a switched-off area keeps it switched off;
    an area that replaces it is switched on, and the result says so."""
    off = {"ui": {"v": 1, "area": {**DRAWN_NOTES, "off": DRAWN}}}
    assert brief(off, FIELDS).area == 'switched off: a drawn shape "Study area"'  # type: ignore[union-attr]
    kept = apply_filter_ops(
        copy.deepcopy(off),
        ops({"do": "set_area", "regions": ["DEZ01"], "add": True}),
        FIELDS,
        sources=regions(REGION_A),
    )
    rows = stored(kept.query)
    assert rows.area_notes["off"] == rows.area
    assert "cql" not in kept.query  # type: ignore[operator]
    area = read_area(rows.area, rows.area_notes, enabled=False)
    assert area is not None and [type(p) for p in area.pieces] == [
        ShapePiece,
        FeaturesPiece,
    ]
    assert brief(kept.query, FIELDS).area.startswith("switched off: ")  # type: ignore[union-attr]
    assert not any("switched off" in said for said in kept.said)
    replaced = apply_filter_ops(
        copy.deepcopy(off),
        ops({"do": "set_area", "regions": ["DEZ01"]}),
        FIELDS,
        sources=regions(REGION_A),
    )
    rows = stored(replaced.query)
    assert "off" not in rows.area_notes
    assert replaced.query["cql"]["args"] == [rows.area]  # type: ignore[index]
    area = read_area(*_area(replaced.query))
    assert area is not None and [type(p) for p in area.pieces] == [FeaturesPiece]
    assert REPLACED_OFF in replaced.said
    # clear_area also removes a switched-off area.
    assert (
        apply_filter_ops(copy.deepcopy(off), ops({"do": "clear_area"}), FIELDS).query
        is None
    )


def test_row_operations_of_the_same_call_count_for_the_limits() -> None:
    """The area is fitted beside the rows the call leaves: a row added in the
    same call takes room the outline then does not get."""
    long_value = "x" * 2000
    many = [
        {"field": "name", "op": "!=", "value": f"{long_value}{n}"} for n in range(10)
    ]
    detailed = Outline(id="DEZ03", name="Region C", geometry=wiggly(1800))
    alone = apply_filter_ops(
        None,
        ops({"do": "set_area", "regions": ["DEZ03"]}),
        FIELDS,
        sources=regions(detailed),
    )
    beside = apply_filter_ops(
        None,
        ops(
            {"do": "add", "conditions": many}, {"do": "set_area", "regions": ["DEZ03"]}
        ),
        FIELDS,
        sources=regions(detailed),
    )
    assert alone.said == []
    assert len(beside.said) == 1
    assert beside.said[0].startswith(
        'The outline of the region "Region C" was simplified to fit the filter\'s size limit; it moved by up to '
    )
    assert beside.said[0].endswith(" m.")
    points = sum(len(r) for r in stored(beside.query).area["args"][1]["coordinates"])
    assert points < 1800


def test_simplification_says_how_far_the_outline_moved() -> None:
    detailed = Outline(id="DEZ03", name="Region C", geometry=wiggly(5000))
    change = apply_filter_ops(
        None,
        ops({"do": "set_area", "regions": ["DEZ03"]}),
        FIELDS,
        sources=regions(detailed),
    )
    added = add_feature(
        (),
        REGION_SOURCE,
        "DEZ03",
        detailed.geometry,
        name="Region C",
        fits=filter_fits(),
    )
    assert added is not None and added.kept < added.points
    assert change.query == _expected(added.pieces, Rows(match="all", rows=()))
    [said] = change.said
    assert said == (
        'The outline of the region "Region C" was simplified to fit the filter\'s '
        f"size limit; it moved by up to {max(1, round(added.shift))} m."
    )


def test_an_area_over_the_length_beside_long_rows_is_refused() -> None:
    """Rows that leave the area no room: even four positions per ring do not
    fit, and the operation is refused with the limit's sentence."""
    long_value = "x" * 5800
    many = [
        {"field": "name", "op": "!=", "value": f"{long_value}{n}"} for n in range(10)
    ]
    with pytest.raises(InputInvalid) as raised:
        apply_filter_ops(
            None,
            ops(
                {"do": "add", "conditions": many},
                {"do": "set_area", "regions": ["DEZ01"]},
            ),
            FIELDS,
            sources=regions(REGION_A),
        )
    assert "Row operation 2:" in raised.value.message
    assert "does not fit" in raised.value.message


def test_more_than_the_features_an_area_takes_is_refused() -> None:
    features = tuple(
        Outline(id=str(n), name=f"F{n}", geometry=box(12.3, 51.3, 12.3001, 51.3001))
        for n in range(MAX_FEATURES + 1)
    )
    with pytest.raises(InputInvalid, match=f"at most {MAX_FEATURES} features"):
        apply_filter_ops(
            None,
            ops({"do": "set_area", "features_of": {"layer_project_id": 31}}),
            FIELDS,
            sources=AreaSources(layer=LAYER, features=features),
        )


# ---- thinning ----------------------------------------------------------------------


def test_thinning_keeps_every_kth_position_and_closes_each_ring() -> None:
    small = wiggly(THIN_ABOVE)
    assert thinned(small) is small
    big = wiggly(THIN_ABOVE * 3 + 1)
    [ring] = thinned(big)["coordinates"]
    original = big["coordinates"][0]
    assert ring[0] == original[0] and ring[-1] == original[-1]
    assert len(ring) <= THIN_ABOVE + 1
    positions = {tuple(position) for position in original}
    assert all(tuple(position) in positions for position in ring)
    # A small ring beside a big one keeps at least four positions.
    multi = {
        "type": "MultiPolygon",
        "coordinates": [big["coordinates"], box(12.0, 51.0, 12.1, 51.1)["coordinates"]],
    }
    big_ring, small_ring = (polygon[0] for polygon in thinned(multi)["coordinates"])
    assert len(small_ring) == 5
    assert len(big_ring) < len(original)
    # Anything else is passed on for the outline check to refuse.
    assert thinned({"type": "Point", "coordinates": [1, 2]}) == {
        "type": "Point",
        "coordinates": [1, 2],
    }


def test_a_very_detailed_outline_is_built_fast() -> None:
    detailed = Outline(id="DEZ04", name="Region D", geometry=wiggly(200_000))
    started = time.monotonic()
    change = apply_filter_ops(
        None,
        ops({"do": "set_area", "regions": ["DEZ04"]}),
        FIELDS,
        sources=regions(detailed),
    )
    assert time.monotonic() - started < 20
    assert change.said and "simplified" in change.said[0]


# ---- what is written ----------------------------------------------------------------


@pytest.mark.parametrize("name", ["region_simplified", "outside", "two_regions"])
def test_a_fixture_case_is_stored_as_the_panels_bytes(name: str) -> None:
    [case] = [c for c in json.loads(FIXTURE.read_text()) if c["name"] == name]
    [piece] = case["pieces"]
    # Region ids as catalog_find_region gives them; the notes name them so.
    ids = {f["id"]: f"DEZ{n}" for n, f in enumerate(piece["features"], start=10)}
    outlines = tuple(
        Outline(id=ids[f["id"]], name=f.get("name"), geometry=f["geometry"])
        for f in piece["features"]
    )
    change = apply_filter_ops(
        None,
        ops(
            {
                "do": "set_area",
                "regions": list(ids.values()),
                "outside": case["outside"],
            }
        ),
        FIELDS,
        sources=regions(*outlines),
    )
    notes = copy.deepcopy(case["expected"]["notes"])
    for feature in notes["pieces"][0]["features"]:
        feature["id"] = ids[feature["id"]]
    expected = {
        "cql": {"op": "and", "args": [case["expected"]["cql"]]},
        "ui": {"v": 1, "area": notes},
    }
    assert json.dumps(change.query) == json.dumps(expected)


def test_the_row_operations_alone_still_write_the_same() -> None:
    query = land_use()
    assert (
        apply_row_ops(query, ops({"do": "set_match", "match": "all"}), FIELDS)
        == apply_filter_ops(
            land_use(), ops({"do": "set_match", "match": "all"}), FIELDS
        ).query
    )


# ---- in words -------------------------------------------------------------------


def test_the_brief_says_the_area_in_words_with_the_layer_named() -> None:
    assert brief(LAND_USE_QUERY, FIELDS) == FilterBrief(
        match="all",
        rows=[
            FilterRowView(row=1, text="area_m2 is greater than 5000"),
            FilterRowView(row=2, text='use is "industrial"', on=False),
            FilterRowView(row=3, text="custom"),
        ],
        area='a drawn shape "Study area"',
    )
    feature = Outline(
        id="7", name="District 7", geometry=box(12.31, 51.31, 12.33, 51.33)
    )
    change = apply_filter_ops(
        None,
        ops({"do": "set_area", "features_of": {"layer_project_id": 31}}),
        FIELDS,
        sources=AreaSources(layer=LAYER, features=(feature,)),
    )
    labels = layer_labels(
        {
            31: {"layer_id": LAYER, "name": "Districts"},
            35: {"layer_id": LAYER, "name": "Copy"},
        }
    )
    assert labels == {LAYER: 'layer "Districts" (31)'}
    worded = brief(change.query, FIELDS, layers=labels)
    assert worded is not None and worded.area == 'features of layer "Districts" (31): 1'
    unnamed = brief(change.query, FIELDS)
    assert unnamed is not None and unnamed.area == "features of another layer: 1"
    assert LAYER not in json.dumps(unnamed.model_dump())
    assert (
        brief({"cql": {"op": ">", "args": [{"property": "area_m2"}, 1]}}, FIELDS).area
        is None
    )  # type: ignore[union-attr]


def test_written_rows_and_the_area_compare_with_goatlib() -> None:
    """The stored query is what `area_of` and `write_rows` give for the same
    pieces beside the rows the call leaves."""
    change = apply_filter_ops(
        land_use(),
        ops(
            {"do": "add", "conditions": [{"field": "use", "op": "=", "value": "park"}]},
            {"do": "set_area", "view": True},
        ),
        FIELDS,
        sources=AreaSources(bounds=BOUNDS),
    )
    before = stored(LAND_USE_QUERY)
    rows = Rows(
        match="all",
        rows=(
            *before.rows,
            Row(cql={"op": "=", "args": [{"property": "use"}, "park"]}),
        ),
    )
    added = add_view((), BOUNDS, fits=filter_fits(rows))
    assert added is not None
    assert change.query == _expected(added.pieces, rows)
    assert MAX_LENGTH > 0


def test_small_outlines_go_first_so_only_the_detailed_one_is_simplified() -> None:
    detailed = Outline(id="DEZ03", name="Region C", geometry=wiggly(3000))
    change = apply_filter_ops(
        None,
        ops({"do": "set_area", "regions": ["DEZ03", "DEZ01"]}),
        FIELDS,
        sources=regions(detailed, REGION_A),
    )
    area = read_area(*_area(change.query))
    assert area is not None
    [piece] = area.pieces
    assert [f.id for f in piece.features] == ["DEZ01", "DEZ03"]  # type: ignore[union-attr]
    [said] = change.said
    assert said.startswith('The outline of the region "Region C" was simplified')


def state_sized(lon: float, lat: float, positions: int = 2800) -> dict[str, Any]:
    """A ring the size of a federal state's outline in the catalog: about
    2,800 positions written with every digit, about 114,000 characters."""
    ring = []
    for i in range(positions - 1):
        angle = 2 * math.pi * i / (positions - 1)
        radius = 0.8 + 0.05 * math.sin(41 * angle) + 0.02 * math.sin(397 * angle)
        ring.append(
            [lon + 1.4 * radius * math.cos(angle), lat + radius * math.sin(angle)]
        )
    ring.append(ring[0])
    return {"type": "Polygon", "coordinates": [ring]}


def _pieces_of(query: Any) -> tuple[Any, ...]:
    area = read_area(*_area(query))
    assert area is not None
    return area.pieces


def test_two_outlines_that_each_fill_the_length_share_the_room() -> None:
    """Two outlines of a federal state's size: either alone takes more than
    the whole length a filter may have. Both end up in the area, each
    simplified to its share, and the note names both."""
    first = Outline(id="DEZ05", name="State A", geometry=state_sized(10.0, 50.0))
    second = Outline(id="DEZ06", name="State B", geometry=state_sized(13.0, 52.0))
    assert 100_000 < len(json.dumps(first.geometry)) < 130_000
    alone = add_feature((), REGION_SOURCE, "DEZ05", first.geometry, fits=filter_fits())
    assert alone is not None and alone.kept < alone.points
    change = apply_filter_ops(
        None,
        ops({"do": "set_area", "regions": ["DEZ05", "DEZ06"]}),
        FIELDS,
        sources=regions(first, second),
    )
    [piece] = _pieces_of(change.query)
    assert [f.id for f in piece.features] == ["DEZ05", "DEZ06"]
    rows = stored(change.query)
    assert over_limits(_pieces_of(change.query), Rows("all", ())) == []
    assert rows.area is not None
    [said] = change.said
    assert said.startswith(
        'The outlines of the region "State A" and the region "State B" were '
        "simplified to fit the filter's size limit; they moved by up to "
    )
    assert said.endswith(" m.")
    # Each got about half: neither keeps much more than the other.
    first_kept, second_kept = (len(p[0]) for p in piece.polygons)
    assert abs(first_kept - second_kept) < 0.2 * max(first_kept, second_kept)


def test_three_large_outlines_all_fit() -> None:
    outlines = tuple(
        Outline(
            id=f"DEZ1{n}",
            name=f"Region {n}",
            geometry=state_sized(8.0 + 3 * n, 50.0, 1300),
        )
        for n in range(3)
    )
    change = apply_filter_ops(
        None,
        ops({"do": "set_area", "regions": [o.id for o in outlines]}),
        FIELDS,
        sources=regions(*outlines),
    )
    [piece] = _pieces_of(change.query)
    assert len(piece.features) == 3
    [said] = change.said
    assert said.startswith(
        'The outlines of the region "Region 0", the region "Region 1" and the '
        'region "Region 2" were simplified'
    )


def test_a_small_outline_beside_a_large_one_stays_untouched() -> None:
    large = Outline(id="DEZ05", name="State A", geometry=state_sized(10.0, 50.0))
    change = apply_filter_ops(
        None,
        ops({"do": "set_area", "regions": ["DEZ05", "DEZ01"]}),
        FIELDS,
        sources=regions(large, REGION_A),
    )
    [piece] = _pieces_of(change.query)
    small = dict(zip((f.id for f in piece.features), piece.polygons, strict=True))
    assert small["DEZ01"] == round_polygons(polygons_of(REGION_A.geometry))[0]
    [said] = change.said
    assert said.startswith('The outline of the region "State A" was simplified')


def test_outlines_that_cannot_fit_even_with_fair_shares_are_refused() -> None:
    """Fifty regions of eleven polygons: every ring keeps at least four
    positions, so together they need 2,200 points, more than an area takes."""
    islands = {
        "type": "MultiPolygon",
        "coordinates": [
            box(12.0 + 0.01 * k, 51.0, 12.005 + 0.01 * k, 51.005)["coordinates"]
            for k in range(11)
        ],
    }
    outlines = tuple(
        Outline(id=f"DE{n:03d}", name=f"Island {n}", geometry=islands)
        for n in range(50)
    )
    with pytest.raises(InputInvalid) as raised:
        apply_filter_ops(
            None,
            ops({"do": "set_area", "regions": [o.id for o in outlines]}),
            FIELDS,
            sources=regions(*outlines),
        )
    assert raised.value.message == (
        "Row operation 1: The 50 outlines asked for do not fit the filter's size "
        "limit together, also not each simplified to an equal share of it. Ask "
        "for fewer of them, or for larger units (a region one level up)."
    )


def test_a_thinned_outline_is_said_without_a_distance() -> None:
    huge = Outline(id="DEZ07", name="Region H", geometry=wiggly(THIN_ABOVE * 2))
    change = apply_filter_ops(
        None,
        ops({"do": "set_area", "regions": ["DEZ07"]}),
        FIELDS,
        sources=regions(huge),
    )
    assert change.said == [
        'The outline of the region "Region H" is very detailed and was '
        "simplified strongly to fit the filter's size limit."
    ]


def test_two_federal_states_in_one_call_stay_inside_the_limits() -> None:
    first = Outline(id="DEZ05", name="State A", geometry=state_sized(10.0, 50.0))
    second = Outline(id="DEZ06", name="State B", geometry=state_sized(13.0, 52.0))
    change = apply_filter_ops(
        None,
        ops({"do": "set_area", "regions": ["DEZ06", "DEZ05"]}),
        FIELDS,
        sources=regions(second, first),
    )
    pieces = _pieces_of(change.query)
    assert over_limits(pieces, Rows("all", ())) == []
    assert point_count(area_polygons(pieces)) <= MAX_POINTS
