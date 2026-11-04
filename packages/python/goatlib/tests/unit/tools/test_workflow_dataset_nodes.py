"""A workflow's dataset node reads the layer its project entry shows now.

Dataset nodes carry both the layer id picked in the editor (``layerId``)
and the project entry it came from (``projectLayerId``). The runner used
only ``layerId``. When a re-run in a copied project writes a new layer behind
an inherited entry, a downstream workflow consuming that result kept reading
the old layer, from the project it was copied from.
"""

import copy
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from goatlib.tools import workflow_runner
from goatlib.tools.workflow_dataset_nodes import with_current_layer_ids
from goatlib.tools.workflow_runner import WorkflowRunnerParams

PROJECT = "00000000-0000-0000-0000-000000000030"


def _dataset(node_id: str, layer_id: str, link_id: Any = None) -> dict[str, Any]:
    data: dict[str, Any] = {"type": "dataset", "layerId": layer_id}
    if link_id is not None:
        data["projectLayerId"] = link_id
    return {"id": node_id, "type": "dataset", "data": data}


TOOL = {
    "id": "tool-1",
    "type": "tool",
    "data": {"type": "tool", "processId": "buffer", "config": {"projectLayerId": 7}},
}


def test_dataset_node_reads_the_layer_its_entry_shows_now() -> None:
    nodes = [_dataset("dataset-1", "old-layer", 7), TOOL]
    before = copy.deepcopy(nodes)

    out = with_current_layer_ids(nodes, {7: "new-layer"})

    assert out[0]["data"] == {
        "type": "dataset",
        "layerId": "new-layer",
        "projectLayerId": 7,
    }
    assert out[1] == TOOL
    assert nodes == before, "the nodes as sent are not modified"


def test_nodes_without_a_live_entry_in_the_project_keep_their_layer() -> None:
    """No entry found (another project's, removed, trashed) or none given
    (a dataset picked from the catalog): the picked layer stands."""
    nodes = [
        _dataset("dataset-1", "picked-1", 8),
        _dataset("dataset-2", "picked-2"),
    ]

    assert with_current_layer_ids(nodes, {7: "new-layer"}) == nodes


def test_runner_resolves_dataset_nodes_in_the_running_project() -> None:
    params = WorkflowRunnerParams(
        user_id="00000000-0000-0000-0000-000000000001",
        project_id=PROJECT,
        workflow_id="00000000-0000-0000-0000-000000000010",
        folder_id="00000000-0000-0000-0000-000000000040",
        nodes=[_dataset("dataset-1", "old-layer", 7), _dataset("dataset-2", "x"), TOOL],
        edges=[],
    )
    conn = MagicMock()
    conn.close = AsyncMock()
    lookup = AsyncMock(return_value={7: "new-layer"})

    with (
        patch.object(
            workflow_runner, "_connect", new=AsyncMock(return_value=(conn, "customer"))
        ),
        patch.object(workflow_runner, "current_layer_ids", new=lookup),
    ):
        nodes = workflow_runner.resolve_dataset_layers(params)

    assert lookup.await_args.kwargs == {
        "user_id": "00000000-0000-0000-0000-000000000001",
        "project_id": PROJECT,
        "link_ids": [7],
    }
    assert nodes[0]["data"]["layerId"] == "new-layer"
    assert nodes[1]["data"]["layerId"] == "x"
    conn.close.assert_awaited_once()


def test_runner_skips_the_lookup_when_no_node_names_an_entry() -> None:
    params = WorkflowRunnerParams(
        user_id="00000000-0000-0000-0000-000000000001",
        project_id=PROJECT,
        workflow_id="00000000-0000-0000-0000-000000000010",
        folder_id="00000000-0000-0000-0000-000000000040",
        nodes=[_dataset("dataset-1", "picked"), TOOL],
        edges=[],
    )
    connect = AsyncMock()

    with patch.object(workflow_runner, "_connect", new=connect):
        nodes = workflow_runner.resolve_dataset_layers(params)

    connect.assert_not_awaited()
    assert nodes == params.nodes


def test_runner_keeps_the_nodes_as_sent_when_the_lookup_fails() -> None:
    """A database hiccup (or a worker without database settings) must not
    fail every workflow that reads a project layer."""
    params = WorkflowRunnerParams(
        user_id="00000000-0000-0000-0000-000000000001",
        project_id=PROJECT,
        workflow_id="00000000-0000-0000-0000-000000000010",
        folder_id="00000000-0000-0000-0000-000000000040",
        nodes=[_dataset("dataset-1", "saved-layer", 7)],
        edges=[],
    )

    with patch.object(
        workflow_runner,
        "_connect",
        new=AsyncMock(side_effect=OSError("connection refused")),
    ):
        nodes = workflow_runner.resolve_dataset_layers(params)

    assert nodes == params.nodes


