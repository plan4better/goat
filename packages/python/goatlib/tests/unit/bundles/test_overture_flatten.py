"""Tests for flattening split Overture segments into member-layer records."""

import json
from typing import Any, Dict, List

import pytest
from goatlib.bundles.importers.street_network.overture.flatten import (
    flatten_connector,
    flatten_network,
    flatten_segment,
)
from goatlib.bundles.importers.street_network.overture.splitter import split_network

from .overture_fixture import build_split_input


@pytest.fixture
def flattened():
    segments, connectors = build_split_input()
    return flatten_network(split_network(segments, connectors))


def _edges_of(edges: List[Dict[str, Any]], overture_id: str) -> List[Dict[str, Any]]:
    """A segment's pieces, in order along it.

    The splitter emits pieces in ascending position and flattening preserves that
    order, so filtering is enough — the layer no longer carries the positions as
    columns (`test_pieces_tile_the_parent_geometry` pins the ordering).
    """
    return [e for e in edges if e["original_id"] == overture_id]


def _piece(road_class: str = "residential", **overrides: Any) -> Dict[str, Any]:
    piece = {
        "id": "s@0.0-1.0",
        "original_id": "s",
        "start_lr": 0.0,
        "end_lr": 1.0,
        "class": road_class,
        "names": {"primary": "Test"},
        "connectors": [
            {"connector_id": "c-a", "at": 0.0},
            {"connector_id": "c-b", "at": 1.0},
        ],
        "coordinates": [(11.0, 48.0), (11.001, 48.0)],
    }
    piece.update(overrides)
    return piece


# --- shape ----------------------------------------------------------------


def test_every_edge_is_flat(flattened) -> None:
    """No column may hold a list or dict, apart from geometry."""
    edges, _ = flattened
    for edge in edges:
        for column, value in edge.items():
            if column in ("coordinates", "overture"):
                continue
            assert not isinstance(value, (list, dict)), f"{column} on {edge['id']}"


def test_edges_share_one_column_set(flattened) -> None:
    """A data-dependent schema would break the layer; every row is identical."""
    edges, _ = flattened
    assert len({frozenset(e) for e in edges}) == 1


def test_topology_columns_carry_the_endpoint_connectors(flattened) -> None:
    edges, _ = flattened
    tal = _edges_of(edges, "seg-tal")
    assert tal[0]["source_node"] == "c-marienplatz"
    assert tal[0]["target_node"] == "c-tal-rindermarkt"
    # Consecutive edges chain, which is what makes source/target usable.
    for left, right in zip(tal, tal[1:]):
        assert left["target_node"] == right["source_node"]


def test_minted_nodes_are_named_after_where_they_were_minted(flattened) -> None:
    """Their id is `{segment_id}@{linear_reference}`; nothing else needs saying."""
    _, nodes = flattened
    assert sum(1 for n in nodes if "@" in n["id"]) == 4
    assert all(n["coordinate"] is not None for n in nodes)


# --- geometric-only properties become scalars -----------------------------


def test_surface_flattens_per_edge(flattened) -> None:
    """Frauenstraße changes surface at 0.5; each edge gets one value."""
    edges, _ = flattened
    assert [e["surface"] for e in _edges_of(edges, "seg-frauenstrasse")] == [
        "paving_stones",
        "paved",
    ]
    assert all(e["surface"] == "paved" for e in _edges_of(edges, "seg-tal"))


def test_road_flags_stay_whole_in_the_residual(flattened) -> None:
    """Bridges and tunnels don't affect routing, so they get no column — the whole
    flag array is carried instead."""
    edges, _ = flattened
    flagged = [
        e
        for e in _edges_of(edges, "seg-isarradweg")
        if e["other"] and "road_flags" in json.loads(e["other"])
    ]
    assert len(flagged) == 1
    assert json.loads(flagged[0]["other"])["road_flags"][0]["values"] == ["is_bridge"]
    for edge in edges:
        assert "is_bridge" not in edge
        assert "is_tunnel" not in edge


def test_unknown_flag_is_preserved_in_the_residual() -> None:
    """A flag added upstream after this vocabulary was written must not vanish."""
    edge = flatten_segment(_piece(road_flags=[{"values": ["is_teleporter"]}]))
    assert json.loads(edge["other"])["road_flags"] == [{"values": ["is_teleporter"]}]


def test_subclass_rule_wins_over_the_plain_field() -> None:
    edge = flatten_segment(
        _piece(subclass="sidewalk", subclass_rules=[{"value": "crosswalk"}])
    )
    assert edge["subclass"] == "crosswalk"


