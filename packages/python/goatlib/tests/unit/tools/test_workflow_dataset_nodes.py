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


def _layer_only_config() -> dict[str, Any]:
    """A workflow whose input is a dataset node saved with `layerId` only
    (`layerType: "layer"`, no `projectLayerId`), read by a tool node, plus an
    unrelated dataset."""
    return {
        "nodes": [
            {
                "id": "dataset-ba8e066f-b898-47e9-bfe8-056cbd41edf7",
                "type": "dataset",
                "data": {
                    "type": "dataset",
                    "label": "Standorte (Eingabe)",
                    "layerId": SOURCE,
                    "layerName": "Standorte (Eingabe)",
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
        _layer_only_config(),
        source_layer_id=SOURCE,
        layer_id=COPY,
        link_id=748,
        project_link_ids={748, 749},
    )

    assert out is not None
    site, other, tool = out["nodes"]
    assert site["data"]["layerId"] == COPY
    # Given the entry, so later swaps behind it reach the node too.
    assert site["data"]["projectLayerId"] == 748
    assert site["data"]["layerName"] == "Standorte (Eingabe)"
    assert other["data"] == {"type": "dataset", "layerId": "other-layer"}
    assert tool["data"]["config"] == {"input_layer_id": COPY, "distances": [500]}


def test_a_node_with_an_entry_of_the_project_is_left_to_its_entry() -> None:
    from goatlib.tools.workflow_dataset_nodes import _unlinked_retargeted

    config = _layer_only_config()
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

    config = _layer_only_config()
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
            _layer_only_config(),
            source_layer_id="not-in-this-workflow",
            layer_id=COPY,
            link_id=748,
            project_link_ids={748},
        )
        is None
    )
