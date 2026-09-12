"""Tests for the Overture transportation splitter."""

from pathlib import Path
from typing import Any, Dict, List

import pytest
from goatlib.bundles.importers.street_network.overture import linear_ref, splitter
from goatlib.bundles.importers.street_network.overture.reader import (
    read_connectors,
    read_segments,
)
from goatlib.bundles.importers.street_network.overture.splitter import (
    collect_linear_references,
    split_network,
)

from .overture_fixture import (
    TAL,
    TAL_JOIN_A,
    TAL_JOIN_B,
    build_split_input,
    write_geoparquet,
)

# Munich sits at ~48°N, where planar and geodetic lengths differ enough that a
# planar implementation would misplace split points measurably.
MUNICH_LAT = 48.137


# --- linear referencing ---------------------------------------------------


def test_total_length_is_geodetic() -> None:
    """One degree of longitude at 48°N is ~74.4 km, not ~111 km."""
    length = linear_ref.total_length([(11.0, MUNICH_LAT), (12.0, MUNICH_LAT)])
    assert 74_000 < length < 75_000


def test_planar_and_geodetic_disagree() -> None:
    """Guards the reason this module exists: treating lon/lat as x/y is wrong.

    A degree of longitude and a degree of latitude are the same planar distance
    but very different on the ellipsoid.
    """
    east_west = linear_ref.total_length([(11.0, MUNICH_LAT), (12.0, MUNICH_LAT)])
    north_south = linear_ref.total_length([(11.0, MUNICH_LAT), (11.0, MUNICH_LAT + 1)])
    assert north_south > east_west * 1.4


def test_interpolate_endpoints_are_exact() -> None:
    """A split at 0 or 1 must reproduce the parent's vertices bit-for-bit."""
    assert linear_ref.interpolate(TAL, 0.0) == TAL[0]
    assert linear_ref.interpolate(TAL, 1.0) == TAL[-1]


def test_interpolate_midpoint_is_equidistant() -> None:
    coord = linear_ref.interpolate(TAL, 0.5)
    first_half = linear_ref.total_length([TAL[0], coord])
    second_half = linear_ref.total_length([coord, TAL[-1]])
    # Straight-line distances either side of the midpoint of a gently curving
    # line agree closely; a planar interpolation would skew them.
    assert first_half == pytest.approx(second_half, rel=0.02)


def test_substring_keeps_interior_vertices() -> None:
    piece = linear_ref.substring(TAL, 0.0, 1.0)
    assert len(piece) == len(TAL)
    assert piece[0] == TAL[0]
    assert piece[-1] == TAL[-1]


def test_substring_lengths_sum_to_whole() -> None:
    total = linear_ref.total_length(TAL)
    parts = [(0.0, 0.35), (0.35, 0.7), (0.7, 1.0)]
    summed = sum(
        linear_ref.total_length(linear_ref.substring(TAL, s, e)) for s, e in parts
    )
    assert summed == pytest.approx(total, rel=1e-6)


# --- splitting ------------------------------------------------------------


@pytest.fixture
def split_result():
    return split_network(*build_split_input())


def _pieces_of(result, overture_id: str) -> List[Dict[str, Any]]:
    return [s for s in result.segments if s["original_id"] == overture_id]


def test_piece_counts_per_segment(split_result) -> None:
    """Each segment splits at its connectors and its attribute boundaries."""
    assert len(_pieces_of(split_result, "seg-tal")) == 4
    assert len(_pieces_of(split_result, "seg-rindermarkt")) == 1
    assert len(_pieces_of(split_result, "seg-frauenstrasse")) == 2
    assert len(_pieces_of(split_result, "seg-sendlinger")) == 1
    assert len(_pieces_of(split_result, "seg-isarradweg")) == 3
    assert split_result.stats.segments_out == 11


def test_every_piece_has_exactly_two_connectors(split_result) -> None:
    for piece in split_result.segments:
        assert len(piece["connectors"]) == 2, piece["id"]


def test_no_piece_retains_linear_references(split_result) -> None:
    """The defining postcondition: nothing scoped survives splitting."""
    scoped = ("road_surface", "road_flags", "speed_limits", "access_restrictions")
    for piece in split_result.segments:
        for field in scoped:
            for rule in piece.get(field) or []:
                assert "between" not in rule, f"{piece['id']}.{field}"


