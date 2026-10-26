"""What counts as a change to a workflow, a report layout and a dashboard.

A save that differs from the stored document only in its volatile parts
(viewport, selection, run state, editor-only view toggles) raises no revision,
so an open editor's autosave after panning or a run does not turn the next
real save of another tab into a conflict.
"""

import copy
from typing import Any

import pytest
from core.core.revision import (
    REPORT_LAYOUT_PAGE_VOLATILE,
    WORKFLOW_NODE_DATA_VOLATILE,
    WORKFLOW_NODE_VOLATILE,
    WORKFLOW_VOLATILE,
    significant_builder_config,
    significant_report_layout_config,
    significant_workflow_config,
)

pytestmark = pytest.mark.unit


def test_the_volatile_lists_are_the_ones_the_web_editors_write() -> None:
    # Source: apps/web/lib/validations/workflow.ts. `viewport` is the canvas
    # pan and zoom (`workflowConfigSchema`, written by the store's
    # `updateViewport` on every move). The step keys are the six "Optional
    # ReactFlow properties" of `workflowNodeSchema`: React Flow's selection
    # and drag state and its drawing order, size and style, which the editor
    # never saves (apps/web/hooks/workflows/useWorkflowAutosave.ts sends each
    # step as id, type, position and data only). The node data keys are the
    # execution state of the tool, export and If steps (`toolNodeDataSchema`,
    # `exportNodeDataSchema`, `ifNodeDataSchema`: "Execution state",
    # "Populated by the executor"). goatlib's project import clears
    # `exportedLayerId`, `jobId` and `status` for the same reason.
    assert WORKFLOW_VOLATILE == frozenset({"viewport"})
    assert WORKFLOW_NODE_VOLATILE == frozenset(
        {"selected", "dragging", "zIndex", "width", "height", "style"}
    )
    assert WORKFLOW_NODE_DATA_VOLATILE == frozenset(
        {"status", "jobId", "error", "outputLayerId", "exportedLayerId", "activeHandle"}
    )
    # Source: apps/web/lib/validations/reportLayout.ts (`pageConfigSchema`):
    # snapping to guides and the rulers only change how the editor shows the
    # page, never the printed report (ReportsConfigPanel's canvas toggles).
    assert REPORT_LAYOUT_PAGE_VOLATILE == frozenset({"snapToGuides", "showRulers"})


def _workflow() -> dict[str, Any]:
    return {
        "nodes": [
            {
                "id": "dataset-1",
                "type": "dataset",
                "position": {"x": 0, "y": 0},
                "data": {"type": "dataset", "label": "Input", "layerId": "a"},
            },
            {
                "id": "tool-1",
                "type": "tool",
                "position": {"x": 300, "y": 0},
                "data": {
                    "type": "tool",
                    "processId": "buffer",
                    "label": "Buffer",
                    "config": {"distance": 100},
                    "status": "idle",
                },
            },
            {
                "id": "export-1",
                "type": "export",
                "position": {"x": 600, "y": 0},
                "data": {"type": "export", "label": "Save", "status": "idle"},
            },
        ],
        "edges": [{"id": "e1", "source": "dataset-1", "target": "tool-1"}],
        "viewport": {"x": 0, "y": 0, "zoom": 1},
        "variables": [],
    }


def test_viewport_selection_and_run_state_are_not_a_change() -> None:
    stored = _workflow()
    saved = copy.deepcopy(stored)
    saved["viewport"] = {"x": -250, "y": 80, "zoom": 1.75}
    saved["nodes"][0]["selected"] = True
    saved["nodes"][0]["dragging"] = False
    saved["nodes"][1]["data"].update(
        status="completed",
        jobId="0192-job",
        outputLayerId="3fa85f64-5717-4562-b3fc-2c963f66afa6",
    )
    saved["nodes"][2]["data"].update(
        status="error",
        error="Failed",
        exportedLayerId="3fa85f64-5717-4562-b3fc-2c963f66afa7",
    )

    assert significant_workflow_config(saved) == significant_workflow_config(stored)


