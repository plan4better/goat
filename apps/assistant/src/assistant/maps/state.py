"""A project's map as core stores it, read with the user's sign-in.

`read_map` reads the project row, its layer rows, its groups and the map
document (`GET /project/{id}/map`) together. The map document holds the tree
the layer panel shows (groups with `children`, top first) and each layer's
visibility, position and drawn style; the layer rows hold names, types and
filters, in the project's layer order, which is not the tree's.
"""

import asyncio
from dataclasses import dataclass
from typing import Any, Literal, TypedDict
from uuid import UUID

from pydantic_ai.exceptions import ToolFailed

from assistant.tools.http import SIGN_IN_EXPIRED, ServiceError, sign_in_expired
from assistant.tools.runtime import ToolEnv

NO_PROJECT = "The project does not exist or the user cannot open it."


async def core_read(env: ToolEnv, path: str) -> Any:
    """``GET /api/v2/project{path}`` with the user's sign-in."""
    try:
        return await env.call("core", "GET", f"/api/v2/project{path}")
    except ServiceError as exc:
        if sign_in_expired(exc):
            raise ToolFailed(SIGN_IN_EXPIRED) from exc
        # Core's authorization answers 401 for "no access" too.
        if exc.status in (401, 403, 404):
            raise ToolFailed(NO_PROJECT) from exc
        raise


class TreeItem(TypedDict):
    id: int
    type: Literal["layer", "group"]
    #: The place among its siblings, 0 on top.
    order: int
    parent_id: int | None


@dataclass(frozen=True)
class MapRead:
    #: The project row.
    project: dict[str, Any]
    #: The layer rows by layer_project_id, in core's order (the project's
    #: layer order).
    rows: dict[int, dict[str, Any]]
    groups: list[dict[str, Any]]
    #: The map document.
    document: dict[str, Any]
    #: Per layer_project_id ``{"active": <the drawn style, whole>, "others":
    #: [{id, name}]}``; a locked layer has none.
    styles: dict[int, dict[str, Any]]

    def tree(self) -> list[TreeItem]:
        """Every layer and group of the document's tree, depth first, top
        first: a group comes before its children."""
        items: list[TreeItem] = []

        def walk(entries: Any, parent: int | None) -> None:
            for order, entry in enumerate(_entries(entries)):
                kind = entry.get("type")
                if kind not in ("layer", "group"):
                    continue
                items.append(
                    TreeItem(id=entry["id"], type=kind, order=order, parent_id=parent)
                )
                if kind == "group":
                    walk(entry.get("children"), entry["id"])

        walk(self.document.get("layers"), None)
        return items

    def entry(self, layer_project_id: int) -> dict[str, Any] | None:
        """The layer's entry in the document's tree."""

        def find(entries: Any) -> dict[str, Any] | None:
            for entry in _entries(entries):
                if entry.get("type") == "group":
                    found = find(entry.get("children"))
                    if found is not None:
                        return found
                elif entry.get("id") == layer_project_id:
                    return entry
            return None

        return find(self.document.get("layers"))

    def group_entries(self) -> dict[int, dict[str, Any]]:
        """Every group's entry in the document's tree, by id."""
        found: dict[int, dict[str, Any]] = {}

        def walk(entries: Any) -> None:
            for entry in _entries(entries):
                if entry.get("type") == "group":
                    found[entry["id"]] = entry
                    walk(entry.get("children"))

        walk(self.document.get("layers"))
        return found

    def active_style_id(self, layer_project_id: int) -> str | None:
        """The id of the style the map draws for the layer."""
        entry = self.entry(layer_project_id)
        if entry is not None and isinstance(entry.get("style"), str):
            return str(entry["style"])
        active = (self.styles.get(layer_project_id) or {}).get("active")
        style_id = active.get("id") if isinstance(active, dict) else None
        return str(style_id) if style_id is not None else None


def _entries(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [
        entry
        for entry in value
        if isinstance(entry, dict) and isinstance(entry.get("id"), int)
    ]


#: The four reads of a project's map, as paths after the project's own: the
#: project row, its layer rows, its groups and the map document.
MAP_READS = ("", "/layer", "/group", "/map")


async def read_map(env: ToolEnv, project_id: UUID) -> MapRead:
    """The project's map; refuses a project the user cannot open as
    ``core_read`` does."""
    return map_read(
        *await asyncio.gather(
            *(core_read(env, f"/{project_id}{path}") for path in MAP_READS)
        )
    )


def map_read(project: Any, rows: Any, groups: Any, reply: Any) -> MapRead:
    """The map from core's answers to the four reads (``MAP_READS``), in
    their order."""
    reply = reply if isinstance(reply, dict) else {}
    document = reply.get("map")
    styles = reply.get("styles")
    return MapRead(
        project=project if isinstance(project, dict) else {},
        rows={row["id"]: row for row in rows or []},
        groups=list(groups or []),
        document=document if isinstance(document, dict) else {},
        styles={
            int(key): value
            for key, value in (styles if isinstance(styles, dict) else {}).items()
            if str(key).isdigit() and isinstance(value, dict)
        },
    )
