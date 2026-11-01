"""Workflow configs as the editor stores them: steps (nodes) with their
settings, and connections (edges) into a named input of the next step."""

import json
from typing import Any

from .world import WORLD

_AT = {"x": 0, "y": 0}


def dataset(
    node_id: str, link_id: int, row_filter: dict[str, Any] | None = None
) -> dict[str, Any]:
    """A dataset step on a layer of the world, through its project entry."""
    layer = WORLD[link_id]
    data: dict[str, Any] = {
        "type": "dataset",
        "label": layer.name,
        "projectLayerId": link_id,
        "layerId": layer.layer_id,
        "layerName": layer.name,
        "geometryType": layer.geometry,
        "layerType": "feature",
    }
    if row_filter is not None:
        data["filter"] = row_filter
    return {"id": node_id, "type": "dataset", "position": _AT, "data": data}


def where(attribute: str, expression: str, value: Any) -> dict[str, Any]:
    """A condition in the editor's terms (`is`, `is_at_least`, ...)."""
    return {
        "type": "logical",
        "attribute": attribute,
        "expression": expression,
        "value": value,
    }


def area(west: float, south: float, east: float, north: float) -> dict[str, Any]:
    """An area condition: the features that intersect the box."""
    ring = [[west, south], [east, south], [east, north], [west, north], [west, south]]
    polygon = {"type": "Polygon", "coordinates": [ring]}
    return {
        "type": "spatial",
        "attribute": "geom",
        "expression": "s_intersects",
        "value": json.dumps(polygon),
    }


def keep(*conditions: dict[str, Any]) -> dict[str, Any]:
    """A dataset's filter: every condition holds."""
    return {
        "op": "and",
        "expressions": [{"id": f"c{i}", **c} for i, c in enumerate(conditions)],
    }


def tool(node_id: str, process_id: str, **config: Any) -> dict[str, Any]:
    """A tool step with only the settings given, as the assistant leaves the rest."""
    return {
        "id": node_id,
        "type": "tool",
        "position": _AT,
        "data": {
            "type": "tool",
            "processId": process_id,
            "label": node_id,
            "status": "idle",
            "config": config,
        },
    }


def statistic(method: str, operator: str, value: float) -> dict[str, Any]:
    """An If condition on the whole input layer, such as `count > 3`."""
    return {"kind": "statistic", "method": method, "operator": operator, "value": value}


def if_step(node_id: str, *conditions: dict[str, Any]) -> dict[str, Any]:
    """An If step whose conditions must all hold for its "true" output."""
    return {
        "id": node_id,
        "type": "if",
        "position": _AT,
        "data": {
            "type": "if",
            "label": node_id,
            "mode": "simple",
            "condition": {"op": "and", "expressions": list(conditions)},
        },
    }


def export(node_id: str, name: str) -> dict[str, Any]:
    """An export step that saves its input as a new layer called `name`."""
    return {
        "id": node_id,
        "type": "export",
        "position": _AT,
        "data": {
            "type": "export",
            "label": name,
            "datasetName": name,
            "addToProject": True,
            "overwritePrevious": False,
        },
    }


def edge(
    source: str, target: str, handle: str = "input_layer_id", branch: str | None = None
) -> dict[str, Any]:
    """A connection into `handle` of `target`; `branch` is the If output it
    leaves from ("true" or "false")."""
    return {
        "id": f"{source}-{target}-{handle}",
        "source": source,
        "target": target,
        "sourceHandle": branch,
        "targetHandle": handle,
    }


def into_export(source: str, target: str) -> dict[str, Any]:
    """The connection from a step into an export."""
    return edge(source, target, "input")


def workflow(
    nodes: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    variables: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {"nodes": nodes, "edges": edges, "variables": variables or []}
