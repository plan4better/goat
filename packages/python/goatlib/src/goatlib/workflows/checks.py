"""Shape checks for a workflow config, and the graph helpers the full check uses.

A config is *damaged* when it cannot be read as a workflow at all: it is not an
object, its steps or connections are not lists, a step has no id or an unknown
type, two steps share an id, or a connection lacks an end. Core refuses to save
such a config; processes runs these checks first and stops there when one fails.

Standard library only: core installs goatlib without its analytics extras, so
nothing here may import pydantic, duckdb or the tool modules.
"""

import dataclasses
from collections.abc import Iterator
from typing import Any, Literal, TypeGuard

Level = Literal["damaged", "error", "warning"]
Source = Literal["check", "run"]

NODE_TYPES: frozenset[str] = frozenset(
    {"dataset", "tool", "textAnnotation", "export", "if"}
)


@dataclasses.dataclass(frozen=True)
class Issue:
    """One problem of a workflow, in the shape the editor, Run and the AI read."""

    code: str
    level: Level
    # English, for the AI, logs and as the editor's fallback; the editor
    # translates `code` with `params`.
    message: str
    node_ids: tuple[str, ...] = ()
    # A tool input or setting name (an edge's targetHandle for inputs).
    field: str | None = None
    # `dataclasses.field`, not `field`: the attribute above shadows the name
    # inside the class body.
    params: dict[str, Any] = dataclasses.field(default_factory=dict)
    source: Source = "check"

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "level": self.level,
            "node_ids": list(self.node_ids),
            "field": self.field,
            "message": self.message,
            "params": dict(self.params),
            "source": self.source,
        }


def _is_id(value: object) -> TypeGuard[str]:
    return isinstance(value, str) and value != ""


def _damaged(
    code: str,
    message: str,
    *,
    node_ids: tuple[str, ...] = (),
    params: dict[str, Any] | None = None,
) -> Issue:
    return Issue(
        code=code,
        level="damaged",
        message=message,
        node_ids=node_ids,
        params=params or {},
    )


def _node_issues(nodes: list[Any]) -> list[Issue]:
    issues: list[Issue] = []
    seen: set[str] = set()
    duplicates: set[str] = set()
    for index, node in enumerate(nodes):
        node_id = node.get("id") if isinstance(node, dict) else None
        if not _is_id(node_id):
            issues.append(
                _damaged(
                    "node_without_id",
                    f"The step at index {index} has no id.",
                    params={"index": index},
                )
            )
            continue
        node_type = node.get("type")
        # isinstance first: a list or object as type is unhashable.
        if not isinstance(node_type, str) or node_type not in NODE_TYPES:
            shown = "" if node_type is None else str(node_type)
            issues.append(
                _damaged(
                    "node_unknown_type",
                    f'The step "{node_id}" has an unknown type "{shown}".',
                    node_ids=(node_id,),
                    params={"type": shown},
                )
            )
        if node_id not in seen:
            seen.add(node_id)
        elif node_id not in duplicates:
            duplicates.add(node_id)
            issues.append(
                _damaged(
                    "node_duplicate_id",
                    f'Several steps have the id "{node_id}".',
                    node_ids=(node_id,),
                    params={"id": node_id},
                )
            )
    return issues


def _edge_issues(edges: list[Any]) -> list[Issue]:
    return [
        _damaged(
            "edge_without_ends",
            f"The connection at index {index} has no source or target.",
            params={"index": index},
        )
        for index, edge in enumerate(edges)
        if not (
            isinstance(edge, dict)
            and _is_id(edge.get("source"))
            and _is_id(edge.get("target"))
        )
    ]


