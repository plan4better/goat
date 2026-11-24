"""A filter's area from its pieces (`goatlib.filter.areas`).

`fixtures/filter_areas.json` is shared with the web's tests: each case lists
the `pieces` added in order (picked features with their GeoJSON outline, or
the map view's bounds), whether the area keeps what lies `outside`, the area's
CQL node and `ui.area` notes the filter panel writes for them (`expected`, the
web's own output), what the panel simplified on the way (`simplified`, one
entry per outline that did not fit as it was) and the `summary` this module
gives of the stored area.
"""

import json
import math
import subprocess
import sys
from typing import Any

import pytest
from goatlib.filter import areas
from goatlib.filter.areas import (
    REGION_SOURCE,
    Feature,
    FeaturesPiece,
    ShapePiece,
    ViewPiece,
    add,
    add_feature,
    add_view,
    area_of,
    area_sum,
    area_summary,
    filter_fits,
    over_limits,
    polygons_of,
    read_area,
    round_polygons,
    simplify_to_fit,
    view_polygon,
    with_feature,
)
from goatlib.filter.limits import MAX_FEATURES, MAX_POINTS, MAX_SHAPES
from goatlib.filter.rows import Row, Rows, read_rows, write_rows

from .conftest import FIXTURES

CASES: list[dict[str, Any]] = json.loads((FIXTURES / "filter_areas.json").read_text())
NAMES = [c["name"] for c in CASES]


def pieces_from(case: dict[str, Any]) -> tuple[tuple[Any, ...], list[dict[str, Any]]]:
    """The case's pieces added one by one as the panel adds them, and what was
    simplified on the way."""
    pieces: tuple[Any, ...] = ()
    simplified = []
    fits = filter_fits()
    for given in case["pieces"]:
        steps = (
            [lambda p: add_view(p, given["bounds"], fits=fits)]
            if given["kind"] == "view"
            else [
                lambda p, f=f: add_feature(
                    p,
                    given["source"],
                    f["id"],
                    f["geometry"],
                    name=f.get("name"),
                    fits=fits,
                )
                for f in given["features"]
            ]
        )
        for step in steps:
            added = step(pieces)
            assert added is not None
            pieces = added.pieces
            if added.kept != added.points:
                simplified.append(
                    {"points": added.points, "kept": added.kept, "shift": added.shift}
                )
    return pieces, simplified


def _square(x: float, y: float, w: float = 0.01) -> list[list[float]]:
    return [[x, y], [x + w, y], [x + w, y + w], [x, y + w], [x, y]]


def _ring(count: int, cx: float = 11.0, cy: float = 48.0) -> list[list[float]]:
    ring = [
        [
            round(cx + 0.1 * math.cos(2 * math.pi * i / (count - 1)), 6),
            round(cy + 0.1 * math.sin(2 * math.pi * i / (count - 1)), 6),
        ]
        for i in range(count - 1)
    ]
    return [*ring, ring[0]]


def _region(*polygons: Any) -> FeaturesPiece:
    return FeaturesPiece(
        source=REGION_SOURCE,
        features=(Feature(id="R1", name="Region A", n=len(polygons)),),
        polygons=round_polygons(polygons),
    )


# The shared cases.


def test_fixture_holds_the_cases_the_brief_asks_for():
    assert len(CASES) >= 10
    assert any(c["outside"] for c in CASES)
    assert any("simplified" in c for c in CASES)


@pytest.mark.parametrize("case", CASES, ids=NAMES)
def test_area_is_what_the_panel_writes(case):
    pieces, simplified = pieces_from(case)
    cql, notes = area_of(pieces, outside=case["outside"])
    assert {"cql": cql, "notes": notes} == case["expected"]
    # The stored text too: whole numbers without a fraction, keys in the web's order.
    assert json.dumps({"cql": cql, "notes": notes}) == json.dumps(case["expected"])
    assert simplified == case.get("simplified", [])


@pytest.mark.parametrize("case", CASES, ids=NAMES)
def test_reading_the_area_gives_its_pieces(case):
    pieces, _ = pieces_from(case)
    expected = case["expected"]
    area = read_area(expected["cql"], expected["notes"])
    assert area is not None
    assert area.pieces == pieces
    assert area.outside is case["outside"]
    assert area.enabled is True
    assert area.property == "geom"


@pytest.mark.parametrize("case", CASES, ids=NAMES)
def test_summary(case):
    expected = case["expected"]
    assert area_summary(expected["notes"], expected["cql"]) == case["summary"]


