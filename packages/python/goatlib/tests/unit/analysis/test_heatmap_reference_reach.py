"""An exclave of a reference area, a small part whose own extent with the
destinations exceeds the mode's reach, leaves routing, so it does not fail the
whole heatmap. A larger share, or an area too large by itself, is refused."""

import logging
import math
from types import SimpleNamespace

import pytest
from goatlib.analysis.accessibility.heatmap_v2 import (
    MAX_EXCLAVE_SHARE,
    HeatmapV2Tool,
    _check_reference_area_extent,
)
from goatlib.analysis.schemas.catchment_area_v2 import RoutingMode
from goatlib.analysis.schemas.heatmap_v2 import HeatmapType, HeatmapV2Params
from goatlib.tools._routing_limits import MAX_EXTENT_M, validate_extent, within_extent

EARTH_RADIUS_M = 6371000.0
WALKING_REACH_M = MAX_EXTENT_M["walking"]


def _xy(lat: float, lon: float) -> tuple[float, float]:
    """EPSG:3857 metres of a lat/lon in degrees."""
    half = 20037508.342789244
    return (
        lon * half / 180.0,
        math.log(math.tan((90.0 + lat) * math.pi / 360.0)) * half / math.pi,
    )


def _grid(
    lat0: float, lat1: float, lon0: float, lon1: float, step: float
) -> list[tuple[float, float]]:
    n_lat = round((lat1 - lat0) / step) + 1
    n_lon = round((lon1 - lon0) / step) + 1
    return [
        _xy(lat0 + i * step, lon0 + j * step)
        for i in range(n_lat)
        for j in range(n_lon)
    ]


