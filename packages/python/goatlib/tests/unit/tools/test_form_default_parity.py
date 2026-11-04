"""A tool run built without the form behaves as one built with it.

The editor fills some settings in from x-ui hints (`compute_from`,
`default_all`, ...) and refuses to run while a setting it shows without a
default is empty. A workflow drafted by the assistant, a template or an API
call reaches the tool without that form, so each tool applies the same default
itself, or refuses with a message naming the setting, instead of running on a
value the form would never have sent.
"""

from typing import Any

import pytest
from goatlib.tools.catchment_area_v2 import (
    CatchmentAreaV2WindmillParams,
    step_sizes_from,
)
from goatlib.tools.dissolve import DissolveToolParams
from goatlib.tools.geocoding import GeocodingToolParams
from goatlib.tools.join import JoinToolParams
from goatlib.tools.spatial_clustering import ClusteringZonesToolParams
from pydantic import ValidationError

U = "00000000-0000-0000-0000-000000000001"
IDS = {"user_id": U, "folder_id": U}
POINTS = {"latitude": [48.137], "longitude": [11.576]}


def _catchment(**config: Any) -> CatchmentAreaV2WindmillParams:
    return CatchmentAreaV2WindmillParams(
        **{**IDS, "routing_mode": "walking", "starting_points": POINTS, **config}
    )


# --- catchment_area_v2: step sizes (`compute_from` on steps and max_cost) ---


@pytest.mark.parametrize(
    ("max_cost", "steps", "sizes"),
    [
        (15, 5, [3, 6, 9, 12, 15]),
        (10, 3, [3, 7, 10]),
        # Halves round up, as the form's Math.round does: 2.5 -> 3.
        (5, 2, [3, 5]),
        (45, 9, [5, 10, 15, 20, 25, 30, 35, 40, 45]),
    ],
)
def test_catchment_steps_are_the_forms_rounded_steps(
    max_cost: int, steps: int, sizes: list[int]
) -> None:
    assert _catchment(max_cost=max_cost, steps=steps).step_sizes == sizes


def test_catchment_steps_follow_the_mode_default_budget() -> None:
    """Car's default budget is 30 min, resolved before the steps are."""
    params = _catchment(routing_mode="car", steps=3)
    assert (params.max_cost, params.step_sizes) == (30, [10, 20, 30])


def test_catchment_keeps_the_step_sizes_it_is_given() -> None:
    assert _catchment(max_cost=10, steps=2, step_sizes=[4, 10]).step_sizes == [4, 10]


@pytest.mark.parametrize("kind", ["hexagonal_grid", "point_grid"])
def test_catchment_grids_compute_no_step_sizes(kind: str) -> None:
    """The form shows the step sizes for polygons and networks only; the other
    types split the budget into `steps` themselves."""
    config: dict[str, Any] = {"catchment_area_type": kind}
    if kind == "point_grid":
        config["point_grid_layer_id"] = U
    assert _catchment(max_cost=10, steps=3, **config).step_sizes is None


@pytest.mark.parametrize(("limit", "steps"), [(2, 3), (10, 0), (100, 10), (0, 3)])
def test_no_step_sizes_where_the_form_computes_none(limit: int, steps: int) -> None:
    assert step_sizes_from(steps, limit) is None


# --- catchment_area_v2: a point grid needs its layer ---


def test_catchment_point_grid_needs_its_layer() -> None:
    with pytest.raises(ValidationError, match="point_grid_layer_id"):
        _catchment(catchment_area_type="point_grid")


# --- dissolve: statistics switched on need a statistic ---


def test_dissolve_statistics_need_a_statistic() -> None:
    with pytest.raises(ValidationError, match="field_statistics"):
        DissolveToolParams(**IDS, input_layer_id=U, calculate_statistics=True)


def test_dissolve_without_statistics_needs_none() -> None:
    assert DissolveToolParams(**IDS, input_layer_id=U).field_statistics is None


# --- geocoding: the address column of the chosen mode ---


def test_geocoding_full_address_needs_its_column() -> None:
    with pytest.raises(ValidationError, match="full_address_field"):
        GeocodingToolParams(**IDS, input_layer_id=U, input_mode="full_address")


def test_geocoding_structured_needs_the_street_column() -> None:
    with pytest.raises(ValidationError, match="address_field"):
        GeocodingToolParams(**IDS, input_layer_id=U, input_mode="structured")


def test_geocoding_with_its_column_is_valid() -> None:
    params = GeocodingToolParams(
        **IDS, input_layer_id=U, input_mode="full_address", full_address_field="a"
    )
    assert params.full_address_field == "a"


# --- spatial clustering: balancing by a field needs the field ---


def test_clustering_balanced_by_field_needs_the_field() -> None:
    with pytest.raises(ValidationError, match="size_field"):
        ClusteringZonesToolParams(
            **IDS, input_layer_id=U, cluster_type="equal_size", size_method="field"
        )


def test_clustering_balanced_by_count_needs_no_field() -> None:
    params = ClusteringZonesToolParams(
        **IDS, input_layer_id=U, cluster_type="equal_size", size_method="count"
    )
    assert params.size_field is None


# --- join: a left join adds the join fields (`default_by_field` on join_type) ---


def test_a_left_join_adds_the_join_fields() -> None:
    """The form switches "add join fields" on for a left join and hides the
    switch; the parameter model does the same. Which fields it adds, every one
    when none is listed (`default_all`), is in test_join_schema_prediction."""
    params = JoinToolParams(
        **IDS,
        target_layer_id=U,
        join_layer_id=U,
        use_spatial_relationship=True,
        use_attribute_relationship=False,
        spatial_relationship="intersects",
        join_type="left",
    )
    assert params.add_join_fields is True