@pytest.mark.parametrize("case", CASES, ids=NAMES)
def test_fixture_areas_are_within_the_limits(case):
    pieces, _ = pieces_from(case)
    assert over_limits(pieces) == []


@pytest.mark.parametrize("case", CASES, ids=NAMES)
def test_rows_store_and_read_the_area_unchanged(case):
    cql, notes = case["expected"]["cql"], case["expected"]["notes"]
    query = write_rows(Rows(match="all", rows=(), area=cql, area_notes=notes))
    # As the panel saves an area alone: first (and only) under `and`.
    assert query == {"cql": {"op": "and", "args": [cql]}, "ui": {"v": 1, "area": notes}}
    back = read_rows(query, None)
    assert back.area == cql
    assert back.area_notes == notes
    assert read_area(back.area, back.area_notes).pieces == pieces_from(case)[0]


# Outlines.


def test_polygons_of_polygon_multipolygon_and_envelope():
    ring = _square(10, 48)
    assert polygons_of({"type": "Polygon", "coordinates": [ring]}) == (
        (tuple(tuple(p) for p in ring),),
    )
    multi = polygons_of({"type": "MultiPolygon", "coordinates": [[ring], [ring, ring]]})
    assert [len(p) for p in multi] == [1, 2]
    assert polygons_of({"bbox": [1, 2, 3, 4]}) == (
        (((1, 2), (1, 4), (3, 4), (3, 2), (1, 2)),),
    )
    assert polygons_of({"bbox": [1, 2, 0, 3, 4, 9]})[0][0][2] == (3, 4)


@pytest.mark.parametrize(
    "geometry",
    [
        None,
        "Polygon",
        [],
        {"type": "Point", "coordinates": [1, 2]},
        {"type": "LineString", "coordinates": [[1, 2], [3, 4]]},
        {"type": "Polygon", "coordinates": []},
        {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [0, 0]]]},
        {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, True], [0, 0]]]},
        {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, math.nan], [0, 0]]]},
        {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, "1"], [0, 0]]]},
        {"type": "Polygon", "coordinates": [[[0, 0], [1], [1, 1], [0, 0]]]},
        {"type": "MultiPolygon", "coordinates": []},
        {"type": "MultiPolygon", "coordinates": [[[[0, 0], [1, 0], [0, 0]]]]},
        {"type": "GeometryCollection", "geometries": []},
        {"bbox": [1, 2, 3]},
        {"bbox": [1, 2, 3, 4], "type": "Polygon"},
    ],
)
def test_polygons_of_refuses_anything_else(geometry):
    with pytest.raises(ValueError, match=r"\.$"):
        polygons_of(geometry)


def test_rounding_keeps_six_decimals_and_rounds_ties_up():
    [[ring]] = round_polygons([[[[10.0000005, -0.0000004], [-10.0000005, 1e-7]]]])
    assert ring == ((10.000001, 0), (-10, 0))
    assert all(isinstance(v, int) for v in ring[1])


def test_view_polygon_is_held_to_the_world():
    assert view_polygon((-200, -95.5, 10.1234564, 91)) == (
        ((-180, -90), (10.123456, -90), (10.123456, 90), (-180, 90), (-180, -90)),
    )


def test_area_sum_is_the_web_sum_of_the_stored_text():
    # Whole numbers as integers, small ones without an exponent below 1e-6:
    # JSON.stringify's text, not Python's.
    assert area_sum([[[[1.0, 0.000001], [1e-7, -0.0]]]]) == area_sum(
        json.loads("[[[[1, 0.000001], [1e-7, 0]]]]")
    )


@pytest.mark.parametrize(
    ("value", "text"),
    [
        (0.0, "0"),
        (-0.0, "0"),
        (12.0, "12"),
        (12, "12"),
        (-1.5, "-1.5"),
        (0.000001, "0.000001"),
        (0.0000012, "0.0000012"),
        (1e-7, "1e-7"),
        (-2.5e-8, "-2.5e-8"),
        (1e20, "100000000000000000000"),
        (1e21, "1e+21"),
        (1.2345e22, "1.2345e+22"),
        (123456.789, "123456.789"),
        (5e-324, "5e-324"),
        (10.299999999999999, "10.299999999999999"),
        (math.inf, "null"),
        (math.nan, "null"),
    ],
)
def test_numbers_are_written_as_javascript_writes_them(value, text):
    assert areas._js_number(value) == text


def test_simplify_to_fit_refuses_what_never_fits():
    polygons = round_polygons([[_ring(50)]])
    assert simplify_to_fit(polygons, lambda _: False) is None
    region = with_feature((), REGION_SOURCE, Feature(id="R1", n=1), polygons)
    assert add(polygons, lambda p: region, lambda _: False) is None


