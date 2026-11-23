"""The styles of the raster color contract's fixture (`fixtures/raster_color_cases.json`,
read by geoapi's and the web's contract tests) are valid GOAT Styles for the
synthetic file each case colors."""

import json
from typing import Any

import pytest
from goatlib.style.context import BandInfo, DataContext
from goatlib.style.validate import validate

from .conftest import FIXTURES

CASES: list[dict[str, Any]] = json.loads(
    (FIXTURES / "raster_color_cases.json").read_text()
)


def _context(case: dict[str, Any]) -> DataContext:
    """The file the contract tests write for a case: as many bands as its
    samples' cells have, of the case's data type, over its samples' values."""
    cells = [s.get("cells", [s["value"]]) for s in case["samples"]]
    count = max(len(c) for c in cells)
    no_data = case.get("file", {}).get("no_data", -9999)
    bands = []
    for i in range(count):
        values = [c[i] for c in cells if len(c) > i and c[i] != no_data]
        bands.append(BandInfo(i + 1, min(values), max(values)))
    dtype = case.get("file", {}).get("dtype", "float32")
    return DataContext(kind="raster", bands=tuple(bands), data_type=dtype)


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_each_case_is_a_valid_raster_style(case: dict[str, Any]) -> None:
    # Notes are allowed: a case may leave values without a class on purpose.
    issues = [i for i in validate(case["style"], _context(case)) if i.level != "info"]
    assert [(i.code, i.path, i.message) for i in issues] == []