def test_a_failed_lookup_does_not_put_connection_details_in_the_job_log(
    capsys: pytest.CaptureFixture[str], caplog: pytest.LogCaptureFixture
) -> None:
    """Job output is visible to the user who ran the workflow; a database
    error can carry the host, user or connection string."""
    params = WorkflowRunnerParams(
        user_id="00000000-0000-0000-0000-000000000001",
        project_id=PROJECT,
        workflow_id="00000000-0000-0000-0000-000000000010",
        folder_id="00000000-0000-0000-0000-000000000040",
        nodes=[_dataset("dataset-1", "saved-layer", 7)],
        edges=[],
    )
    detail = "postgresql://goat:s3cret@db-internal:5432/goat refused"

    with patch.object(
        workflow_runner, "_connect", new=AsyncMock(side_effect=OSError(detail))
    ):
        workflow_runner.resolve_dataset_layers(params)

    assert "s3cret" not in capsys.readouterr().out
    assert "s3cret" not in caplog.text


# --- Nodes that name their layer without an entry (template copies) --------

SOURCE = "27ceed82-0a35-46dc-bb71-3a574744e297"
COPY = "f16bfd54-0000-4000-8000-000000000001"


def _pruefroutine_config() -> dict[str, Any]:
    """The shape of the Bonn "Prüfroutine (mehrere Vorhaben)" input: a dataset
    node saved with `layerId` only (`layerType: "layer"`, no
    `projectLayerId`), read by a tool node, plus an unrelated dataset."""
    return {
        "nodes": [
            {
                "id": "dataset-ba8e066f-b898-47e9-bfe8-056cbd41edf7",
                "type": "dataset",
                "data": {
                    "type": "dataset",
                    "label": "Vorhaben (Eingabe)",
                    "layerId": SOURCE,
                    "layerName": "Vorhaben (Eingabe)",
                    "layerType": "layer",
                    "geometryType": "point",
                    "filterInitialized": True,
                },
            },
            {
                "id": "dataset-other",
                "type": "dataset",
                "data": {"type": "dataset", "layerId": "other-layer"},
            },
            {
                "id": "tool-1",
                "type": "tool",
                "data": {
                    "type": "tool",
                    "processId": "buffer",
                    "config": {"input_layer_id": SOURCE, "distances": [500]},
                },
            },
        ],
        "edges": [],
    }


def test_a_node_without_an_entry_follows_the_copy_by_its_layer() -> None:
    from goatlib.tools.workflow_dataset_nodes import _unlinked_retargeted

    out = _unlinked_retargeted(
        _pruefroutine_config(),
        source_layer_id=SOURCE,
        layer_id=COPY,
        link_id=748,
        project_link_ids={748, 749},
    )

    assert out is not None
    vorhaben, other, tool = out["nodes"]
    assert vorhaben["data"]["layerId"] == COPY
    # Given the entry, so later swaps behind it reach the node too.
    assert vorhaben["data"]["projectLayerId"] == 748
    assert vorhaben["data"]["layerName"] == "Vorhaben (Eingabe)"
    assert other["data"] == {"type": "dataset", "layerId": "other-layer"}
    assert tool["data"]["config"] == {"input_layer_id": COPY, "distances": [500]}


def test_a_node_with_an_entry_of_the_project_is_left_to_its_entry() -> None:
    from goatlib.tools.workflow_dataset_nodes import _unlinked_retargeted

    config = _pruefroutine_config()
    config["nodes"][0]["data"]["projectLayerId"] = 749
    assert (
        _unlinked_retargeted(
            config,
            source_layer_id=SOURCE,
            layer_id=COPY,
            link_id=748,
            project_link_ids={748, 749},
        )
        is None
    )


def test_a_node_with_an_entry_of_another_project_counts_as_without() -> None:
    from goatlib.tools.workflow_dataset_nodes import _unlinked_retargeted

    config = _pruefroutine_config()
    config["nodes"][0]["data"]["projectLayerId"] = 12  # the author's project
    out = _unlinked_retargeted(
        config,
        source_layer_id=SOURCE,
        layer_id=COPY,
        link_id=748,
        project_link_ids={748},
    )
    assert out is not None
    assert out["nodes"][0]["data"]["projectLayerId"] == 748


def test_nothing_names_the_source_nothing_changes() -> None:
    from goatlib.tools.workflow_dataset_nodes import _unlinked_retargeted

    assert (
        _unlinked_retargeted(
            _pruefroutine_config(),
            source_layer_id="not-in-this-workflow",
            layer_id=COPY,
            link_id=748,
            project_link_ids={748},
        )
        is None
    )


# --- The style an export saves a dataset step's rows in -----------------------

USER = "00000000-0000-0000-0000-000000000001"
LAYER = "90e3bcb2-d7ec-4abf-955d-50633ab4a101"