def test_properties_without_a_column_land_in_the_residual() -> None:
    """level, width and the flags nothing consumes are carried rather than
    promoted — no column, but no data loss either."""
    edge = flatten_segment(
        _piece(
            level_rules=[{"value": -1}],
            width_rules=[{"value": 7.5}],
            road_flags=[{"values": ["is_indoor"]}],
        )
    )
    assert "level" not in edge
    assert "width_m" not in edge
    residual = json.loads(edge["other"])
    assert residual["level_rules"] == [{"value": -1}]
    assert residual["width_rules"] == [{"value": 7.5}]
    assert residual["road_flags"] == [{"values": ["is_indoor"]}]


# --- speed limits ---------------------------------------------------------


def test_unscoped_speed_limit_applies_both_directions() -> None:
    edge = flatten_segment(
        _piece(speed_limits=[{"max_speed": {"value": 30, "unit": "km/h"}}])
    )
    assert edge["speed_limit_kph_forward"] == 30
    assert edge["speed_limit_kph_backward"] == 30


def test_heading_scoped_speed_limits_become_two_columns() -> None:
    """The loss that motivated this: a direction-dependent limit stays visible."""
    edge = flatten_segment(
        _piece(
            speed_limits=[
                {
                    "max_speed": {"value": 50, "unit": "km/h"},
                    "when": {"heading": "forward"},
                },
                {
                    "max_speed": {"value": 30, "unit": "km/h"},
                    "when": {"heading": "backward"},
                },
            ]
        )
    )
    assert edge["speed_limit_kph_forward"] == 50
    assert edge["speed_limit_kph_backward"] == 30


def test_heading_rule_overrides_the_unscoped_one_for_its_direction() -> None:
    edge = flatten_segment(
        _piece(
            speed_limits=[
                {"max_speed": {"value": 50, "unit": "km/h"}},
                {
                    "max_speed": {"value": 20, "unit": "km/h"},
                    "when": {"heading": "backward"},
                },
            ]
        )
    )
    assert edge["speed_limit_kph_forward"] == 50
    assert edge["speed_limit_kph_backward"] == 20


def test_mph_is_normalised_to_kph() -> None:
    edge = flatten_segment(
        _piece(speed_limits=[{"max_speed": {"value": 30, "unit": "mph"}}])
    )
    assert edge["speed_limit_kph_forward"] == 48


def test_mode_scoped_limit_is_skipped_but_unscoped_one_still_applies() -> None:
    edge = flatten_segment(
        _piece(
            speed_limits=[
                {"max_speed": {"value": 50, "unit": "km/h"}},
                {
                    "max_speed": {"value": 30, "unit": "km/h"},
                    "when": {"mode": ["truck"]},
                },
            ]
        )
    )
    assert edge["speed_limit_kph_forward"] == 50


# --- residual -------------------------------------------------------------


def test_speed_is_zero_in_a_closed_direction(flattened) -> None:
    """Overture has no `oneway` field — it denies access in a heading. That has to
    reach the speed column, or every street would be two-way. Overture puts
    speed.value at a minimum of 1, so 0 can never collide with a real limit."""
    edges, _ = flattened
    for edge in _edges_of(edges, "seg-frauenstrasse"):
        assert edge["speed_limit_kph_forward"] == 30
        assert edge["speed_limit_kph_backward"] == 0


def test_open_streets_keep_their_speed_both_ways(flattened) -> None:
    edges, _ = flattened
    for edge in _edges_of(edges, "seg-tal"):
        assert edge["speed_limit_kph_forward"] == edge["speed_limit_kph_backward"]
        assert edge["speed_limit_kph_forward"] > 0


def test_non_drivable_classes_have_no_speed_limit(flattened) -> None:
    """A footway or cycleway has no meaningful limit, so the column is null rather
    than a number nobody should read."""
    edges, _ = flattened
    for overture_id in ("seg-sendlinger", "seg-isarradweg"):
        for edge in _edges_of(edges, overture_id):
            assert edge["speed_limit_kph_forward"] is None
            assert edge["speed_limit_kph_backward"] is None


def test_drivable_class_without_a_stated_limit_gets_the_default() -> None:
    edge = flatten_segment(_piece(road_class="residential"))
    assert edge["speed_limit_kph_forward"] == 30
    assert edge["speed_limit_kph_backward"] == 30


def test_stated_limit_wins_over_the_default() -> None:
    edge = flatten_segment(
        _piece(
            road_class="residential",
            speed_limits=[{"max_speed": {"value": 50, "unit": "km/h"}}],
        )
    )
    assert edge["speed_limit_kph_forward"] == 50