def test_simplify_to_fit_keeps_every_ring_with_four_positions():
    polygons = round_polygons([[_ring(50), _ring(30, 11.0, 48.0)], [_ring(12, 12.0)]])
    simplified = simplify_to_fit(
        polygons, lambda p: sum(len(r) for q in p for r in q) <= 12
    )
    assert simplified is not None
    assert [[len(r) for r in q] for q in simplified.polygons] == [[4, 4], [4]]
    assert simplified.shift > 0


def test_an_outline_too_big_even_simplified_is_refused():
    # Each polygon keeps four positions at least: 600 of them stay above the limit.
    geometry = {
        "type": "MultiPolygon",
        "coordinates": [[_square(10 + i * 0.02, 48)] for i in range(600)],
    }
    assert add_feature((), REGION_SOURCE, "R1", geometry, fits=filter_fits()) is None


def test_with_feature_keeps_a_feature_once():
    polygons = round_polygons([[_square(10, 48)]])
    once = with_feature((), REGION_SOURCE, Feature(id="R1", n=1), polygons)
    assert with_feature(once, REGION_SOURCE, Feature(id="R1", n=1), polygons) == once
    twice = with_feature(once, REGION_SOURCE, Feature(id="R2", n=1), polygons)
    assert len(twice) == 1 and [f.id for f in twice[0].features] == ["R1", "R2"]


def test_a_new_map_view_takes_the_old_ones_place():
    fits = filter_fits()
    pieces = add_view((), (10, 48, 11, 49), fits=fits).pieces
    pieces = add_feature(
        pieces,
        REGION_SOURCE,
        "R1",
        {"type": "Polygon", "coordinates": [_square(10, 48)]},
        fits=fits,
    ).pieces
    pieces = add_view(pieces, (12, 48, 13, 49), fits=fits).pieces
    assert [type(p) for p in pieces] == [ViewPiece, FeaturesPiece]
    assert pieces[0].polygons[0][0][0] == (12, 48)


def test_fits_counts_the_rows_beside_the_area():
    ring = round_polygons([[_ring(1900, -120.123456, -45.123456)]])
    piece = FeaturesPiece(source="x", features=(Feature(id="1", n=1),), polygons=ring)
    assert (
        filter_fits()((piece,)) is False
    )  # the URL is longer than a map request takes
    small = round_polygons([[_ring(1000, -120.123456, -45.123456)]])
    piece = FeaturesPiece(source="x", features=(Feature(id="1", n=1),), polygons=small)
    assert filter_fits()((piece,)) is True
    long_value = {"op": "=", "args": [{"property": "name"}, "x" * 40_000]}
    rows = Rows(match="all", rows=(Row(cql=long_value),))
    assert filter_fits(rows)((piece,)) is False


def test_area_of_nothing_is_nothing():
    assert area_of(()) == (None, None)
    assert area_of((ViewPiece(polygons=()),)) == (None, None)


def test_area_of_another_field_and_a_shape():
    shape = ShapePiece(
        polygons=round_polygons([[_square(10, 48)]]),
        shape="circle",
        label="Site",
        center=(10.005, 48.005),
        km=0.5,
    )
    cql, notes = area_of((shape,), property="footprint")
    assert cql["args"][0] == {"property": "footprint"}
    assert notes["pieces"] == [
        {
            "kind": "shape",
            "n": 1,
            "shape": "circle",
            "label": "Site",
            "center": [10.005, 48.005],
            "km": 0.5,
        }
    ]
    area = read_area(cql, notes)
    assert area.pieces == (shape,)
    assert area.property == "footprint"


# Limits.


def test_over_limits_shapes():
    shape = ShapePiece(polygons=round_polygons([[_square(10, 48)]]))
    assert over_limits((shape,) * MAX_SHAPES) == []
    [message] = over_limits((shape,) * (MAX_SHAPES + 1))
    assert f"at most {MAX_SHAPES} drawn shapes" in message


def test_over_limits_features():
    polygons = round_polygons([[_square(10, 48)]])
    features = tuple(Feature(id=str(i), n=0) for i in range(MAX_FEATURES + 1))
    piece = FeaturesPiece(source=REGION_SOURCE, features=features, polygons=polygons)
    [message] = over_limits((piece,))
    assert f"at most {MAX_FEATURES} features" in message
    assert str(MAX_FEATURES + 1) in message


def test_over_limits_points():
    piece = _region([_ring(MAX_POINTS + 1)])
    messages = over_limits((piece,))
    assert any(f"at most {MAX_POINTS} points" in m for m in messages)
    assert all("points" not in m for m in over_limits((_region([_ring(MAX_POINTS)]),)))