class _StyleConn:
    """A connection answering the style query with one row, remembering the
    arguments it was given."""

    def __init__(self, entry_style: Any = None, layer_style: Any = None) -> None:
        self.row = {"entry_style": entry_style, "layer_style": layer_style}
        self.args: tuple[Any, ...] = ()

    async def fetchrow(self, query: str, *args: Any) -> dict[str, Any]:
        self.args = args
        return self.row


async def _style(conn: _StyleConn, node: dict[str, Any]) -> Any:
    from goatlib.tools.workflow_dataset_nodes import dataset_style

    return await dataset_style(
        conn, "customer", user_id=USER, project_id=PROJECT, node=node
    )


async def test_a_dataset_steps_style_is_its_project_entrys() -> None:
    """The entry's style is the one the project shows the layer in; the
    layer's own is what it had when it was added."""
    import json
    import uuid

    conn = _StyleConn(
        entry_style=json.dumps({"color": "red", "visibility": True}),
        layer_style=json.dumps({"color": "blue", "visibility": True}),
    )

    style = await _style(conn, _dataset("dataset-1", LAYER, 7))

    assert style == {"color": "red", "visibility": True}
    assert conn.args == (uuid.UUID(PROJECT), uuid.UUID(USER), 7, uuid.UUID(LAYER))


async def test_without_a_live_entry_the_layers_own_style_applies() -> None:
    import json

    conn = _StyleConn(layer_style=json.dumps({"color": "blue"}))

    style = await _style(conn, _dataset("dataset-1", LAYER))

    assert style == {"color": "blue", "visibility": True}
    # A node without an entry asks for none.
    assert conn.args[2] is None


async def test_a_hidden_dataset_is_saved_visible() -> None:
    """Visibility is the project's view state, not style: the saved layer is
    added to the project shown, as core adds a layer a project already has."""
    import json

    conn = _StyleConn(entry_style=json.dumps({"color": "red", "visibility": False}))

    style = await _style(conn, _dataset("dataset-1", LAYER, 7))

    assert style == {"color": "red", "visibility": True}


@pytest.mark.parametrize("empty", [None, "null", "{}", "[]"])
async def test_an_empty_style_leaves_the_default_style(empty: Any) -> None:
    """None: finalize_layer then gives the saved layer the default style."""
    import json

    assert await _style(_StyleConn(empty, empty), _dataset("d", LAYER, 7)) is None
    # An empty entry style does not hide the layer's own.
    conn = _StyleConn(empty, json.dumps({"color": "blue"}))
    assert await _style(conn, _dataset("d", LAYER, 7)) == {
        "color": "blue",
        "visibility": True,
    }


def _style_params() -> WorkflowRunnerParams:
    return WorkflowRunnerParams(
        user_id=USER,
        project_id=PROJECT,
        workflow_id="00000000-0000-0000-0000-000000000010",
        folder_id="00000000-0000-0000-0000-000000000040",
        nodes=[],
        edges=[],
    )


def test_runner_looks_up_a_dataset_steps_style() -> None:
    conn = MagicMock()
    conn.close = AsyncMock()
    lookup = AsyncMock(return_value={"color": "red", "visibility": True})
    node = _dataset("dataset-1", LAYER, 7)

    with (
        patch.object(
            workflow_runner, "_connect", new=AsyncMock(return_value=(conn, "customer"))
        ),
        patch.object(workflow_runner, "dataset_style", new=lookup),
    ):
        style = workflow_runner.dataset_layer_style(_style_params(), node)

    assert style == {"color": "red", "visibility": True}
    assert lookup.await_args.kwargs == {
        "user_id": USER,
        "project_id": PROJECT,
        "node": node,
    }
    conn.close.assert_awaited_once()


def test_a_failed_style_lookup_saves_in_the_default_style(
    capsys: pytest.CaptureFixture[str], caplog: pytest.LogCaptureFixture
) -> None:
    """The style must not fail the export; and job output is visible to the
    user, so no connection details go into it."""
    detail = "postgresql://goat:s3cret@db-internal:5432/goat refused"

    with patch.object(
        workflow_runner, "_connect", new=AsyncMock(side_effect=OSError(detail))
    ):
        style = workflow_runner.dataset_layer_style(
            _style_params(), _dataset("dataset-1", LAYER, 7)
        )

    assert style is None
    assert "s3cret" not in capsys.readouterr().out
    assert "s3cret" not in caplog.text


def test_a_dataset_step_without_a_layer_asks_for_no_style() -> None:
    connect = AsyncMock()
    node = {"id": "dataset-1", "type": "dataset", "data": {"type": "dataset"}}

    with patch.object(workflow_runner, "_connect", new=connect):
        assert workflow_runner.dataset_layer_style(_style_params(), node) is None

    connect.assert_not_awaited()