def test_what_the_editor_rewrites_on_its_first_save_is_not_a_change() -> None:
    """The editor saves the config it loaded in its own form
    (apps/web/lib/store/workflow/slice.ts `loadCanvas`, `configToReactFlow`;
    useWorkflowAutosave.ts): notes first, each step as id, type, position and
    data, `variables` as a list, and a connection's empty handle left out."""
    note = {
        "id": "note-1",
        "type": "textAnnotation",
        "position": {"x": 0, "y": 200},
        "zIndex": -1000,
        "width": 400,
        "height": 200,
        "style": {"opacity": 1},
        "data": {"type": "textAnnotation", "text": "<p>Why</p>"},
    }
    stored = _workflow()
    stored["nodes"].append(note)
    stored["nodes"][1]["zIndex"] = 1000
    stored["edges"][0].update(sourceHandle=None, targetHandle="")
    del stored["variables"]

    saved = copy.deepcopy(stored)
    saved["nodes"] = [
        {k: n[k] for k in ("id", "type", "position", "data")} for n in saved["nodes"]
    ]
    saved["nodes"].insert(0, saved["nodes"].pop())
    saved["edges"] = [{"id": "e1", "source": "dataset-1", "target": "tool-1"}]
    saved["variables"] = []

    assert significant_workflow_config(saved) == significant_workflow_config(stored)


@pytest.mark.parametrize(
    "edit",
    [
        lambda c: c["nodes"][1]["data"]["config"].update(distance=200),
        lambda c: (
            c["nodes"][1]["data"]["config"].update(distance=200),
            c.update(viewport={"x": 5, "y": 5, "zoom": 2}),
        ),
        lambda c: c["edges"][0].update(targetHandle="clip_layer_id"),
        lambda c: c["nodes"][1].update(position={"x": 310, "y": 0}),
        lambda c: c["nodes"][0]["data"].update(label="Renamed"),
        lambda c: c["edges"].pop(),
        lambda c: c["variables"].append({"id": "v", "name": "n", "type": "string"}),
        lambda c: c["nodes"].pop(),
    ],
    ids=[
        "setting",
        "setting and viewport",
        "connection input",
        "position",
        "label",
        "connection",
        "variable",
        "step",
    ],
)
def test_steps_settings_connections_and_variables_are_a_change(edit: Any) -> None:
    stored = _workflow()
    saved = copy.deepcopy(stored)
    edit(saved)

    assert significant_workflow_config(saved) != significant_workflow_config(stored)


def test_significant_leaves_the_config_it_reads_unchanged() -> None:
    config = _workflow()
    config["nodes"][0]["selected"] = True
    before = copy.deepcopy(config)

    significant_workflow_config(config)

    assert config == before


@pytest.mark.parametrize(
    "damaged",
    [
        None,
        "text",
        [],
        {"nodes": "not a list", "edges": []},
        {"nodes": [None, "step", {"id": "x", "data": "not a dict"}], "edges": []},
    ],
)
def test_a_damaged_config_is_read_without_failing(damaged: Any) -> None:
    assert significant_workflow_config(damaged) == significant_workflow_config(
        copy.deepcopy(damaged)
    )


def test_layout_view_toggles_are_not_a_change_and_the_page_is() -> None:
    stored = {
        "page": {"size": "A4", "orientation": "portrait", "snapToGuides": False},
        "elements": [],
    }
    toggled = copy.deepcopy(stored)
    toggled["page"].update(snapToGuides=True, showRulers=True)
    landscape = copy.deepcopy(stored)
    landscape["page"]["orientation"] = "landscape"

    assert significant_report_layout_config(toggled) == (
        significant_report_layout_config(stored)
    )
    assert significant_report_layout_config(landscape) != (
        significant_report_layout_config(stored)
    )
    assert significant_report_layout_config(None) is None


def test_every_part_of_a_dashboard_is_a_change() -> None:
    # The dashboard config holds no view state: the builder keeps the
    # selected panel or widget in its Redux store (`map.selectedBuilderItem`).
    stored = {"settings": {"toolbar": True}, "interface": [], "interactions": []}
    saved = copy.deepcopy(stored)
    saved["settings"]["toolbar"] = False

    assert significant_builder_config(stored) == significant_builder_config(
        copy.deepcopy(stored)
    )
    assert significant_builder_config(saved) != significant_builder_config(stored)