def test_unconditional_denial_closes_both_directions() -> None:
    edge = flatten_segment(
        _piece(
            road_class="residential", access_restrictions=[{"access_type": "denied"}]
        )
    )
    assert edge["speed_limit_kph_forward"] == 0
    assert edge["speed_limit_kph_backward"] == 0


def test_designated_access_is_not_a_denial() -> None:
    edge = flatten_segment(
        _piece(
            road_class="residential",
            access_restrictions=[{"access_type": "designated"}],
        )
    )
    assert edge["speed_limit_kph_forward"] == 30


def test_last_matching_rule_wins() -> None:
    """The schema states rules are general-first, specific-last, following OSM
    conditional restrictions — so a car-specific permission after a general denial
    leaves the street open."""
    edge = flatten_segment(
        _piece(
            road_class="residential",
            access_restrictions=[
                {"access_type": "denied"},
                {"access_type": "allowed", "when": {"mode": ["motor_vehicle"]}},
            ],
        )
    )
    assert edge["speed_limit_kph_forward"] == 30


def test_order_matters_the_other_way_round() -> None:
    edge = flatten_segment(
        _piece(
            road_class="residential",
            access_restrictions=[
                {"access_type": "allowed"},
                {"access_type": "denied", "when": {"mode": ["motor_vehicle"]}},
            ],
        )
    )
    assert edge["speed_limit_kph_forward"] == 0


def test_a_later_rule_only_overrides_the_heading_it_names() -> None:
    edge = flatten_segment(
        _piece(
            road_class="residential",
            access_restrictions=[
                {"access_type": "denied"},
                {"access_type": "allowed", "when": {"heading": "forward"}},
            ],
        )
    )
    assert edge["speed_limit_kph_forward"] == 30
    assert edge["speed_limit_kph_backward"] == 0


def test_permit_only_permission_does_not_open_a_general_denial() -> None:
    """ "closed, except with a permit" is closed to an ordinary driver."""
    edge = flatten_segment(
        _piece(
            road_class="residential",
            access_restrictions=[
                {"access_type": "denied"},
                {"access_type": "allowed", "when": {"recognized": ["as_permitted"]}},
            ],
        )
    )
    assert edge["speed_limit_kph_forward"] == 0


def test_denials_aimed_at_other_modes_do_not_close_the_street() -> None:
    """`motor_vehicle` includes car/truck/motorcycle, but `hgv`, `bus` and `hov`
    are siblings — none of them implies an ordinary car."""
    for mode in ("bicycle", "foot", "hgv", "bus", "hov", "truck", "motorcycle"):
        edge = flatten_segment(
            _piece(
                road_class="residential",
                access_restrictions=[
                    {"access_type": "denied", "when": {"mode": [mode]}}
                ],
            )
        )
        assert edge["speed_limit_kph_forward"] == 30, mode


def test_car_bearing_modes_do_close_the_street() -> None:
    for mode in ("vehicle", "motor_vehicle", "car"):
        edge = flatten_segment(
            _piece(
                road_class="residential",
                access_restrictions=[
                    {"access_type": "denied", "when": {"mode": [mode]}}
                ],
            )
        )
        assert edge["speed_limit_kph_forward"] == 0, mode


def test_denial_scoped_to_a_car_mode_closes_only_its_heading() -> None:
    edge = flatten_segment(
        _piece(
            road_class="residential",
            access_restrictions=[
                {
                    "access_type": "denied",
                    "when": {"heading": "backward", "mode": ["motor_vehicle"]},
                }
            ],
        )
    )
    assert edge["speed_limit_kph_forward"] == 30
    assert edge["speed_limit_kph_backward"] == 0


def test_situational_closures_do_not_block_permanently() -> None:
    """A street closed 15:00-18:00, or to over-weight vehicles, is still drivable
    in general — treating it as impassable would remove it from the network."""
    for when in (
        {"during": "Mo-Fr 15:00-18:00"},
        {
            "vehicle": [
                {
                    "dimension": "weight",
                    "comparison": "greater_than",
                    "value": 3.5,
                    "unit": "t",
                }
            ]
        },
        {"using": ["at_destination"]},
    ):
        edge = flatten_segment(
            _piece(
                road_class="residential",
                access_restrictions=[{"access_type": "denied", "when": when}],
            )
        )
        assert edge["speed_limit_kph_forward"] == 30, when
        assert "access_restrictions" in json.loads(edge["other"])