def _km(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Distance of two (lat, lon) points as the extent check measures it."""
    dy = math.radians(a[0] - b[0]) * EARTH_RADIUS_M
    dx = (
        math.radians(a[1] - b[1])
        * EARTH_RADIUS_M
        * math.cos(math.radians((a[0] + b[0]) / 2))
    )
    return math.hypot(dx, dy) / 1000


# A mainland about 40 km wide with destinations only on it, and an island part
# whose centre is about 89 km from the nearest destination and between 120 and
# 140 km from the farthest.
ISLAND_CENTRE = (53.92, 8.50)
DESTINATION_LAT_LONS = [
    (53.58, 9.73),
    (53.55, 10.00),
    (53.42, 10.30),
    (53.72, 10.20),
    (53.45, 9.85),
]
MAINLAND = _grid(53.40, 53.74, 9.73, 10.33, 0.02)
ISLAND = _grid(53.91, 53.93, 8.49, 8.51, 0.01)
DESTINATIONS = [_xy(lat, lon) for lat, lon in DESTINATION_LAT_LONS]
# A country-wide layer: the same mainland destinations, two coastal stops
# inside the bbox of mainland and island but far from both, and stops far
# outside it.
COUNTRY_WIDE = DESTINATIONS + [
    _xy(lat, lon)
    for lat, lon in [
        (53.87, 8.70),
        (53.60, 9.47),
        (48.14, 11.58),
        (52.52, 13.40),
        (50.94, 6.96),
        (47.80, 15.20),
        (53.30, 5.70),
    ]
]
NOT_ROUTED = "they are not routed"


def _groups(points: list[tuple[float, float]]) -> list:
    """One single-seed opportunity per point, as `_load_opportunity_points`
    returns them."""
    return [([(x, y)], 1.0, x, y) for x, y in points]


class PastTheRoutingInputsError(Exception):
    """Raised where the first layer would be routed."""


def _routing_inputs(
    monkeypatch: pytest.MonkeyPatch,
    area: list[tuple[float, float]],
    destinations: list[tuple[float, float]],
) -> tuple[list, list[tuple[float, float]]]:
    """Run a walking closest-average heatmap with a reference area up to the
    routing call; return the opportunities and area cells it would route."""
    tool = HeatmapV2Tool()
    monkeypatch.setattr(
        tool,
        "_rasterize_aoi_to_opportunities",
        lambda path, res: ([(x, y, 1.0) for x, y in area], res),
    )
    monkeypatch.setattr(
        tool,
        "_load_opportunity_points",
        lambda opp, idx, res: _groups(destinations),
    )
    seen: dict[str, list] = {}

    def compute(*args: object) -> str:
        seen["opportunities"] = args[3]
        seen["area_cells"] = args[10]
        raise PastTheRoutingInputsError

    monkeypatch.setattr(tool, "_compute_layer_scores", compute)
    params = HeatmapV2Params.model_construct(
        heatmap_type=HeatmapType.closest_average,
        routing_mode=RoutingMode.walking,
        reference_area_path="area.parquet",
        opportunities=[
            SimpleNamespace(
                name="stops",
                input_path="stops.parquet",
                sensitivity=300000.0,
                max_cost=15,
                n_destinations=1,
            )
        ],
    )
    with pytest.raises(PastTheRoutingInputsError):
        tool._run_implementation(params)
    return seen["opportunities"], seen["area_cells"]


def _todays_refusal(area: list[tuple[float, float]]) -> str:
    with pytest.raises(ValueError, match="Reference area extent") as refused:
        _check_reference_area_extent(area, RoutingMode.walking)
    return str(refused.value)


def test_the_island_is_far_from_every_destination() -> None:
    distances = [_km(ISLAND_CENTRE, d) for d in DESTINATION_LAT_LONS]
    assert 88 < min(distances) < 90
    assert 120 < max(distances) < 140
    assert 38 < _km((53.57, 9.73), (53.57, 10.33)) < 42
    assert len(ISLAND) <= MAX_EXCLAVE_SHARE * len(MAINLAND + ISLAND)


def test_today_the_island_puts_the_whole_area_past_the_walking_reach() -> None:
    _todays_refusal(MAINLAND + ISLAND)


def test_the_island_leaves_routing_and_the_mainland_routes_as_without_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with_island = _routing_inputs(monkeypatch, MAINLAND + ISLAND, DESTINATIONS)
    without_island = _routing_inputs(monkeypatch, MAINLAND, DESTINATIONS)

    assert with_island[1] == MAINLAND
    assert with_island == without_island
    _check_reference_area_extent(with_island[1], RoutingMode.walking)


def test_stops_between_island_and_mainland_do_not_keep_the_island(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.INFO):
        with_island = _routing_inputs(monkeypatch, MAINLAND + ISLAND, COUNTRY_WIDE)
    without_island = _routing_inputs(monkeypatch, MAINLAND, COUNTRY_WIDE)

    assert with_island[1] == MAINLAND
    assert with_island == without_island
    assert with_island[0] == _groups(DESTINATIONS)
    assert NOT_ROUTED in caplog.text


def test_an_area_past_the_reach_whose_cells_all_fit_is_refused_with_todays_message(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    # A strip of about 120 km with one destination in its middle: every cell
    # is within 60 km of it, but the strip is past the reach.
    strip = _grid(53.50, 53.50, 9.00, 10.80, 0.02)
    with caplog.at_level(logging.INFO), pytest.raises(ValueError) as refused:
        _routing_inputs(monkeypatch, strip, [_xy(53.50, 9.90)])
    assert str(refused.value) == _todays_refusal(strip)
    assert NOT_ROUTED not in caplog.text


def test_an_exclave_whose_rest_is_still_past_the_reach_is_refused(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    # A strip of about 145 km with one destination in its middle, and one far
    # cell: the far cell is a small share and does not fit, the strip is left
    # and is still past the reach.
    strip = _grid(53.50, 53.50, 9.00, 11.20, 0.02)
    far = [_xy(53.50, 7.00)]
    with caplog.at_level(logging.INFO), pytest.raises(ValueError) as refused:
        _routing_inputs(monkeypatch, strip + far, [_xy(53.50, 10.10)])
    assert str(refused.value) == _todays_refusal(strip)
    assert str(refused.value) != _todays_refusal(strip + far)
    assert NOT_ROUTED not in caplog.text


def test_an_island_over_the_exclave_share_is_refused_with_todays_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    island = _grid(53.86, 53.96, 8.40, 8.60, 0.01)
    assert len(island) > MAX_EXCLAVE_SHARE * len(MAINLAND + island)
    with pytest.raises(ValueError) as refused:
        _routing_inputs(monkeypatch, MAINLAND + island, DESTINATIONS)
    assert str(refused.value) == _todays_refusal(MAINLAND + island)


def test_an_island_with_a_destination_of_its_own_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Every cell's extent with the destinations now spans island and mainland.
    with pytest.raises(ValueError) as refused:
        _routing_inputs(
            monkeypatch, MAINLAND + ISLAND, DESTINATIONS + [_xy(*ISLAND_CENTRE)]
        )
    assert str(refused.value) == _todays_refusal(MAINLAND + ISLAND)


def test_an_area_within_reach_routes_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A strip of about 98 km with a destination just past each end: the end
    # cells' own extent with the destinations is past the reach, but the area
    # is within it, so nothing is left out.
    strip = _grid(53.50, 53.50, 9.00, 10.48, 0.04)
    destinations = [_xy(53.50, 8.95), _xy(53.50, 10.53)]
    assert not within_extent("walking", [53.50], [9.00], [53.50] * 2, [8.95, 10.53])

    assert _routing_inputs(monkeypatch, strip, destinations) == (
        _groups(destinations),
        strip,
    )


def test_an_area_too_large_without_an_exclave_is_still_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A strip of about 160 km with a destination every 33 km along it.
    strip = _grid(53.50, 53.50, 9.00, 11.40, 0.05)
    destinations = _grid(53.50, 53.50, 9.00, 11.50, 0.50)
    with pytest.raises(ValueError) as refused:
        _routing_inputs(monkeypatch, strip, destinations)
    assert str(refused.value) == _todays_refusal(strip)


def test_an_area_far_from_every_destination_has_no_opportunities(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with pytest.raises(ValueError, match="No opportunity layers produced any points"):
        _routing_inputs(monkeypatch, ISLAND, DESTINATIONS)


def _north(lat: float, metres: float) -> float:
    return lat + math.degrees(metres / EARTH_RADIUS_M)


def test_a_cell_just_inside_the_reach_fits_and_one_just_past_it_does_not() -> None:
    inside = _north(53.0, WALKING_REACH_M - 50)
    past = _north(53.0, WALKING_REACH_M + 50)
    assert within_extent("walking", [53.0], [10.0], [inside], [10.0]).tolist() == [True]
    assert within_extent("walking", [53.0], [10.0], [past], [10.0]).tolist() == [False]


def test_the_farthest_destination_decides() -> None:
    near, far = _north(53.0, 50_000), _north(53.0, WALKING_REACH_M + 1_000)
    assert within_extent(
        "walking", [53.0], [10.0], [near, far], [10.0, 10.0]
    ).tolist() == [False]


def test_each_origin_fits_as_the_extent_check_takes_it_alone() -> None:
    origins = [(53.0 + i * 0.1, 9.0 + i * 0.13) for i in range(20)]
    dest_lats, dest_lons = [53.4, 53.9, 53.2], [9.8, 10.1, 9.5]
    fits = within_extent(
        "walking",
        [o[0] for o in origins],
        [o[1] for o in origins],
        dest_lats,
        dest_lons,
    ).tolist()
    for (lat, lon), fit in zip(origins, fits):
        try:
            validate_extent("walking", [lat], [lon], dest_lats, dest_lons)
            accepted = True
        except ValueError:
            accepted = False
        assert fit == accepted
    assert any(fits) and not all(fits)


def test_no_destinations_fit_no_cell() -> None:
    assert within_extent("walking", [53.0], [10.0], [], []).tolist() == [False]
