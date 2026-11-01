"""The shape checker refuses configs that cannot be read as a workflow, and
finds cycles and connections to missing steps for the full check."""

from typing import Any

import pytest
from goatlib.workflows.checks import (
    NODE_TYPES,
    Issue,
    dangling_edges,
    find_loops,
    node_list,
    shape_issues,
)

pytestmark = pytest.mark.unit


def _node(node_id: str, node_type: str = "tool") -> dict[str, Any]:
    return {
        "id": node_id,
        "type": node_type,
        "position": {"x": 0, "y": 0},
        "data": {"type": node_type},
    }


def _edge(source: str, target: str, handle: str = "input_layer_id") -> dict[str, Any]:
    return {
        "id": f"{source}->{target}",
        "source": source,
        "target": target,
        "targetHandle": handle,
    }


def _codes(issues: list[Issue]) -> list[str]:
    return [issue.code for issue in issues]


def test_a_valid_config_has_no_issues() -> None:
    config = {
        "nodes": [_node("d1", "dataset"), _node("t1"), _node("x1", "export")],
        "edges": [_edge("d1", "t1"), _edge("t1", "x1", "input")],
        "viewport": {"x": 0, "y": 0, "zoom": 1},
        "variables": [],
    }
    assert shape_issues(config) == []


def test_an_empty_workflow_is_not_damaged() -> None:
    assert shape_issues({"nodes": [], "edges": []}) == []


def test_every_editor_step_type_is_known() -> None:
    assert NODE_TYPES == {"dataset", "tool", "textAnnotation", "export", "if"}
    config = {"nodes": [_node(t, t) for t in sorted(NODE_TYPES)], "edges": []}
    assert shape_issues(config) == []


@pytest.mark.parametrize("config", [None, [], "nodes", 3])
def test_a_config_that_is_not_an_object(config: object) -> None:
    issues = shape_issues(config)
    assert len(issues) == 1
    assert issues[0].to_dict() == {
        "code": "config_not_object",
        "level": "damaged",
        "node_ids": [],
        "field": None,
        "message": "The workflow configuration is not an object.",
        "params": {},
        "source": "check",
    }


def test_missing_steps_and_connections() -> None:
    assert _codes(shape_issues({})) == ["nodes_not_list", "edges_not_list"]


def test_steps_and_connections_that_are_not_lists() -> None:
    issues = shape_issues({"nodes": {"a": 1}, "edges": "a->b"})
    assert _codes(issues) == ["nodes_not_list", "edges_not_list"]
    assert all(issue.level == "damaged" for issue in issues)
    assert all(issue.node_ids == () for issue in issues)


@pytest.mark.parametrize(
    "bad_node",
    [
        {"type": "tool"},
        {"id": "", "type": "tool"},
        {"id": 7, "type": "tool"},
        "tool",
        None,
    ],
)
def test_a_step_without_an_id(bad_node: object) -> None:
    issues = shape_issues({"nodes": [_node("t1"), bad_node], "edges": []})
    assert [issue.to_dict() for issue in issues] == [
        {
            "code": "node_without_id",
            "level": "damaged",
            "node_ids": [],
            "field": None,
            "message": "The step at index 1 has no id.",
            "params": {"index": 1},
            "source": "check",
        }
    ]


@pytest.mark.parametrize(
    ("node_type", "shown"),
    [("buffer", "buffer"), (None, ""), (["tool"], "['tool']"), ("Tool", "Tool")],
)
def test_a_step_of_unknown_type(node_type: object, shown: str) -> None:
    node: dict[str, Any] = {"id": "n1", "data": {}}
    if node_type is not None:
        node["type"] = node_type
    issues = shape_issues({"nodes": [node], "edges": []})
    assert _codes(issues) == ["node_unknown_type"]
    assert issues[0].node_ids == ("n1",)
    assert issues[0].params == {"type": shown}
    assert issues[0].message == f'The step "n1" has an unknown type "{shown}".'


def test_steps_sharing_an_id_are_reported_once_per_id() -> None:
    config = {
        "nodes": [_node("a"), _node("b"), _node("a"), _node("a"), _node("b")],
        "edges": [],
    }
    issues = shape_issues(config)
    assert _codes(issues) == ["node_duplicate_id", "node_duplicate_id"]
    assert [issue.node_ids for issue in issues] == [("a",), ("b",)]
    assert [issue.params for issue in issues] == [{"id": "a"}, {"id": "b"}]


