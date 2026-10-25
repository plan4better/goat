"""The travel cost matrix's pair cap lives in the module the assistant reads too."""

from pathlib import Path
from types import SimpleNamespace

import pytest
from goatlib.analysis.schemas.travel_cost_matrix import RoutingMode
from goatlib.tools import travel_cost_matrix
from goatlib.tools.limits import TRAVEL_COST_MATRIX_MAX_PAIRS


class PastTheSizeCheckError(Exception):
    """Raised by the step a run takes right after the size check."""


def test_the_cap_is_unchanged() -> None:
    assert TRAVEL_COST_MATRIX_MAX_PAIRS == 10_000


def _runner(
    monkeypatch: pytest.MonkeyPatch, origins: int, destinations: int
) -> travel_cost_matrix.TravelCostMatrixToolRunner:
    """A runner whose layers hold that many origin and destination points; it
    stops with ``PastTheSizeCheckError`` once the size check lets them pass."""
    runner = travel_cost_matrix.TravelCostMatrixToolRunner()
    monkeypatch.setattr(
        runner, "export_layer_to_parquet", lambda layer_id, **kwargs: layer_id
    )
    sizes = {"origins": origins, "destinations": destinations}

    def points(layer: str, id_column: str) -> tuple[list[float], ...]:
        n = sizes[layer]
        return [0.0] * n, [0.0] * n, [str(i) for i in range(n)]

    def past(*args: object) -> None:
        raise PastTheSizeCheckError

    monkeypatch.setattr(runner, "_extract_coordinates_from_parquet", points)
    monkeypatch.setattr(travel_cost_matrix, "validate_extent", past)
    return runner


def _params() -> SimpleNamespace:
    return SimpleNamespace(
        origin_layer_id="origins",
        origin_layer_filter=None,
        destination_layer_id="destinations",
        destination_layer_filter=None,
        origin_id_column="id",
        destination_id_column="id",
        user_id=None,
        routing_mode=RoutingMode.walking,
    )


def test_the_runner_refuses_one_pair_too_many(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    runner = _runner(monkeypatch, origins=10_001, destinations=1)
    with pytest.raises(ValueError) as error:
        runner.process(_params(), tmp_path)
    assert str(error.value) == (
        "Matrix size (10001 origins × 1 destinations = 10,001 pairs) exceeds "
        "the maximum of 10,000. Reduce the number of origins or destinations."
    )


def test_the_runner_takes_the_cap_itself(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    runner = _runner(monkeypatch, origins=100, destinations=100)
    with pytest.raises(PastTheSizeCheckError):
        runner.process(_params(), tmp_path)


def test_the_runner_compares_with_the_shared_cap(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The size check reads the cap from `limits`, not a number of its own."""
    monkeypatch.setattr(travel_cost_matrix, "TRAVEL_COST_MATRIX_MAX_PAIRS", 6)
    with pytest.raises(PastTheSizeCheckError):
        _runner(monkeypatch, origins=2, destinations=3).process(_params(), tmp_path)
    with pytest.raises(ValueError, match=r"= 9 pairs\) exceeds the maximum of 6\."):
        _runner(monkeypatch, origins=3, destinations=3).process(_params(), tmp_path)