def test_tal_splits_at_connectors_and_speed_change(split_result) -> None:
    pieces = sorted(_pieces_of(split_result, "seg-tal"), key=lambda p: p["start_lr"])
    bounds = [(p["start_lr"], p["end_lr"]) for p in pieces]
    assert bounds == [
        (0.0, TAL_JOIN_A),
        (TAL_JOIN_A, 0.5),
        (0.5, TAL_JOIN_B),
        (TAL_JOIN_B, 1.0),
    ]


def test_scoped_speed_limit_lands_on_the_right_pieces(split_result) -> None:
    """30 km/h below 0.5, 50 above — one unscoped value per piece."""
    pieces = sorted(_pieces_of(split_result, "seg-tal"), key=lambda p: p["start_lr"])
    speeds = [p["speed_limits"][0]["max_speed"]["value"] for p in pieces]
    assert speeds == [30, 30, 50, 50]


def test_surface_change_without_a_connector_splits_frauenstrasse(
    split_result,
) -> None:
    pieces = sorted(
        _pieces_of(split_result, "seg-frauenstrasse"), key=lambda p: p["start_lr"]
    )
    assert [p["start_lr"] for p in pieces] == [0.0, 0.5]
    assert [p["road_surface"][0]["value"] for p in pieces] == ["paving_stones", "paved"]


def test_unscoped_property_is_copied_to_every_piece(split_result) -> None:
    """A whole-segment rule applies to all pieces, not just the first."""
    for piece in _pieces_of(split_result, "seg-tal"):
        assert piece["road_surface"][0]["value"] == "paved"


def test_road_flag_range_isolates_the_bridge(split_result) -> None:
    pieces = sorted(
        _pieces_of(split_result, "seg-isarradweg"), key=lambda p: p["start_lr"]
    )
    assert [p["start_lr"] for p in pieces] == [0.0, 0.2, 0.4]
    flagged = [bool(p.get("road_flags")) for p in pieces]
    assert flagged == [False, True, False]
    assert pieces[1]["road_flags"][0]["values"] == ["is_bridge"]


def test_existing_connectors_are_reused_not_duplicated(split_result) -> None:
    """A split at a real connector must reference its id, not mint a new one."""
    pieces = sorted(_pieces_of(split_result, "seg-tal"), key=lambda p: p["start_lr"])
    assert pieces[0]["connectors"][0]["connector_id"] == "c-marienplatz"
    assert pieces[0]["connectors"][1]["connector_id"] == "c-tal-rindermarkt"
    assert pieces[3]["connectors"][1]["connector_id"] == "c-isartor"


def test_synthetic_connectors_are_minted_only_where_needed(split_result) -> None:
    """One per attribute boundary lacking a connector: Tal 0.5, Frauenstraße 0.5,
    Isarradweg 0.2 and 0.4."""
    synthetic = [c for c in split_result.connectors if c.get("synthetic")]
    assert len(synthetic) == 4
    assert split_result.stats.nodes_reconstructed == 4
    assert split_result.stats.nodes_in == 8
    assert len(split_result.connectors) == 12


def test_synthetic_connector_sits_on_the_geometry(split_result) -> None:
    """Its coordinate has to be the cut point, or the graph won't join up."""
    piece = next(
        p
        for p in _pieces_of(split_result, "seg-tal")
        if p["start_lr"] == pytest.approx(0.5)
    )
    connector_id = piece["connectors"][0]["connector_id"]
    connector = next(c for c in split_result.connectors if c["id"] == connector_id)
    assert connector["coordinate"] == pytest.approx(piece["coordinates"][0])


def test_synthetic_ids_are_deterministic() -> None:
    """Re-importing the same extract must not churn node ids."""

    def run():
        return split_network(*build_split_input())

    first = {c["id"] for c in run().connectors}
    second = {c["id"] for c in run().connectors}
    assert first == second


def test_pieces_tile_the_parent_geometry(split_result) -> None:
    """No length is lost or duplicated by splitting."""
    for overture_id, coords in (("seg-tal", TAL),):
        pieces = _pieces_of(split_result, overture_id)
        summed = sum(linear_ref.total_length(p["coordinates"]) for p in pieces)
        assert summed == pytest.approx(linear_ref.total_length(coords), rel=1e-6)


