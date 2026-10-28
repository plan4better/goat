"""The style an export's result gets when it becomes a new layer."""

import pytest
from goatlib.tools.workflow_runner import export_style

pytestmark = pytest.mark.unit

TOOL_DEFAULT = {"color": [0, 0, 255]}
AUTHOR = {"color": [255, 0, 0], "opacity": 0.6}


def test_a_template_remembered_style_wins_over_the_tool_default() -> None:
    assert export_style({"outputStyle": AUTHOR}, {"style": TOOL_DEFAULT}) == AUTHOR


def test_without_one_the_tool_default_applies_as_before() -> None:
    assert (
        export_style({"datasetName": "Buffers"}, {"style": TOOL_DEFAULT})
        == TOOL_DEFAULT
    )
    assert export_style({"outputStyle": {}}, {"style": TOOL_DEFAULT}) == TOOL_DEFAULT


def test_nothing_to_apply_is_nothing() -> None:
    assert export_style({}, {}) is None
    assert export_style({"outputStyle": "oops"}, {"style": None}) is None
