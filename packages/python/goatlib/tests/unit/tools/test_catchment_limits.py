"""The catchment start-point limits live in one module the assistant reads too."""

from pathlib import Path
from types import SimpleNamespace

import pytest
from goatlib.analysis.schemas.catchment_area import CatchmentAreaRoutingMode
from goatlib.tools import catchment_area_v2
from goatlib.tools.limits import (
    CATCHMENT_MAX_STARTING_POINTS,
    CATCHMENT_MAX_STARTING_POINTS_PT,
)


def test_the_limits_are_unchanged() -> None:
    assert CATCHMENT_MAX_STARTING_POINTS == 1000
    assert CATCHMENT_MAX_STARTING_POINTS_PT == 100


def test_the_runner_reads_them() -> None:
    assert (
        catchment_area_v2.CATCHMENT_MAX_STARTING_POINTS is CATCHMENT_MAX_STARTING_POINTS
    )
    assert (
        catchment_area_v2.CATCHMENT_MAX_STARTING_POINTS_PT
        is CATCHMENT_MAX_STARTING_POINTS_PT
    )


@pytest.mark.parametrize(
    ("mode", "n_points", "message"),
    [
        (
            CatchmentAreaRoutingMode.pt,
            101,
            "Public transport supports a maximum of 100 starting points. Got 101.",
        ),
        (
            CatchmentAreaRoutingMode.walking,
            1001,
            "Maximum 1,000 starting points allowed. Got 1001.",
        ),
    ],
    ids=["public transport", "street modes"],
)
def test_the_runner_refuses_one_point_too_many(
    mode: CatchmentAreaRoutingMode,
    n_points: int,
    message: str,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    runner = catchment_area_v2.CatchmentAreaV2ToolRunner()
    monkeypatch.setattr(
        runner,
        "_get_starting_coordinates",
        lambda *args, **kwargs: ([0.0] * n_points, [0.0] * n_points),
    )
    params = SimpleNamespace(
        starting_points=None, user_id=None, reference_field=None, routing_mode=mode
    )
    with pytest.raises(ValueError) as error:
        runner.process(params, tmp_path)
    assert str(error.value) == message