def test_pieces_join_end_to_start(split_result) -> None:
    """Consecutive pieces must share a coordinate, or the edge chain breaks."""
    pieces = sorted(_pieces_of(split_result, "seg-tal"), key=lambda p: p["start_lr"])
    for left, right in zip(pieces, pieces[1:]):
        assert left["coordinates"][-1] == pytest.approx(right["coordinates"][0])
        assert (
            left["connectors"][1]["connector_id"]
            == (right["connectors"][0]["connector_id"])
        )


def test_parent_records_are_not_mutated() -> None:
    """Splitting must not write back into its input."""
    segments, connectors = build_split_input()

    tal = next(s for s in segments if s["id"] == "seg-tal")
    before = [dict(rule) for rule in tal["speed_limits"]]
    split_network(segments, connectors)
    assert tal["speed_limits"] == before
    assert len(tal["connectors"]) == 4


# --- geoparquet round trip ------------------------------------------------


def test_splits_the_same_network_read_from_geoparquet(tmp_path: Path) -> None:
    """The whole path: official-schema geoparquet -> read -> split."""
    segments_path, connectors_path = write_geoparquet(tmp_path / "overture")

    segments = read_segments(str(segments_path))
    connectors = read_connectors(str(connectors_path))
    assert len(segments) == 5
    assert len(connectors) == 8

    result = split_network(segments, connectors)
    assert result.stats.segments_out == 11
    assert result.stats.nodes_reconstructed == 4
    for piece in result.segments:
        assert len(piece["connectors"]) == 2
        assert piece["class"] in {
            "residential",
            "living_street",
            "tertiary",
            "pedestrian",
            "cycleway",
        }


def test_near_endpoint_connector_does_not_absorb_the_real_end() -> None:
    """A connector just short of 1.0 must not cost the segment its end node."""
    segments, connectors = build_split_input()

    tal = next(s for s in segments if s["id"] == "seg-tal")
    tal["speed_limits"] = [
        {"max_speed": {"value": 30, "unit": "km/h"}, "between": [0.0, 0.99999999]},
        {"max_speed": {"value": 50, "unit": "km/h"}, "between": [0.99999999, 1.0]},
    ]

    result = split_network(segments, connectors)
    pieces = sorted(
        (s for s in result.segments if s["original_id"] == "seg-tal"),
        key=lambda p: p["start_lr"],
    )
    assert pieces[-1]["end_lr"] == 1.0
    assert pieces[-1]["connectors"][1]["connector_id"] == "c-isartor"


# --- consistency with the reference splitter ------------------------------


def test_output_ids_are_unique_and_composite(split_result) -> None:
    """The reference forms `{id}@{start_lr}-{end_lr}`; the bare id repeats."""
    ids = [s["id"] for s in split_result.segments]
    assert len(ids) == len(set(ids))
    tal = sorted(_pieces_of(split_result, "seg-tal"), key=lambda p: p["start_lr"])
    assert tal[0]["id"] == f"seg-tal@0.0-{TAL_JOIN_A}"
    assert tal[0]["original_id"] == "seg-tal"


def test_linear_references_are_found_at_any_depth() -> None:
    """Discovery is recursive, not a fixed field list — a `between` nested inside
    a field we've never heard of still forces a split."""
    found = collect_linear_references(
        {"some_future_field": {"inner": [{"value": "x", "between": [0.25, 0.75]}]}}
    )
    assert found == {0.0, 0.25, 0.75, 1.0}


def test_a_future_scoped_field_still_splits_the_segment() -> None:
    segments, connectors = build_split_input()
    tal = next(s for s in segments if s["id"] == "seg-tal")
    tal["speed_limits"] = None
    tal["some_future_field"] = [{"value": "x", "between": [0.0, 0.25]}]

    result = split_network(segments, connectors)
    starts = sorted(p["start_lr"] for p in _pieces_of(result, "seg-tal"))
    assert 0.25 in starts


def test_split_points_are_rounded_to_the_configured_precision(split_result) -> None:
    """7 decimals (~1 cm), matching the reference, so geometry is run-stable."""
    for piece in split_result.segments:
        for lon, lat in piece["coordinates"]:
            assert round(lon, 7) == lon
            assert round(lat, 7) == lat


def test_scope_covering_the_whole_piece_is_dropped() -> None:
    applied = splitter.apply_lr_scope(
        {"value": "paved", "between": [0.0, 1.0]},
        piece_start_m=0.0,
        piece_length_m=100.0,
        segment_length_m=100.0,
        min_overlap_m=0.01,
    )
    assert applied == {"value": "paved"}


