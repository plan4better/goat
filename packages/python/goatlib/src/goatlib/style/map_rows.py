"""The map document (spec 10) from plain rows, and the layers it draws.

Pure: core assembles the live map request, publishing and the data migration
with it; the thumbnail task draws a project in the same order.
"""

from typing import Any, NamedTuple
from uuid import UUID

#: Named styles per project layer (spec 10).
MAX_STYLES = 10


def map_view(
    state: dict[str, Any] | None, bounds: list[float] | None
) -> dict[str, Any]:
    """`user_project.initial_view_state` as the map document's view."""
    view: dict[str, Any] = {}
    if (
        state
        and state.get("longitude") is not None
        and state.get("latitude") is not None
    ):
        view["center"] = [state["longitude"], state["latitude"]]
    for key in ("zoom", "pitch", "bearing"):
        if state and state.get(key) is not None:
            view[key] = state[key]
    if bounds and len(bounds) == 4:
        view["bounds"] = list(bounds)
    return view


def layer_filter(query: Any) -> dict[str, Any] | None:
    """The layer's CQL2 filter: today's `{"cql": ...}` or the CQL2 itself."""
    if not isinstance(query, dict):
        return None
    cql = query.get("cql") if "cql" in query else query
    return cql if isinstance(cql, dict) and cql.get("op") else None


class GroupRow(NamedTuple):
    id: int
    name: str
    parent_id: int | None
    order: int
    visible: bool
    expanded: bool


class LayerRow(NamedTuple):
    id: int
    group_id: int | None
    order: int
    visible: bool
    position: str
    query: Any
    time_value: Any
    legend_expanded: bool
    style_id: UUID | None


def build_map_document(
    *,
    basemap: str | None,
    locale: str | None,
    view_state: dict[str, Any] | None,
    bounds: list[float] | None,
    groups: list[GroupRow],
    layers: list[LayerRow],
) -> dict[str, Any]:
    """The map document (spec 10) from plain rows: the one assembly path of the
    live map request, publishing and the data migration (from a published
    snapshot). Order is the list order, top first (ascending `order`, groups and
    layers sharing one order per parent); defaults stay out of the entries."""
    children: dict[int | None, list[tuple[int, int, int, dict[str, Any]]]] = {}
    group_ids = {g.id for g in groups}
    for row in layers:
        parent = row.group_id if row.group_id in group_ids else None
        children.setdefault(parent, []).append(
            (row.order, 1, row.id, _layer_entry(row))
        )
    for g in groups:
        parent = (
            g.parent_id if g.parent_id in group_ids and g.parent_id != g.id else None
        )
        entry: dict[str, Any] = {
            "type": "group",
            "id": g.id,
            "name": g.name,
            "visible": g.visible,
        }
        if not g.expanded:
            entry["expanded"] = False
        children.setdefault(parent, []).append((g.order, 0, g.id, entry))

    def tree(parent: int | None, seen: frozenset[int]) -> list[dict[str, Any]]:
        out = []
        for _, _, item_id, item in sorted(
            children.get(parent, []), key=lambda c: c[:3]
        ):
            if item["type"] == "group":
                if item_id in seen:
                    continue
                item = {**item, "children": tree(item_id, seen | {item_id})}
            out.append(item)
        return out

    document: dict[str, Any] = {"version": 1}
    if basemap:
        document["basemap"] = {"id": basemap}
    view = map_view(view_state, bounds)
    if view:
        document["view"] = view
    if locale:
        document["locale"] = locale
    document["layers"] = tree(None, frozenset())
    return document


def _layer_entry(row: LayerRow) -> dict[str, Any]:
    entry: dict[str, Any] = {"type": "layer", "id": row.id, "visible": row.visible}
    if row.style_id is not None:
        entry["style"] = str(row.style_id)
    if row.position != "top":
        entry["position"] = row.position
    cql = layer_filter(row.query)
    if cql:
        entry["filter"] = cql
    if row.time_value is not None:
        entry["time"] = {"value": row.time_value}
    if not row.legend_expanded:
        entry["legend"] = {"expanded": False}
    return entry


def drawn_layers(document: dict[str, Any]) -> list[dict[str, Any]]:
    """The layer entries a map shows, top first: visible, in visible groups."""
    out: list[dict[str, Any]] = []

    def walk(items: list[dict[str, Any]]) -> None:
        for item in items:
            if not item.get("visible", True):
                continue
            if item.get("type") == "group":
                walk(item.get("children") or [])
            else:
                out.append(item)

    walk(document.get("layers") or [])
    return out