def test_over_limits_points_count_every_piece_together():
    half = MAX_POINTS // 2 + 1
    pieces = (_region([_ring(half)]), _region([_ring(half, 12.0)]))
    assert any("points" in m for m in over_limits(pieces))


def test_over_limits_length():
    piece = _region([_ring(1900, -120.123456, -45.123456)])
    messages = over_limits((piece,))
    assert [m for m in messages if "characters" in m]
    assert all("points" not in m for m in messages)


def test_over_limits_sentences():
    shape = ShapePiece(polygons=round_polygons([[_square(10, 48)]]))
    for message in over_limits((shape,) * (MAX_SHAPES + 1)):
        assert message[0].isupper() and message.endswith(".")


# Summaries.


def test_summary_names_layers_the_caller_knows():
    notes = {
        "pieces": [
            {"kind": "features", "source": "L1", "features": [{"id": "1", "n": 1}] * 3},
        ],
        "sum": "00000000",
    }
    assert area_summary(notes, layers={"L1": "layer 31"}) == "features of layer 31: 3"
    assert area_summary(notes) == "features of another layer: 3"


def test_summary_of_a_switched_off_area():
    case = next(c for c in CASES if c["name"] == "outside")
    notes = {**case["expected"]["notes"], "off": case["expected"]["cql"]}
    assert area_summary(notes) == 'switched off, outside: regions: "Region A" (R1)'


def test_summary_of_shapes():
    notes = {
        "pieces": [
            {"kind": "shape", "n": 1, "shape": "polygon"},
            {"kind": "shape", "n": 1, "shape": "circle", "center": [10, 48], "km": 2.5},
            {"kind": "shape", "n": 1, "label": "Site"},
            {"kind": "view", "n": 1},
        ],
        "sum": "00000000",
    }
    assert area_summary(notes) == (
        'a drawn shape; a circle of 2.5 km; a drawn shape "Site"; the map view'
    )


def test_summary_of_many_regions():
    features = [{"id": f"R{i}", "name": f"Region {i}", "n": 1} for i in range(12)]
    notes = {
        "pieces": [{"kind": "features", "source": "region", "features": features}],
        "sum": "0",
    }
    summary = area_summary(notes)
    assert summary.startswith('regions: "Region 0" (R0), "Region 1" (R1)')
    assert summary.endswith('"Region 9" (R9) and 2 more')


def test_summary_of_notes_that_no_longer_describe_the_area():
    case = next(c for c in CASES if c["name"] == "region_simple")
    stale = {**case["expected"]["notes"], "sum": "00000000"}
    # The panel reads the geometry as one shape then.
    assert area_summary(stale, case["expected"]["cql"]) == "a drawn shape"
    assert area_summary(None, case["expected"]["cql"]) == "a drawn shape"


def test_summary_of_malformed_notes_never_raises():
    for notes in (
        None,
        3,
        {},
        {"pieces": "x", "sum": "0"},
        {"pieces": [{"kind": "x"}], "sum": "0"},
    ):
        assert isinstance(area_summary(notes), str)


def test_summary_never_holds_coordinates():
    for case in CASES:
        summary = area_summary(case["expected"]["notes"], case["expected"]["cql"])
        assert "48." not in summary and "[" not in summary


def test_a_lone_surrogate_in_a_row_is_counted_as_javascript_writes_it() -> None:
    """`JSON.stringify` escapes a lone surrogate (`\\ud800`), which
    `encodeURIComponent` then takes: counted, never raised."""
    assert areas._url_scalar("\ud800") == len("%22%5Cud800%22")
    rows = Rows(
        match="all", rows=(Row(cql={"op": "=", "args": [{"property": "a"}, "\ud800"]}),)
    )
    assert areas._filter_length((), rows, False, "geom") > 0


def test_a_position_with_an_object_member_is_summed_as_javascript_writes_it() -> None:
    position = [11, 48, {"a": 1, "b": [2, "x"]}]
    assert areas._coordinates_text(position) == json.dumps(
        position, separators=(",", ":")
    )


# The assistant's image has no numpy, shapely or DuckDB.


def test_imports_without_numpy_shapely_or_duckdb():
    script = """
import sys

class Refuse:
    def find_spec(self, name, path=None, target=None):
        if name.split(".")[0] in {"numpy", "shapely", "duckdb"}:
            raise ImportError(name)
        return None

sys.meta_path.insert(0, Refuse())
import goatlib.filter.areas
"""
    result = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, check=False
    )
    assert result.returncode == 0, result.stderr