def test_scope_missing_the_piece_removes_the_value() -> None:
    applied = splitter.apply_lr_scope(
        {"value": "paving_stones", "between": [0.0, 0.4]},
        piece_start_m=50.0,
        piece_length_m=50.0,
        segment_length_m=100.0,
        min_overlap_m=0.01,
    )
    assert applied is None


def test_partial_overlap_rewrites_between_relative_to_the_piece() -> None:
    """The reference rescales rather than dropping. Unreachable while we split at
    every boundary, but the behaviour has to match if splitting is relaxed."""
    applied = splitter.apply_lr_scope(
        {"value": "paving_stones", "between": [0.25, 0.75]},
        piece_start_m=0.0,
        piece_length_m=50.0,
        segment_length_m=100.0,
        min_overlap_m=0.01,
    )
    assert applied == {"value": "paving_stones", "between": [0.5, 1.0]}


# --- properties that reference other features -----------------------------


def test_turn_restriction_lands_only_on_the_piece_that_owns_it(
    split_result,
) -> None:
    """Copying it onto every piece would multiply one restriction into four."""
    pieces = sorted(_pieces_of(split_result, "seg-tal"), key=lambda p: p["start_lr"])
    carrying = [i for i, p in enumerate(pieces) if p.get("prohibited_transitions")]
    assert carrying == [3]
    assert pieces[3]["connectors"][1]["connector_id"] == "c-isartor"


def test_turn_restriction_is_dropped_from_segments_without_the_connector(
    split_result,
) -> None:
    for piece in split_result.segments:
        if piece["original_id"] != "seg-tal":
            assert not piece.get("prohibited_transitions")


# --- non-geometric scoping survives splitting -----------------------------


def test_non_geometric_scoping_keeps_multiple_rules_per_piece(split_result) -> None:
    """Splitting removes geometric scoping only.

    Frauenstraße is denied backward except to buses: two access rules over the
    whole range, distinguished by `when`, on every piece. Flattening these arrays
    to one value per piece would silently drop a restriction.
    """
    for piece in _pieces_of(split_result, "seg-frauenstrasse"):
        rules = piece["access_restrictions"]
        assert len(rules) == 2
        assert {r["access_type"] for r in rules} == {"denied", "allowed"}
        assert all(r["when"]["heading"] == "backward" for r in rules)
        # And none of them carries geometric scope any more.
        assert all("between" not in r for r in rules)


def test_connector_missing_from_the_upload_is_still_given_a_node() -> None:
    """Every extract is bbox-clipped, so a segment crossing the boundary declares
    a connector the connectors file doesn't contain. Without reconstructing it the
    edge would point at a node absent from the layer."""
    segments, connectors = build_split_input()
    # Drop the connector Tal starts at, as a clip would.
    connectors = [c for c in connectors if c["id"] != "c-marienplatz"]

    result = split_network(segments, connectors)
    node_ids = {c["id"] for c in result.connectors}
    for piece in result.segments:
        for endpoint in piece["connectors"]:
            assert endpoint["connector_id"] in node_ids

    reconstructed = next(c for c in result.connectors if c["id"] == "c-marienplatz")
    # Its id is real; only the geometry had to be recovered from edge geometry.
    assert reconstructed["synthetic"] is True
    assert reconstructed["coordinate"] == pytest.approx(TAL[0])


def test_connectors_no_edge_references_are_dropped() -> None:
    """A clipped connectors file carries nodes for segments we don't have; keeping
    them would scatter isolated points across the layer."""
    segments, connectors = build_split_input()
    connectors.append(
        {"id": "c-elsewhere", "coordinate": (11.9, 48.9), "theme": "transportation"}
    )

    result = split_network(segments, connectors)
    assert "c-elsewhere" not in {c["id"] for c in result.connectors}
    assert result.stats.nodes_unreferenced == 1


def test_every_output_node_is_referenced_by_an_edge(split_result) -> None:
    referenced = {
        endpoint["connector_id"]
        for piece in split_result.segments
        for endpoint in piece["connectors"]
    }
    assert {c["id"] for c in split_result.connectors} == referenced
    assert split_result.stats.nodes_out == len(split_result.connectors)