@pytest.mark.parametrize(
    "bad_edge",
    [
        {"id": "e", "source": "a"},
        {"id": "e", "target": "a"},
        {"id": "e", "source": "", "target": "a"},
        {"id": "e", "source": "a", "target": None},
        "a->b",
    ],
)
def test_a_connection_without_both_ends(bad_edge: object) -> None:
    config = {"nodes": [_node("a"), _node("b")], "edges": [_edge("a", "b"), bad_edge]}
    issues = shape_issues(config)
    assert _codes(issues) == ["edge_without_ends"]
    assert issues[0].params == {"index": 1}
    assert issues[0].node_ids == ()


def test_a_connection_to_a_missing_step_is_not_damaged() -> None:
    # The full check reports it as connection_to_removed_step; the config
    # itself still reads as a workflow.
    config = {"nodes": [_node("a")], "edges": [_edge("a", "gone")]}
    assert shape_issues(config) == []


def test_several_problems_are_all_reported() -> None:
    config = {
        "nodes": [_node("a"), {"type": "tool"}, _node("a", "chart")],
        "edges": [{"source": "a"}],
    }
    assert _codes(shape_issues(config)) == [
        "node_without_id",
        "node_unknown_type",
        "node_duplicate_id",
        "edge_without_ends",
    ]


def test_issue_to_dict_lists_node_ids_and_copies_params() -> None:
    issue = Issue(
        code="loop",
        level="error",
        message="Steps A, B form a loop.",
        node_ids=("a", "b"),
        params={"steps": ["A", "B"]},
    )
    as_dict = issue.to_dict()
    assert as_dict == {
        "code": "loop",
        "level": "error",
        "node_ids": ["a", "b"],
        "field": None,
        "message": "Steps A, B form a loop.",
        "params": {"steps": ["A", "B"]},
        "source": "check",
    }
    as_dict["params"]["extra"] = 1
    assert issue.params == {"steps": ["A", "B"]}


def test_node_list_returns_the_steps() -> None:
    nodes = [_node("a"), _node("b")]
    assert node_list({"nodes": nodes, "edges": []}) == nodes


def test_no_loops_in_a_chain_or_a_diamond() -> None:
    nodes = [_node(n) for n in "abcd"]
    edges = [_edge("a", "b"), _edge("a", "c"), _edge("b", "d"), _edge("c", "d")]
    assert find_loops(nodes, edges) == []


def test_a_two_step_loop() -> None:
    nodes = [_node("a"), _node("b"), _node("c")]
    edges = [_edge("a", "b"), _edge("b", "c"), _edge("c", "b")]
    assert find_loops(nodes, edges) == [["b", "c"]]


def test_ids_follow_node_order_not_edge_order() -> None:
    nodes = [_node("x"), _node("m"), _node("a")]
    edges = [_edge("a", "m"), _edge("m", "x"), _edge("x", "a")]
    assert find_loops(nodes, edges) == [["x", "m", "a"]]


def test_a_step_connected_to_itself() -> None:
    nodes = [_node("a"), _node("b")]
    edges = [_edge("a", "b"), _edge("b", "b")]
    assert find_loops(nodes, edges) == [["b"]]


def test_two_separate_loops_in_node_order() -> None:
    nodes = [_node(n) for n in ["p", "q", "r", "s", "t"]]
    edges = [
        _edge("s", "t"),
        _edge("t", "s"),
        _edge("p", "q"),
        _edge("q", "p"),
        _edge("q", "r"),
    ]
    assert find_loops(nodes, edges) == [["p", "q"], ["s", "t"]]


def test_loops_ignore_connections_to_missing_steps() -> None:
    nodes = [_node("a"), _node("b")]
    edges = [_edge("a", "gone"), _edge("gone", "a"), _edge("a", "b")]
    assert find_loops(nodes, edges) == []


def test_a_long_chain_does_not_hit_the_recursion_limit() -> None:
    ids = [f"n{i}" for i in range(5000)]
    nodes = [_node(node_id) for node_id in ids]
    edges = [_edge(a, b) for a, b in zip(ids, ids[1:])]
    assert find_loops(nodes, edges) == []
    edges.append(_edge(ids[-1], ids[0]))
    assert find_loops(nodes, edges) == [ids]


def test_dangling_edges_are_the_ones_to_or_from_missing_steps() -> None:
    nodes = [_node("a"), _node("b")]
    kept = _edge("a", "b")
    to_gone = _edge("a", "gone")
    from_gone = _edge("gone", "b")
    assert dangling_edges(nodes, [kept, to_gone, from_gone]) == [to_gone, from_gone]


def test_no_dangling_edges_in_a_connected_workflow() -> None:
    nodes = [_node("a"), _node("b")]
    assert dangling_edges(nodes, [_edge("a", "b")]) == []