def test_only_unexpressible_rules_are_kept(flattened) -> None:
    """Frauenstraße is denied backward (expressed as speed 0) except to buses (a
    mode no column can name). Only the second survives — the first would be
    stored twice."""
    edges, _ = flattened
    for edge in _edges_of(edges, "seg-frauenstrasse"):
        kept = json.loads(edge["other"])["access_restrictions"]
        assert len(kept) == 1
        assert kept[0]["when"]["mode"] == ["bus"]


def test_a_plain_speed_limit_is_not_stored_twice() -> None:
    """It is fully captured by the column, so the residual has no reason to hold
    it — and on a real city that duplication was 1.8 MB."""
    edge = flatten_segment(
        _piece(
            road_class="residential",
            speed_limits=[{"max_speed": {"value": 50, "unit": "km/h"}}],
        )
    )
    assert edge["speed_limit_kph_forward"] == 50
    assert edge["other"] is None


def test_a_conditional_speed_limit_is_kept() -> None:
    edge = flatten_segment(
        _piece(
            road_class="residential",
            speed_limits=[
                {"max_speed": {"value": 50, "unit": "km/h"}},
                {
                    "max_speed": {"value": 30, "unit": "km/h"},
                    "when": {"during": "Mo-Fr 07:00-09:00"},
                },
            ],
        )
    )
    assert edge["speed_limit_kph_forward"] == 50
    kept = json.loads(edge["other"])["speed_limits"]
    assert len(kept) == 1
    assert kept[0]["when"]["during"] == "Mo-Fr 07:00-09:00"


def test_a_non_drivable_class_keeps_every_rule() -> None:
    """Nothing was expressed — the speed columns are null — so nothing may be
    dropped on the grounds of being captured."""
    edge = flatten_segment(
        _piece(
            road_class="footway",
            speed_limits=[{"max_speed": {"value": 10, "unit": "km/h"}}],
            access_restrictions=[{"access_type": "denied"}],
        )
    )
    assert edge["speed_limit_kph_forward"] is None
    residual = json.loads(edge["other"])
    assert residual["speed_limits"] and residual["access_restrictions"]


# --- name resolution ------------------------------------------------------


def test_primary_name_is_used() -> None:
    edge = flatten_segment(_piece(names={"primary": "Tal"}))
    assert edge["name"] == "Tal"


def test_route_reference_names_an_unnamed_numbered_road() -> None:
    """An unnamed trunk road is usually a numbered one — 216 of Augsburg's 48k
    unnamed segments — and `B 17` beats a blank."""
    edge = flatten_segment(
        _piece(
            road_class="trunk",
            names=None,
            routes=[
                {"name": "Bundesstraße 17", "ref": "B 17", "network": "DE:national"}
            ],
        )
    )
    assert edge["name"] == "B 17"


def test_common_and_rule_names_are_fallbacks() -> None:
    assert flatten_segment(_piece(names={"common": {"de": "Hauptstraße"}}))["name"] == (
        "Hauptstraße"
    )
    assert (
        flatten_segment(
            _piece(names={"rules": [{"variant": "official", "value": "Alte Gasse"}]})
        )["name"]
        == "Alte Gasse"
    )


def test_a_genuinely_unnamed_road_stays_null() -> None:
    """Most unnamed roads are service roads, footways and paths with no identifier
    anywhere — inventing one would be worse than a blank."""
    edge = flatten_segment(_piece(road_class="service", names=None))
    assert edge["name"] is None


def test_heading_scoped_limits_become_the_two_columns() -> None:
    edge = flatten_segment(
        _piece(
            road_class="residential",
            speed_limits=[
                {
                    "max_speed": {"value": 50, "unit": "km/h"},
                    "when": {"heading": "forward"},
                },
                {
                    "max_speed": {"value": 30, "unit": "km/h"},
                    "when": {"heading": "backward"},
                },
            ],
        )
    )
    assert edge["speed_limit_kph_forward"] == 50
    assert edge["speed_limit_kph_backward"] == 30


def test_time_scoped_limit_falls_back_to_the_class_default() -> None:
    edge = flatten_segment(
        _piece(
            road_class="residential",
            speed_limits=[
                {
                    "max_speed": {"value": 30, "unit": "km/h"},
                    "when": {"during": "Mo-Fr 07:00-09:00"},
                }
            ],
        )
    )
    assert edge["speed_limit_kph_forward"] == 30  # the default, not the rule
    assert "speed_limits" in json.loads(edge["other"])


def test_unrecognised_class_is_treated_as_unknown_and_stays_drivable() -> None:
    """The engine's WHERE filter would drop a class it doesn't know, deleting the
    road; `unknown` is in its vocabulary and drivable."""
    edge = flatten_segment(_piece(road_class="teleporter"))
    assert edge["speed_limit_kph_forward"] == 30


