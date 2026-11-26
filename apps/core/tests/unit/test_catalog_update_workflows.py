"""The workflow rewrite of a catalog update skips what it cannot read.

It runs after the entries moved, so a step of a shape the editor never saves
must not fail the update; the rest of the workflow is still rewritten.
"""

from typing import Any

from core.services.catalog_update import _rewritten

OLD, NEW = (
    "11111111-1111-1111-1111-111111111111",
    "22222222-2222-2222-2222-222222222222",
)


def _tool(config: Any) -> dict[str, Any]:
    return {"id": "tool", "type": "tool", "data": {"type": "tool", "config": config}}


def test_steps_of_an_unexpected_shape_are_skipped() -> None:
    config = {
        "nodes": [
            {"data": {"type": "dataset", "projectLayerId": [5], "layerId": OLD}},
            {"data": {"type": "dataset", "projectLayerId": {"id": 5}, "layerId": OLD}},
            {"data": {"type": "dataset", "projectLayerId": 5, "layerId": {"id": OLD}}},
            {"data": {"type": "dataset", "projectLayerId": True, "layerId": OLD}},
            {"data": "dataset"},
            "a step that is no object",
            7,
            _tool({"layers": [{"id": OLD}, [OLD]], "count": 5}),
            _tool(None),
        ]
    }

    rewritten = _rewritten(config, {5: NEW}, {OLD: NEW})

    assert rewritten is not None
    nodes = rewritten["nodes"]
    # Only the one step of entry 5 the rewrite can read moves.
    assert [n["data"].get("layerId") for n in nodes[:4]] == [OLD, OLD, NEW, OLD]
    # The other steps read the old id still: the tool setting keeps it.
    assert nodes[7]["data"]["config"] == {"layers": [{"id": OLD}, [OLD]], "count": 5}
    assert nodes[4:7] == config["nodes"][4:7]


def test_a_config_without_a_list_of_steps_is_left_alone() -> None:
    for config in ({"nodes": "steps"}, {"nodes": 3}, {}, [], None):
        assert _rewritten(config, {5: NEW}, {OLD: NEW}) is None