def shape_issues(config: object) -> list[Issue]:
    """The damaged issues of `config`; empty when it reads as a workflow.

    `config` is a stored config (`nodes`, `edges`, `viewport`, `variables`) or
    just `{"nodes": ..., "edges": ...}`. Empty lists are an empty workflow, not
    a damaged one. Only the shape is checked: what a step is configured to do
    is the full check's business (processes).
    """
    if not isinstance(config, dict):
        return [
            _damaged(
                "config_not_object", "The workflow configuration is not an object."
            )
        ]
    issues: list[Issue] = []
    nodes = config.get("nodes")
    if isinstance(nodes, list):
        issues.extend(_node_issues(nodes))
    else:
        issues.append(_damaged("nodes_not_list", "The workflow has no list of steps."))
    edges = config.get("edges")
    if isinstance(edges, list):
        issues.extend(_edge_issues(edges))
    else:
        issues.append(
            _damaged("edges_not_list", "The workflow has no list of connections.")
        )
    return issues


def node_list(config: dict[str, Any]) -> list[dict[str, Any]]:
    """The steps of a config for which `shape_issues` returned nothing."""
    nodes: list[dict[str, Any]] = config["nodes"]
    return list(nodes)


def _node_ids(nodes: list[dict[str, Any]]) -> list[str]:
    return [
        node["id"]
        for node in nodes
        if isinstance(node, dict) and _is_id(node.get("id"))
    ]


def find_loops(
    nodes: list[dict[str, Any]], edges: list[dict[str, Any]]
) -> list[list[str]]:
    """The steps that form a cycle, one list per cycle.

    A cycle is a strongly connected component with more than one step, or a
    step connected to itself. Ids within a cycle, and the cycles themselves,
    follow the order of `nodes`, so the answer is stable between calls.
    Connections to steps that do not exist are ignored (`dangling_edges`
    reports them). Tarjan's algorithm, iterative: a long chain of steps must
    not hit Python's recursion limit.
    """
    position: dict[str, int] = {}
    for node_id in _node_ids(nodes):
        position.setdefault(node_id, len(position))
    successors: dict[str, list[str]] = {node_id: [] for node_id in position}
    self_loops: set[str] = set()
    for edge in edges:
        if not isinstance(edge, dict):
            continue
        source, target = edge.get("source"), edge.get("target")
        if not (_is_id(source) and _is_id(target)):
            continue
        if source not in position or target not in position:
            continue
        if source == target:
            self_loops.add(source)
        else:
            successors[source].append(target)

    index_of: dict[str, int] = {}
    lowlink: dict[str, int] = {}
    stack: list[str] = []
    on_stack: set[str] = set()
    loops: list[list[str]] = []

    def visit(node_id: str) -> None:
        index_of[node_id] = lowlink[node_id] = len(index_of)
        stack.append(node_id)
        on_stack.add(node_id)

    for root in position:
        if root in index_of:
            continue
        visit(root)
        work: list[tuple[str, Iterator[str]]] = [(root, iter(successors[root]))]
        while work:
            node_id, children = work[-1]
            descended = False
            for child in children:
                if child not in index_of:
                    visit(child)
                    work.append((child, iter(successors[child])))
                    descended = True
                    break
                if child in on_stack:
                    lowlink[node_id] = min(lowlink[node_id], index_of[child])
            if descended:
                continue
            work.pop()
            if work:
                parent = work[-1][0]
                lowlink[parent] = min(lowlink[parent], lowlink[node_id])
            if lowlink[node_id] != index_of[node_id]:
                continue
            component: list[str] = []
            while True:
                member = stack.pop()
                on_stack.discard(member)
                component.append(member)
                if member == node_id:
                    break
            if len(component) > 1 or node_id in self_loops:
                loops.append(sorted(component, key=position.__getitem__))
    return sorted(loops, key=lambda loop: position[loop[0]])


def dangling_edges(
    nodes: list[dict[str, Any]], edges: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """The connections whose source or target is not one of `nodes`."""
    ids = set(_node_ids(nodes))

    def known(value: object) -> bool:
        return _is_id(value) and value in ids

    return [
        edge
        for edge in edges
        if isinstance(edge, dict)
        and not (known(edge.get("source")) and known(edge.get("target")))
    ]
