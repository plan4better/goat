"""A catchment's step_sizes are its band edges: each band ends at one, so they
rise and end at most at the budget. [5, 5, 5] for bands of five minutes up to
15 ran without an error and drew all three rings at five minutes."""

from typing import Any

import pytest
from goatlib.tools.catchment_area_v2 import CatchmentAreaV2WindmillParams
from pydantic import ValidationError

U = "00000000-0000-0000-0000-000000000001"
POINTS = {"latitude": [48.137], "longitude": [11.576]}


def _catchment(**config: Any) -> CatchmentAreaV2WindmillParams:
    return CatchmentAreaV2WindmillParams(
        user_id=U, folder_id=U, routing_mode="walking", starting_points=POINTS, **config
    )


def test_rising_edges_up_to_the_budget_are_kept() -> None:
    assert _catchment(max_cost=15, steps=3, step_sizes=[5, 10, 15]).step_sizes == [
        5,
        10,
        15,
    ]
    assert _catchment(max_cost=30, steps=3, step_sizes=[5, 15, 30]).step_sizes == [
        5,
        15,
        30,
    ]
    # Left out, they come from steps and the budget, as the form computes them.
    assert _catchment(max_cost=15, steps=3).step_sizes == [5, 10, 15]


@pytest.mark.parametrize(
    "step_sizes",
    [[5, 5, 5], [10, 5, 15], [5, 10, 20], [0, 5, 15]],
    ids=["widths", "falling", "past the budget", "zero"],
)
def test_edges_that_do_not_rise_to_the_budget_are_refused(
    step_sizes: list[int],
) -> None:
    with pytest.raises(ValidationError) as refused:
        _catchment(max_cost=15, steps=3, step_sizes=step_sizes)
    message = str(refused.value)
    assert "band edges" in message
    assert "[5, 10, 15]" in message