def test_turn_restriction_survives_on_the_edge_that_owns_it(flattened) -> None:
    edges, _ = flattened
    carrying = [
        e
        for e in _edges_of(edges, "seg-tal")
        if e["other"] and "prohibited_transitions" in json.loads(e["other"])
    ]
    assert len(carrying) == 1
    assert carrying[0]["target_node"] == "c-isartor"


def test_unknown_fields_are_carried_rather_than_dropped() -> None:
    edge = flatten_segment(_piece(some_future_field={"a": 1}))
    assert json.loads(edge["other"])["some_future_field"] == {"a": 1}


def test_residual_is_null_when_nothing_is_left_over() -> None:
    """An edge fully described by its columns shouldn't carry an empty blob."""
    edge = flatten_segment(_piece(road_surface=[{"value": "paved"}], speed_limits=None))
    assert edge["other"] is None


def test_residual_is_json_serialisable(flattened) -> None:
    edges, _ = flattened
    for edge in edges:
        if edge["other"] is not None:
            assert isinstance(json.loads(edge["other"]), dict)


def test_flatten_connector_shape() -> None:
    """Id and coordinate, and nothing else — `synthetic` is dropped, since the
    id a minted connector was given already carries it."""
    node = flatten_connector(
        {"id": "c-a", "coordinate": (11.0, 48.0), "synthetic": True}
    )
    assert node == {"id": "c-a", "coordinate": (11.0, 48.0)}


# --- the one invariant this design depends on -----------------------------


def test_every_overture_field_is_either_a_column_or_residual(flattened) -> None:
    """Guards `_CONSUMED_FIELDS` against drifting from `flatten_segment`.

    Adding a column without listing its source field leaves the value stored
    twice; removing one without delisting loses it. Neither is visible without
    this check, so it walks every field the fixture actually carries.
    """
    from goatlib.bundles.importers.street_network.overture.flatten import (
        _CONSUMED_FIELDS,
    )

    segments, _ = build_split_input()
    present = {
        key
        for segment in segments
        for key, value in segment.items()
        if value is not None
    }
    edges, _ = flattened

    for field in present:
        residuals = [json.loads(e["other"]) for e in edges if e["other"] is not None]
        in_residual = any(field in r for r in residuals)
        consumed = field in _CONSUMED_FIELDS
        assert consumed or in_residual, (
            f"'{field}' is neither consumed into a column nor kept in the "
            f"residual — it would be silently dropped"
        )


def test_writer_schema_matches_the_flattened_record() -> None:
    """Declared column types are only safe if they cover exactly the record.

    A column added to `flatten_segment` without a schema entry would be silently
    dropped on write; one removed would be written as all-null.
    """
    from goatlib.bundles.importers.street_network.overture.writer import (
        EDGE_COMPUTED,
        EDGE_SCHEMA,
        NODE_SCHEMA,
    )

    edge = flatten_segment(_piece())
    # Computed columns are filled from the geometry on write, so they are the
    # one kind of column that legitimately has no record key.
    expected = (set(edge) - {"coordinates"}) | {"geometry"} | set(EDGE_COMPUTED)
    assert set(EDGE_SCHEMA.names) == expected

    node = flatten_connector({"id": "c", "coordinate": (11.0, 48.0)})
    assert set(NODE_SCHEMA.names) == (set(node) - {"coordinate"}) | {"geometry"}


def test_writer_schema_types_match_the_file(tmp_path) -> None:
    """Declared types are only worth anything if the file agrees with them.

    `SELECT * REPLACE (<expr> AS col)` keeps the declared column order but
    takes the *expression's* type, so a computed column comes out at its kind's
    width whatever the schema says. Names alone would not catch that: the
    column would be there, one width off, and every reader would trust the
    declaration.
    """
    import pyarrow.parquet as pq
    from goatlib.bundles.importers.street_network.overture.writer import (
        EDGE_SCHEMA,
        NODE_SCHEMA,
        write_edges,
        write_nodes,
    )

    edge = flatten_segment(_piece())
    written = pq.read_schema(write_edges([edge], str(tmp_path / "edges.parquet")))
    for field in EDGE_SCHEMA:
        # Geometry alone is expected to change type: it goes in as WKB and
        # comes out a real geometry column.
        if field.name == "geometry":
            continue
        assert written.field(field.name).type == field.type, field.name

    node = flatten_connector({"id": "n", "coordinate": (11.0, 48.0)})
    written = pq.read_schema(write_nodes([node], str(tmp_path / "nodes.parquet")))
    for field in NODE_SCHEMA:
        if field.name == "geometry":
            continue
        assert written.field(field.name).type == field.type, field.name
