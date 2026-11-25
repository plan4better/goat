"""``map_update``: the tool that changes the map itself. On the map page only,
never over MCP.

A call is a list of operations (``assistant.maps.operations``). They are
planned on one read of the map and of what the operations need beside it
(``read_facts``: a filtered layer's fields, the outlines of an area a filter
sets, the user's card picks for a removal, and where a layer to remove is
used): every operation is checked against
the map as the operations before it leave it, and turned into the writes it
makes, the words that say what changed and the record that takes it back.
Whatever can be refused is refused there, with nothing written. A removal
the user has not picked in a card is no refusal: the plan holds the whole
call back, and the result says what to ask (``confirm``). ``apply``
then makes the writes in order, and counts a filter's features before and
after it right before its write. A write core refuses ends the call: when
nothing was written yet the call fails, and after a write landed it returns
what was applied and what failed with the undo record of what landed; a
call that ends without a result (a Stop, the answer's clock) leaves that
record from ``ToolEnv.landed``. A write core did not answer may have landed
all the same: the map is read once and compared with what was sent.

The view is the one thing the tool does not save: the views of a call go to
the page as one target in the result, and a call that only sets a view
reaches no core route.
"""

import asyncio
import copy
import json
import logging
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal
from uuid import UUID

from goatlib.style.edit import Edit, EditError, apply_edits
from pydantic import BaseModel, Field
from pydantic_ai.exceptions import ToolFailed

from assistant.asks import consented
from assistant.context import ProjectMapContext, offered_basemaps
from assistant.llm import failures
from assistant.maps.area_sources import (
    AreaFacts,
    check_outline_budget,
    read_area_sources,
)
from assistant.maps.filter_area import SetArea, layer_labels
from assistant.maps.filter_rows import AREA_REFUSED, apply_filter_ops, brief
from assistant.maps.operations import (
    AddGroup,
    FilterLayer,
    ItemRef,
    MapOp,
    MapUpdateInput,
    Move,
    RemoveGroup,
    RemoveLayer,
    RenameGroup,
    SetBasemap,
    SetGroup,
    SetLayer,
    SetScene,
    SetView,
    new_group_index,
)
from assistant.maps.state import MapRead, TreeItem, core_read, read_map
from assistant.maps.uses import layer_uses
from assistant.maps.view import (
    LOCKED,
    NO_LAYER,
    ViewTarget,
    fitted_layer,
    merged_view,
    view_target,
)
from assistant.surfaces import Surface
from assistant.tools.http import SIGN_IN_EXPIRED, ServiceError, sign_in_expired
from assistant.tools.project import (
    _COPYING,
    STILL_COPYING,
    _analytics,
    _copy_status,
    _fields,
    _Layer,
)
from assistant.tools.runtime import InputInvalid, ToolEnv, ToolSpec
from assistant.tools.styles import GET_STYLE, NO_LAYER_ACCESS, _canonical, _styles_of
from assistant.tools.workflows import open_project

logger = logging.getLogger(__name__)

#: The page of the tool.
MAP_SURFACES: frozenset[Surface] = frozenset({"project.map"})

#: Issues of a refused scene a failure lists.
MAX_LISTED_ISSUES = 5
#: The longest summary of a filter operation's rows and area.
MAX_FILTER_SUMMARY = 300
#: The longest area in words a filter operation's summary carries.
MAX_AREA_WORDS = 120

VIEWER = "The user can view this project but not change it."
NO_FIELDS = (
    "The fields of {name!r} could not be read, so its filter was not changed. "
    "Try again in a moment."
)
NO_RASTER_FILTER = "{name!r} is a raster layer, which has no filter."
NO_TABLE_AREA = "{name!r} is a table, which has no geometry an area could hold."
FILTER_NOT_SAVED = "The filter was not saved:"
REMOVED_EARLIER = (
    "operations[{index}] of this call removes layer {layer_project_id}, so no "
    "later operation can name it."
)
CONFIRM_NOTE = (
    "Nothing was changed, also not by the other operations of this call: "
    "removing a layer needs the user's pick in a card. Ask with ask_user, for "
    "each layer in confirm one single-select question with one option that "
    "carries its value and one that keeps the layer, and say in a sentence what "
    "goes with it "
    "(facts). A removed layer does not come back with the undo button; when "
    "the user may only want it out of sight, offer to hide it (set_layer with "
    "visible false). After the pick, send the call again."
)
NOT_USED = (
    "It is not used in the dashboard, a workflow, a print layout or a custom "
    "basemap."
)
IN_BUNDLE = "This layer belongs to a dataset bundle and cannot be removed on its own."
NO_BASEMAPS = "The page did not send its basemaps."
NOT_EMPTY_NOW = (
    "The group is not empty any more, so it was not removed: removing a group "
    "removes the layers in it. Read the layers again with project_get_layers."
)
NO_GROUP_ID = (
    "The group was added, but core did not answer its id, so the operations "
    "that name it were not tried and this call cannot take it back. Read the "
    "layers again with project_get_layers."
)
MAY_BE_SAVED = (
    "Core did not answer, and the map could not be read afterwards: this "
    "change may or may not have been saved. project_get_layers shows the map "
    "as it is; read it before you change the map again."
)
GONE = (
    "It is not in the project any more. Read the layers again with project_get_layers."
)
SCENE_TOO_LARGE = "The scene is too large to save. Make it smaller."
SCENE_NOT_SAVED = "The scene was not saved:"
TWO_DEEP = "Groups nest two deep at most"
STOPPED = "An unexpected error stopped the call."
REPLACED_VIEW = (
    "A later set_view of this call moves the map elsewhere, so this place is "
    "not shown."
)
REPEATED_MAP_EDIT = (
    "You made this map change earlier in this answer; this is its result "
    "again, and nothing was changed a second time."
)
FAILED_NOTE = (
    "The operations before operations[{index}] were applied and stay. "
    "operations[{index}] failed, and the operations after it were not tried: "
    "send only what is left in a new call."
)
PARTLY_NOTE = (
    "A part of operations[{index}] was applied and stays (see applied); the "
    "rest of it failed, and the operations after it were not tried: send only "
    "what is left in a new call."
)

_POSITIONS = {
    "top": "drawn on top of the basemap",
    "below_labels": "drawn below the basemap's labels",
    "below_roads": "drawn below the basemap's roads",
}


# -- the result -----------------------------------------------------------------


class AppliedOp(BaseModel):
    #: The operation's place in the call's list, from 0.
    index: int
    op: str
    layer_project_id: int | None = None
    group_id: int | None = None
    #: set_layer, set_group: the fields this operation set.
    fields: list[str] = []
    #: What changed, in plain words with the new value.
    summary: str
    #: filter only: the features the filter kept before and keeps now.
    count_before: int | None = None
    count_after: int | None = None


class FailedOp(BaseModel):
    #: The operation's place in the call's list, from 0.
    index: int
    reason: str


class Confirm(BaseModel):
    """A removal that waits for the user's pick in a card."""

    layer_project_id: int
    name: str
    #: The value of the card option that lets remove_layer remove the layer.
    value: str
    #: What goes with the layer (its styles, its filter) and where it is used.
    facts: str


class MapUpdated(BaseModel):
    project_id: UUID
    applied: list[AppliedOp]
    #: remove_layer without the user's pick: what to ask. With an entry here
    #: nothing of the call was applied.
    confirm: list[Confirm] = []
    #: The operation core refused; the ones after it were not tried.
    failed: FailedOp | None = None
    #: The view the page shows now; nothing of it is saved by the tool.
    view: ViewTarget | None = None
    note: str | None = None
    #: What takes the applied operations back, in the order they landed.
    changes: list[dict[str, Any]] = Field(default_factory=list, exclude=True)

    def undo(self) -> dict[str, Any] | None:
        """The call's undo record; None when nothing was saved (nothing
        landed, or only a view was set)."""
        if not self.changes:
            return None
        return {
            "kind": "map",
            "project_id": str(self.project_id),
            "changes": self.changes,
        }


# -- the plan -------------------------------------------------------------------

Route = Literal[
    "layer_state",
    "layer",
    "layers",
    "group_state",
    "group",
    "groups",
    "tree",
    "project",
]
#: The routes whose target is a group.
_GROUP_ROUTES = frozenset({"group_state", "group"})


@dataclass(frozen=True)
class Call:
    """One write to core, under the project's routes."""

    route: Route
    method: str
    #: The layer's number or the group's id. A group this call adds has an
    #: id below zero until core answered its own.
    target: int | None = None
    body: Any = None


@dataclass(frozen=True)
class Part:
    """One write of an operation, with what it leaves behind once it landed."""

    call: Call
    #: The undo change (contract: the ``map`` record's change objects).
    change: dict[str, Any]
    summary: str
    #: set_layer, set_group: the fields this write sets.
    fields: tuple[str, ...] = ()
    #: remove_group: the group is read again right before the write, which
    #: is not made when something is in it.
    only_if_empty: bool = False
    #: filter: the layer's dataset, whose features are counted with the
    #: query before and the query written right before the write.
    counted: str | None = None


@dataclass
class Step:
    """One operation as it will be applied."""

    index: int
    op: str
    parts: list[Part] = field(default_factory=list)
    layer_project_id: int | None = None
    #: Below zero for a group this call adds.
    group_id: int | None = None
    #: set_view: the view to hand to the page, and for a view fitted to a
    #: layer that layer's filter as the operations before it leave it.
    view: SetView | None = None
    fitted_query: Any = None
    #: The words of an operation that writes nothing.
    summary: str = ""
    count_before: int | None = None
    count_after: int | None = None
    #: remove_layer: the user has not picked the removal; the call is held
    #: back and answers this.
    confirm: Confirm | None = None


@dataclass(frozen=True)
class Facts:
    """What the plan needs beside the map, read before it."""

    #: filter: the fields (``field_kind``) of each layer an operation
    #: filters; None for a layer whose fields could not be read.
    fields: Mapping[int, Mapping[str, str] | None] = field(default_factory=dict)
    #: remove_layer: the layers the user picked to remove in a card
    #: (``removal_value``).
    picked: frozenset[int] = frozenset()
    #: remove_layer without a pick: the project's workflows and print
    #: layouts, which the answer names; None when they were not read.
    workflows: Sequence[Any] | None = None
    layouts: Sequence[Any] | None = None
    #: filter that sets an area: the outlines it is built from, by the index of
    #: the operation, or the refusal of reading them (``read_area_sources``).
    areas: AreaFacts = field(default_factory=dict)


@dataclass
class Planned:
    """Everything decided before the first write."""

    steps: list[Step]
    #: The map the plan was made on; None for a call that reads nothing.
    state: MapRead | None = None


def layer_state(state: MapRead, layer_project_id: int) -> dict[str, Any]:
    """A layer's state on the map as the map document holds it: what a key
    the document leaves out means is filled in."""
    entry = state.entry(layer_project_id) or {}
    legend = entry.get("legend")
    drawn = state.active_style_id(layer_project_id)
    return {
        "visible": entry.get("visible") is not False,
        "position": entry.get("position") or "top",
        "active_style_id": _canonical(drawn) if drawn is not None else None,
        "legend_expanded": not (
            isinstance(legend, dict) and legend.get("expanded") is False
        ),
    }


def group_state(row: Mapping[str, Any]) -> dict[str, bool]:
    """A group's state from its row: shown, and open in the layer list."""
    return {
        "visible": row.get("visible") is not False,
        "expanded": row.get("expanded") is not False,
    }


def _group_rows(state: MapRead) -> dict[int, dict[str, Any]]:
    return {
        row["id"]: row
        for row in state.groups
        if isinstance(row.get("id"), int) and not isinstance(row.get("id"), bool)
    }


def bare_query(query: Any) -> dict[str, Any] | None:
    """A layer's saved query without the keys core sends empty: what a save
    of it writes. None for no query."""
    if not isinstance(query, dict):
        return None
    return {key: value for key, value in query.items() if value is not None} or None


def stored(state: MapRead, change: Mapping[str, Any]) -> Any:
    """What the map holds now of what a change wrote, in the shape of the
    change's ``written``; None for a layer or group that is gone."""
    kind = change["object"]
    if kind == "filter":
        row = state.rows.get(change["layer_project_id"])
        return bare_query(row.get("query")) if row is not None else None
    if kind == "tree":
        return state.tree()
    if kind == "basemap":
        return state.project.get("basemap")
    if kind == "scene":
        scene = state.document.get("scene")
        return scene if isinstance(scene, dict) else None
    if kind in ("layer_state", "layer_name"):
        link = change["layer_project_id"]
        if link not in state.rows:
            return None
        if kind == "layer_name":
            return state.rows[link].get("name")
        now = layer_state(state, link)
        return {key: now[key] for key in change["written"]}
    if kind in ("group_state", "group_name"):
        row = _group_rows(state).get(change["group_id"])
        if row is None:
            return None
        if kind == "group_name":
            return row.get("name")
        return {key: group_state(row)[key] for key in change["written"]}
    raise ValueError(f"no stored value for a change of {kind}")


def _quoted(names: Mapping[Any, str]) -> str:
    return ", ".join(f"{name} ({key})" for key, name in names.items())


class _Running:
    """The map as the operations planned so far leave it."""

    def __init__(self, state: MapRead, page: ProjectMapContext, facts: Facts) -> None:
        self.state = state
        self.page = page
        self.facts = facts
        self.layers: dict[int, dict[str, Any]] = {}
        for link, row in state.rows.items():
            self.layers[link] = {
                "name": str(row.get("name") or f"layer {link}"),
                "locked": bool(row.get("locked")),
                "query": bare_query(row.get("query")),
                **layer_state(state, link),
            }
        self.groups: dict[int, dict[str, Any]] = {}
        entries = state.group_entries()
        for group_id, row in _group_rows(state).items():
            self.groups[group_id] = {
                "name": str(row.get("name") or f"group {group_id}"),
                **group_state(row),
                "bundle": row.get("bundle_id") is not None,
            }
        for group_id, entry in entries.items():
            self.groups.setdefault(
                group_id,
                {
                    "name": str(entry.get("name") or f"group {group_id}"),
                    "visible": entry.get("visible") is not False,
                    "expanded": entry.get("expanded") is not False,
                    "bundle": False,
                },
            )
        #: The tree: each parent's items, top first, and each item's parent.
        self.children: dict[int | None, list[tuple[str, int]]] = {None: []}
        self.parent: dict[tuple[str, int], int | None] = {}
        for item in state.tree():
            key = (item["type"], item["id"])
            self.children.setdefault(item["parent_id"], []).append(key)
            self.parent[key] = item["parent_id"]
            if item["type"] == "group":
                self.children.setdefault(item["id"], [])
        # A group the tree does not place stands at the top level, last.
        for group_id in self.groups:
            if ("group", group_id) not in self.parent:
                self.children[None].append(("group", group_id))
                self.children.setdefault(group_id, [])
                self.parent[("group", group_id)] = None
        basemap = state.project.get("basemap")
        self.basemap: str | None = basemap if isinstance(basemap, str) else None
        scene = state.document.get("scene")
        self.scene: dict[str, Any] | None = scene if isinstance(scene, dict) else None
        #: The groups this call adds: operation index -> the id that stands
        #: for the group until core answered its own.
        self.added: dict[int, int] = {}
        #: The layers this call removes: layer -> the operation's index.
        self.removed: dict[int, int] = {}

    def known(self, link: int) -> dict[str, Any]:
        """A layer of the project, also one the user cannot read."""
        if link in self.removed:
            raise InputInvalid(
                REMOVED_EARLIER.format(index=self.removed[link], layer_project_id=link)
            )
        layer = self.layers.get(link)
        if layer is None:
            raise InputInvalid(NO_LAYER.format(layer_project_id=link))
        return layer

    def layer(self, link: int) -> dict[str, Any]:
        """A layer of the project the user can read."""
        layer = self.known(link)
        if layer["locked"]:
            raise ToolFailed(LOCKED.format(name=layer["name"]))
        return layer

    def group(self, ref: int | str) -> int:
        """The id of the group a reference names."""
        index = new_group_index(ref)
        if index is not None:
            if index not in self.added:
                raise InputInvalid(
                    f'"new:{index}" names the group that operations[{index}] '
                    "adds, but no add_group operation stands there before "
                    "this one."
                )
            return self.added[index]
        if not isinstance(ref, int) or ref not in self.groups:
            listed = ", ".join(
                f"{key} ({group['name']})"
                for key, group in self.groups.items()
                if key > 0
            )
            raise InputInvalid(
                f"There is no group {ref} in this project. "
                + (f"Its groups are: {listed}." if listed else "It has no groups.")
            )
        return ref

    def item(self, ref: ItemRef) -> tuple[str, int]:
        """An item of the tree: a layer, or a group."""
        if ref.type == "group":
            return ("group", self.group(ref.id))
        key = ("layer", int(ref.id))
        if key not in self.parent:
            self.known(int(ref.id))
            raise InputInvalid(NO_LAYER.format(layer_project_id=ref.id))
        return key

    def name(self, key: tuple[str, int]) -> str:
        kind, item_id = key
        if kind == "group":
            return str(self.groups[item_id]["name"])
        layer = self.layers.get(item_id)
        return str(layer["name"]) if layer else f"layer {item_id}"

    def where(self, parent: int | None) -> str:
        if parent is None:
            return "at the top level"
        return f"in the group {self.groups[parent]['name']!r}"

    def items(self) -> list[TreeItem]:
        """The tree as ``MapRead.tree`` lists it: depth first, top first,
        each item's order its place among its siblings."""
        found: list[TreeItem] = []

        def walk(parent: int | None) -> None:
            for order, (kind, item_id) in enumerate(self.children.get(parent, [])):
                found.append(
                    TreeItem(
                        id=item_id,
                        type="group" if kind == "group" else "layer",
                        order=order,
                        parent_id=parent,
                    )
                )
                if kind == "group":
                    walk(item_id)

        walk(None)
        return found


def _tree_part(
    running: _Running,
    summary: str,
    *,
    before: list[TreeItem] | None = None,
    change: dict[str, Any] | None = None,
    fields: tuple[str, ...] = (),
    expanded: tuple[int, bool] | None = None,
) -> Part:
    """The write of the whole tree as the plan has it now: a move, whose
    change is the tree ``before`` and the tree written, or with ``expanded``
    one group opened or closed, whose ``change`` is the group's."""
    written = running.items()
    items: list[dict[str, Any]] = [dict(item) for item in written]
    if expanded is not None:
        group_id, value = expanded
        for item in items:
            if item["type"] == "group" and item["id"] == group_id:
                item["expanded"] = value
    return Part(
        call=Call("tree", "PUT", body={"items": items}),
        change=change or {"object": "tree", "before": before or [], "written": written},
        summary=summary,
        fields=fields,
    )


def _plan_set_layer(running: _Running, op: SetLayer, index: int) -> Step:
    link = op.layer_project_id
    layer = running.layer(link)
    name = layer["name"]
    parts: list[Part] = []
    state_fields = op.state_fields()
    if state_fields:
        said = []
        styles = _styles_of(running.state, link)
        if op.active_style_id is not None:
            if op.active_style_id not in styles:
                raise InputInvalid(
                    f"This style does not belong to {name!r}. "
                    + (
                        f"Its styles are: {_quoted(styles)}."
                        if styles
                        else "The layer has no styles."
                    )
                )
        if op.visible is not None:
            said.append("shown" if op.visible else "hidden")
        if op.position is not None:
            said.append(_POSITIONS[op.position])
        if op.active_style_id is not None:
            said.append(f"draws the style {styles[op.active_style_id]!r}")
        if op.legend_expanded is not None:
            said.append("legend open" if op.legend_expanded else "legend closed")
        written = {key: getattr(op, key) for key in state_fields}
        parts.append(
            Part(
                call=Call("layer_state", "PATCH", link, written),
                change={
                    "object": "layer_state",
                    "layer_project_id": link,
                    "before": {key: layer[key] for key in state_fields},
                    "written": written,
                },
                summary=f"{name!r}: {', '.join(said)}.",
                fields=tuple(state_fields),
            )
        )
        layer.update(written)
    if op.name is not None:
        parts.append(
            Part(
                call=Call("layer", "PUT", link, {"name": op.name}),
                change={
                    "object": "layer_name",
                    "layer_project_id": link,
                    "before": name,
                    "written": op.name,
                },
                summary=f"{name!r} is now named {op.name!r}.",
                fields=("name",),
            )
        )
        layer["name"] = op.name
    return Step(index, op.op, parts, layer_project_id=link)


def _filter_summary(
    name: str,
    query: Any,
    fields: Mapping[str, str],
    layers: Mapping[str, str] | None = None,
) -> str:
    """The rows a layer's filter holds now in words, numbered as the layer
    list numbers them, and its area in words; at most ``MAX_FILTER_SUMMARY``
    characters."""
    # A long name is shortened so the rows keep their room.
    if len(name) > 80:
        name = name[:79] + "…"
    now = brief(query, fields, layers=layers)
    if now is None:
        return f"{name!r} has no filter now: every feature is shown."
    area = ""
    if now.area is not None:
        words = now.area
        if len(words) > MAX_AREA_WORDS:
            words = words[: MAX_AREA_WORDS - 1] + "…"
        area = f" Area: {words}."
    if not now.rows:
        return f"{name!r}: the filter has no rows now.{area}"
    rows = "; ".join(
        f"{row.row}. {row.text}" + ("" if row.on else " (switched off)")
        for row in now.rows
    )
    match = "every" if now.match == "all" else "at least one"
    head = f"{name!r}: the filter's rows are now "
    tail = f" (a feature passes {match} switched-on row).{area}"
    room = max(MAX_FILTER_SUMMARY - len(head) - len(tail), 1)
    if len(rows) > room:
        rows = rows[: room - 1] + "…"
    return head + rows + tail


def _refiltered(running: _Running, link: int) -> str | None:
    """The name of a layer of the same dataset as ``link`` whose filter an
    earlier operation of the call changed: the outlines of ``features_of``
    were read under the saved filters. None when there is none."""
    rows = running.state.rows
    dataset = str(rows[link].get("layer_id"))
    for other, layer in running.layers.items():
        row = rows.get(other) or {}
        if str(row.get("layer_id")) == dataset and layer["query"] != bare_query(
            row.get("query")
        ):
            return str(layer["name"])
    return None


def _plan_filter(running: _Running, op: FilterLayer, index: int) -> Step:
    link = op.layer_project_id
    layer = running.layer(link)
    name = layer["name"]
    row = running.state.rows[link]
    if _copy_status(row) in _COPYING:
        raise ToolFailed(STILL_COPYING)
    if row.get("type") == "raster":
        raise ToolFailed(NO_RASTER_FILTER.format(name=name))
    fields = running.facts.fields.get(link)
    if fields is None:
        raise ToolFailed(NO_FIELDS.format(name=name))
    area = op.area
    sources = None
    if isinstance(area, SetArea):
        if row.get("type") == "table":
            raise ToolFailed(NO_TABLE_AREA.format(name=name))
        if area.features_of is not None:
            try:
                running.known(area.features_of.layer_project_id)
            except InputInvalid as exc:
                raise InputInvalid(f"{AREA_REFUSED}{exc.message}") from None
            refiltered = _refiltered(running, area.features_of.layer_project_id)
            if refiltered is not None:
                raise InputInvalid(
                    f"{AREA_REFUSED}an earlier operation of this call "
                    f"changes the filter of {refiltered!r}, and features_of reads "
                    "its features as the saved filter keeps them before this "
                    "call. Set this area in a new call after this one."
                )
        found = running.facts.areas.get(index)
        if isinstance(found, InputInvalid | ToolFailed):
            raise found
        if found is None:
            raise ValueError("the outlines of an area were not read")
        sources = found
    before = layer["query"]
    change = apply_filter_ops(before, op.rows, fields, area=area, sources=sources)
    written = change.query
    summary = _filter_summary(name, written, fields, layer_labels(running.state.rows))
    part = Part(
        call=Call("layer", "PUT", link, {"query": written}),
        change={
            "object": "filter",
            "layer_project_id": link,
            "before": copy.deepcopy(before),
            "written": written,
        },
        summary=" ".join((summary, *change.said)),
        counted=str(row["layer_id"]),
    )
    layer["query"] = copy.deepcopy(written)
    return Step(index, op.op, [part], layer_project_id=link)


def removal_value(layer_project_id: int) -> str:
    """The value of the card option that lets ``remove_layer`` remove a layer."""
    return f"remove_layer:{layer_project_id}"


def _how_many(number: int, word: str) -> str:
    if number == 0:
        return f"no {word}s"
    return f"{number} {word}{'s' if number > 1 else ''}"


def _goes_with(running: _Running, link: int) -> tuple[int, bool] | None:
    """What a removal takes with the layer: its named styles and whether it
    has a filter. None for a locked layer, of which core tells neither."""
    layer = running.layers[link]
    if layer["locked"]:
        return None
    return len(_styles_of(running.state, link)), brief(layer["query"], {}) is not None


def _removed_summary(name: str, goes: tuple[int, bool] | None) -> str:
    """``Removed the layer "X" with its 2 styles and its filter.``, naming
    only what the layer had, and that the undo button does not bring it back."""
    styles, filtered = goes or (0, False)
    parts = []
    if styles:
        parts.append("its style" if styles == 1 else f"its {styles} styles")
    if filtered:
        parts.append("its filter")
    went = f" with {' and '.join(parts)}" if parts else ""
    return (
        f'Removed the layer "{name}"{went}. The dock\'s undo button does not '
        "bring it back."
    )


def _removal_facts(running: _Running, link: int) -> str:
    """What goes with a layer the user has not picked to remove, and where
    it is used."""
    layer = running.layers[link]
    said = []
    goes = _goes_with(running, link)
    if goes is not None:
        styles = _how_many(goes[0], "style")
        query = "a filter" if goes[1] else "no filter"
        said.append(f'The layer "{layer["name"]}" has {styles} and {query}.')
    project = running.state.project
    uses = layer_uses(
        link,
        builder_config=project.get("builder_config"),
        workflows=running.facts.workflows,
        layouts=running.facts.layouts,
        custom_basemaps=project.get("custom_basemaps"),
    )
    said.append(uses.sentence() or NOT_USED)
    return " ".join(said)


def _plan_remove_layer(running: _Running, op: RemoveLayer, index: int) -> Step:
    link = op.layer_project_id
    layer = running.known(link)
    key = ("layer", link)
    parent = (
        running.parent[key]
        if key in running.parent
        else running.state.rows[link].get("layer_project_group_id")
    )
    if parent in running.groups and running.groups[parent]["bundle"]:
        raise ToolFailed(IN_BUNDLE)
    name = layer["name"]
    waiting = None
    if link not in running.facts.picked:
        waiting = Confirm(
            layer_project_id=link,
            name=name,
            value=removal_value(link),
            facts=_removal_facts(running, link),
        )
    goes = _goes_with(running, link)
    # Also for a removal that waits: the operations after it are checked
    # against the map without the layer.
    if key in running.parent:
        running.children[running.parent.pop(key)].remove(key)
    del running.layers[link]
    running.removed[link] = index
    if waiting is not None:
        return Step(index, op.op, layer_project_id=link, confirm=waiting)
    part = Part(
        call=Call("layers", "DELETE", link),
        change={"object": "layer_removed", "layer_project_id": link, "name": name},
        summary=_removed_summary(name, goes),
    )
    return Step(index, op.op, [part], layer_project_id=link)


def _bundle(running: _Running, group_id: int) -> InputInvalid:
    return InputInvalid(
        f"{running.groups[group_id]['name']!r} holds a bundle, whose layers "
        "stay together: no layer moves into or out of it, and no group goes "
        "into it."
    )


def _plan_move(running: _Running, op: Move, index: int) -> Step:
    key = running.item(op.item)
    kind, item_id = key
    target = running.group(op.group_id) if op.group_id is not None else None
    source = running.parent[key]
    if kind == "group" and target is not None:
        if target == item_id:
            raise InputInvalid("A group cannot be moved into itself.")
        if running.groups[target]["bundle"]:
            raise _bundle(running, target)
        if running.parent[("group", target)] is not None:
            raise InputInvalid(
                f"{TWO_DEEP}, and {running.groups[target]['name']!r} is inside "
                "a group already. Give a top-level group, or none."
            )
        if any(child == "group" for child, _ in running.children.get(item_id, [])):
            raise InputInvalid(
                f"{TWO_DEEP}, and {running.name(key)!r} holds a group itself, "
                "so it stays at the top level."
            )
    if kind == "layer" and target != source:
        for group_id in (source, target):
            if group_id is not None and running.groups[group_id]["bundle"]:
                raise _bundle(running, group_id)
    position, said = 0, "first"
    after = running.item(op.after) if op.after is not None else None
    if after is not None:
        if after == key:
            raise InputInvalid("An item cannot follow itself.")
        if running.parent[after] != target:
            raise InputInvalid(
                f"after names {running.name(after)!r}, which is not "
                f"{running.where(target)}."
            )
        said = f"after {running.name(after)!r}"
    before = running.items()
    running.children[source].remove(key)
    place = running.children.setdefault(target, [])
    if after is not None:
        position = place.index(after) + 1
    place.insert(position, key)
    running.parent[key] = target
    part = _tree_part(
        running,
        f"{running.name(key)!r} is now {said} {running.where(target)}.",
        before=before,
    )
    return Step(
        index,
        op.op,
        [part],
        layer_project_id=item_id if kind == "layer" else None,
        group_id=item_id if kind == "group" else None,
    )


def _plan_add_group(running: _Running, op: AddGroup, index: int) -> Step:
    parent = (
        running.group(op.parent_group_id) if op.parent_group_id is not None else None
    )
    if parent is not None:
        if running.groups[parent]["bundle"]:
            raise _bundle(running, parent)
        if running.parent[("group", parent)] is not None:
            raise InputInvalid(
                f"{TWO_DEEP}, and {running.groups[parent]['name']!r} is inside "
                "a group already. Give a top-level group, or none."
            )
    # Until core answers the id, the group goes by a number no group has.
    group_id = -(index + 1)
    running.added[index] = group_id
    running.groups[group_id] = {
        "name": op.name,
        "visible": True,
        "expanded": True,
        "bundle": False,
    }
    running.children.setdefault(parent, []).insert(0, ("group", group_id))
    running.children[group_id] = []
    running.parent[("group", group_id)] = parent
    body: dict[str, Any] = {"name": op.name}
    if parent is not None:
        body["parent_id"] = parent
    part = Part(
        call=Call("groups", "POST", body=body),
        change={"object": "group_added", "group_id": group_id},
        summary=f"Added the group {op.name!r} {running.where(parent)}.",
    )
    return Step(index, op.op, [part], group_id=group_id)


def _plan_rename_group(running: _Running, op: RenameGroup, index: int) -> Step:
    group_id = running.group(op.group_id)
    group = running.groups[group_id]
    part = Part(
        call=Call("group", "PUT", group_id, {"name": op.name}),
        change={
            "object": "group_name",
            "group_id": group_id,
            "before": group["name"],
            "written": op.name,
        },
        summary=f"The group {group['name']!r} is now named {op.name!r}.",
    )
    group["name"] = op.name
    return Step(index, op.op, [part], group_id=group_id)


def _plan_set_group(running: _Running, op: SetGroup, index: int) -> Step:
    group_id = running.group(op.group_id)
    group = running.groups[group_id]
    name = group["name"]
    parts: list[Part] = []

    def change(key: str, value: bool) -> dict[str, Any]:
        return {
            "object": "group_state",
            "group_id": group_id,
            "before": {key: group[key]},
            "written": {key: value},
        }

    if op.visible is not None:
        parts.append(
            Part(
                call=Call("group_state", "PATCH", group_id, {"visible": op.visible}),
                change=change("visible", op.visible),
                summary=(
                    f"The group {name!r} is {'shown' if op.visible else 'hidden'}."
                ),
                fields=("visible",),
            )
        )
        group["visible"] = op.visible
    if op.expanded is not None:
        # Core stores a group open or closed with the tree, so the whole
        # tree goes with it, in the order it has.
        parts.append(
            _tree_part(
                running,
                f"The group {name!r} is {'open' if op.expanded else 'closed'}.",
                change=change("expanded", op.expanded),
                fields=("expanded",),
                expanded=(group_id, op.expanded),
            )
        )
        group["expanded"] = op.expanded
    return Step(index, op.op, parts, group_id=group_id)


def _plan_remove_group(running: _Running, op: RemoveGroup, index: int) -> Step:
    group_id = running.group(op.group_id)
    group = running.groups[group_id]
    inside = len(running.children.get(group_id, []))
    # A layer or group whose row names the group while the map document
    # places it elsewhere or nowhere, and that no earlier operation of the
    # call moved: core deletes it with the group all the same.
    read: dict[tuple[str, int], int | None] = {
        (item["type"], item["id"]): item["parent_id"] for item in running.state.tree()
    }

    def stray(key: tuple[str, int], parent: Any) -> bool:
        now = running.parent.get(key)
        return (
            parent == group_id
            and now != group_id
            and (key not in read or now == read[key])
        )

    inside += sum(
        1
        for link, row in running.state.rows.items()
        if link in running.layers
        and stray(("layer", link), row.get("layer_project_group_id"))
    ) + sum(
        1
        for other, row in _group_rows(running.state).items()
        if other in running.groups and stray(("group", other), row.get("parent_id"))
    )
    if inside:
        raise InputInvalid(
            f"The group {group['name']!r} holds {inside} layers or groups, and "
            "a group is removed only when it is empty. Move them out first, or "
            "hide the group with set_group."
        )
    key = ("group", group_id)
    parent = running.parent.pop(key)
    order = running.children[parent].index(key)
    running.children[parent].remove(key)
    running.children.pop(group_id, None)
    del running.groups[group_id]
    part = Part(
        call=Call("group", "DELETE", group_id),
        change={
            "object": "group_removed",
            "group_id": group_id,
            "before": {"name": group["name"], "parent_id": parent, "order": order},
        },
        summary=f"Removed the empty group {group['name']!r}.",
        only_if_empty=True,
    )
    return Step(index, op.op, [part], group_id=group_id)


def _plan_set_basemap(running: _Running, op: SetBasemap, index: int) -> Step:
    offered = {basemap.id: basemap.name for basemap in offered_basemaps(running.page)}
    if not offered:
        raise ToolFailed(NO_BASEMAPS)
    if op.basemap_id not in offered:
        raise InputInvalid(
            f"{op.basemap_id!r} is not a basemap of this project. Its basemaps "
            f"are: {', '.join(f'{key} ({name})' for key, name in offered.items())}."
        )
    part = Part(
        call=Call("project", "PUT", body={"basemap": op.basemap_id}),
        change={
            "object": "basemap",
            "before": running.basemap,
            "written": op.basemap_id,
        },
        summary=f"The basemap is now {offered[op.basemap_id]!r}.",
    )
    running.basemap = op.basemap_id
    return Step(index, op.op, [part])


def _plan_set_scene(running: _Running, op: SetScene, index: int) -> Step:
    before = copy.deepcopy(running.scene)
    if op.operations is None:
        scene: dict[str, Any] | None = None
        summary = "The 3D scene is automatic now."
    else:
        edits = [
            Edit.model_validate(
                {"op": edit.op, "path": edit.path}
                | ({"value": edit.value} if edit.op == "set" else {})
            )
            for edit in op.operations
        ]
        try:
            edited = apply_edits(running.scene or {}, edits).document
        except EditError as exc:
            reason = exc.reason.replace("The document ", "The scene ", 1)
            raise InputInvalid(f"Its operations[{exc.index}]: {reason}") from None
        # Core stores an empty scene as none: automatic.
        scene = edited or None
        paths = ", ".join(edit.path for edit in op.operations)
        summary = f"The 3D scene was changed at {paths}."
    part = Part(
        call=Call("project", "PUT", body={"scene": scene}),
        change={"object": "scene", "before": before, "written": scene},
        summary=summary,
    )
    running.scene = copy.deepcopy(scene)
    return Step(index, op.op, [part])


def _number(value: float) -> str:
    return f"{value:g}"


def _plan_set_view(running: _Running | None, op: SetView, index: int) -> Step:
    said = []
    link = op.fit_layer_project_id
    query = None
    if link is not None:
        if running is None:
            raise ValueError("a view fitted to a layer needs the project's map")
        running.known(link)
        fitted_layer(running.state, link)
        said.append(f"fitted to {running.layers[link]['name']!r}")
        query = copy.deepcopy(running.layers[link]["query"])
    if op.center is not None:
        said.append(f"center {_number(op.center[0])}, {_number(op.center[1])}")
    for key in ("zoom", "pitch", "bearing"):
        value = getattr(op, key)
        if value is not None:
            said.append(f"{key} {_number(value)}")
    if op.mode is not None:
        said.append(op.mode.upper())
    if op.projection is not None:
        said.append("the globe" if op.projection == "globe" else "the flat map")
    return Step(
        index,
        op.op,
        layer_project_id=link,
        view=op,
        fitted_query=query,
        summary=f"The page shows the view: {', '.join(said)}.",
    )


_PLANNERS: dict[type, Callable[[Any, Any, int], Step]] = {
    SetLayer: _plan_set_layer,
    FilterLayer: _plan_filter,
    Move: _plan_move,
    AddGroup: _plan_add_group,
    RenameGroup: _plan_rename_group,
    SetGroup: _plan_set_group,
    RemoveGroup: _plan_remove_group,
    RemoveLayer: _plan_remove_layer,
    SetBasemap: _plan_set_basemap,
    SetScene: _plan_set_scene,
    SetView: _plan_set_view,
}


def reads_nothing(operation: MapOp) -> bool:
    """Whether an operation needs no read of the map: a view that is not
    fitted to a layer."""
    return isinstance(operation, SetView) and operation.fit_layer_project_id is None


def _at(index: int, op: str, text: str) -> str:
    return f"operations[{index}] ({op}): {text}"


def plan(
    operations: Sequence[MapOp],
    state: MapRead | None,
    page: ProjectMapContext,
    *,
    facts: Facts | None = None,
) -> Planned:
    """Every operation checked against the map as the ones before it leave
    it, and turned into its writes. Nothing is read and nothing is written.
    Raises ``InputInvalid`` for what the model can put right and
    ``ToolFailed`` for what it cannot, both naming the operation. ``state``
    may be None when no operation reads the map (``reads_nothing``);
    ``facts`` holds what was read beside the map (``read_facts``)."""
    running = _Running(state, page, facts or Facts()) if state is not None else None
    steps: list[Step] = []
    for index, operation in enumerate(operations):
        try:
            steps.append(_PLANNERS[type(operation)](running, operation, index))
        except InputInvalid as exc:
            raise InputInvalid(_at(index, operation.op, exc.message)) from None
        except ToolFailed as exc:
            raise ToolFailed(_at(index, operation.op, exc.message)) from exc
    return Planned(steps=steps, state=state)


# -- the writes -----------------------------------------------------------------


def _real(group_id: int | None, ids: Mapping[int, int]) -> int | None:
    """A group's id as core knows it: the one core answered for a group this
    call added."""
    return ids.get(group_id, group_id) if group_id is not None else None


def _answered(group_id: int | None, ids: Mapping[int, int]) -> int | None:
    """A group's id for the result; None while core has not answered it."""
    real = _real(group_id, ids)
    return real if real is not None and real > 0 else None


def _real_items(items: Any, ids: Mapping[int, int]) -> list[dict[str, Any]]:
    return [
        {
            **item,
            "id": _real(item["id"], ids) if item["type"] == "group" else item["id"],
            "parent_id": _real(item["parent_id"], ids),
        }
        for item in items
    ]


def _request(call: Call, ids: Mapping[int, int]) -> tuple[str, Any]:
    """The path after the project's and the body of a call, with the ids
    core answered in place of the groups this call added."""
    target = _real(call.target, ids) if call.route in _GROUP_ROUTES else call.target
    body = call.body
    if call.route == "layer_state":
        return f"/layer/{target}/map-state", body
    if call.route == "layers":
        return "/layer", body
    if call.route == "layer":
        return f"/layer/{target}", body
    if call.route == "group_state":
        return f"/group/{target}/map-state", body
    if call.route == "group":
        return f"/group/{target}", body
    if call.route == "groups":
        if "parent_id" in body:
            body = {**body, "parent_id": _real(body["parent_id"], ids)}
        return "/group", body
    if call.route == "tree":
        return "/layer-tree", {"items": _real_items(body["items"], ids)}
    return "", body


def _real_change(change: dict[str, Any], ids: Mapping[int, int]) -> dict[str, Any]:
    found = dict(change)
    if "group_id" in found:
        found["group_id"] = _real(found["group_id"], ids)
    if found["object"] == "tree":
        found["before"] = _real_items(found["before"], ids)
        found["written"] = _real_items(found["written"], ids)
    if found["object"] == "group_removed":
        before = found["before"]
        found["before"] = {**before, "parent_id": _real(before["parent_id"], ids)}
    return found


#: The changes whose state is one value, and those whose state is the fields
#: an operation set.
_WHOLE = frozenset({"tree", "scene", "basemap", "layer_name", "group_name", "filter"})
_FIELDS = frozenset({"layer_state", "group_state"})


def _record(changes: list[dict[str, Any]], change: dict[str, Any]) -> None:
    """Adds a landed change. Changes of one thing that follow each other are
    one: the first state before, the last state written."""
    last = changes[-1] if changes else None
    if (
        last is not None
        and last["object"] == change["object"]
        and last.get("layer_project_id") == change.get("layer_project_id")
        and last.get("group_id") == change.get("group_id")
    ):
        if change["object"] in _WHOLE:
            last["written"] = change["written"]
            return
        if change["object"] in _FIELDS:
            last["before"] = {**change["before"], **last["before"]}
            last["written"] = {**last["written"], **change["written"]}
            return
    changes.append(change)


def _code(exc: ServiceError) -> str | None:
    detail = exc.body.get("detail") if isinstance(exc.body, dict) else None
    code = detail.get("code") if isinstance(detail, dict) else None
    return code if isinstance(code, str) else None


#: The beginnings of core's refusals of a filter (``query_save_errors``).
_FILTER_REFUSALS = ("Invalid CQL query", "The filter's ui notes")


def _refused_filter(detail: str) -> str | None:
    """Core's refusal of a filter in one sentence, from its own words or from
    the validation error core wraps them in; None for any other refusal."""
    flat = " ".join(detail.split())
    starts = [flat.find(start) for start in _FILTER_REFUSALS if start in flat]
    if not starts:
        return None
    said = flat[min(starts) :]
    # A validation error goes on with its type and a link after the message.
    return said.split(" [type=", 1)[0]


def _in_words(exc: ToolFailed) -> str:
    """Core's refusal of a write in plain words; any other failure in its own."""
    if not isinstance(exc, ServiceError):
        return exc.message
    if sign_in_expired(exc):
        return SIGN_IN_EXPIRED
    code = _code(exc)
    # Core answers a user who may view the project 403 `forbidden` on the
    # map-state routes, and 401 on its other writes, whose authorization
    # answers 401 for every refusal.
    if exc.status == 401 or (exc.status == 403 and code == "forbidden"):
        return VIEWER
    if exc.status == 403:
        return NO_LAYER_ACCESS
    if exc.status == 404:
        return GONE
    if exc.status == 409 and "bundle" in exc.detail.lower():
        return IN_BUNDLE
    if exc.status == 422 and code == "scene_too_large":
        return SCENE_TOO_LARGE
    if exc.status == 422 and code == "invalid_scene":
        issues = exc.issues or []
        listed = [
            f"{issue.get('path')}: {issue.get('message')}"
            for issue in issues[:MAX_LISTED_ISSUES]
        ]
        if len(issues) > MAX_LISTED_ISSUES:
            listed.append(
                f"{len(issues) - MAX_LISTED_ISSUES} more issues are not listed."
            )
        return " ".join((SCENE_NOT_SAVED, *listed))
    refused_filter = _refused_filter(exc.detail) if exc.status == 422 else None
    if refused_filter is not None:
        return f"{FILTER_NOT_SAVED} {refused_filter}"
    if exc.status == 422 and code == "style_not_on_layer":
        return "This style does not belong to the layer any more."
    if exc.status == 400 and "nesting" in exc.detail.lower():
        return f"{TWO_DEEP}."
    return exc.message


async def _still_empty(env: ToolEnv, base: str, group_id: int | None) -> None:
    """Refuses when the group holds something now. Core removes a group with
    the layers in it, and what the plan read may be out of date."""
    rows, groups = await asyncio.gather(
        env.call("core", "GET", f"{base}/layer"),
        env.call("core", "GET", f"{base}/group"),
    )
    if any(row.get("layer_project_group_id") == group_id for row in rows or []) or any(
        group.get("parent_id") == group_id for group in groups or []
    ):
        raise ToolFailed(NOT_EMPTY_NOW)


#: The statuses a proxy in front of core answers when core's own answer is
#: lost; core's own refusals carry a code.
_GATEWAY = frozenset({502, 503, 504})


class _NotApplied(Exception):  # noqa: N818
    """A write that was not made, or whose outcome is not known: ``reason``
    in plain words, ``cause`` the failure it came from."""

    def __init__(self, reason: str, cause: ToolFailed) -> None:
        super().__init__(reason)
        self.reason = reason
        self.cause = cause


def _landed(
    part: Part, state: MapRead, ids: Mapping[int, int], known: set[int]
) -> dict[str, Any] | None:
    """Whether the map holds what a write sent: what stands for core's
    answer when it does, None when it does not. ``known`` are the groups
    that existed before the write."""
    change = _real_change(part.change, ids)
    groups = _group_rows(state)
    if change["object"] == "group_added":
        parent = _real(part.call.body.get("parent_id"), ids)
        added = [
            group_id
            for group_id, row in groups.items()
            if group_id not in known
            and row.get("name") == part.call.body["name"]
            and row.get("parent_id") == parent
        ]
        return {"id": max(added)} if added else None
    if change["object"] == "group_removed":
        return None if _real(part.call.target, ids) in groups else {}
    if change["object"] == "filter" and change["layer_project_id"] not in state.rows:
        return None
    if change["object"] == "layer_removed":
        return None if change["layer_project_id"] in state.rows else {}
    try:
        return {} if stored(state, change) == change["written"] else None
    except ValueError:
        return None


async def _write(
    env: ToolEnv, project_id: UUID, part: Part, ids: Mapping[int, int], known: set[int]
) -> Any:
    """Core's answer to one write. A write core refused raises
    ``_NotApplied`` with the refusal in plain words. A write without an
    answer (core did not answer in time, the connection dropped, a gateway
    in front of core answered for it) may have
    landed all the same: the map is read once, and when it holds what was
    sent, that stands for the answer; when it does not, the write failed as
    it did; when the read fails too, the outcome is not known."""
    base = f"/api/v2/project/{project_id}"
    try:
        if part.only_if_empty:
            await _still_empty(env, base, _real(part.call.target, ids))
    except ToolFailed as exc:
        raise _NotApplied(_in_words(exc), exc) from exc
    path, body = _request(part.call, ids)
    # Core takes the layer to remove as a query parameter.
    params = (
        {"layer_project_id": part.call.target} if part.call.route == "layers" else None
    )
    try:
        return await env.call(
            "core", part.call.method, base + path, params=params, json_body=body
        )
    except ServiceError as exc:
        if exc.status not in _GATEWAY or _code(exc) is not None:
            raise _NotApplied(_in_words(exc), exc) from exc
        lost: ToolFailed = exc
    except ToolFailed as exc:
        lost = exc
    try:
        state = await read_map(env, project_id)
    except ToolFailed:
        raise _NotApplied(MAY_BE_SAVED, lost) from lost
    answer = _landed(part, state, ids, known)
    if answer is None:
        raise _NotApplied(_in_words(lost), lost) from lost
    return answer


async def _count(env: ToolEnv, collection: str, query: Any) -> int:
    cql = query.get("cql") if isinstance(query, dict) else None
    result = await _analytics(
        env,
        "feature-count",
        {
            "collection": collection,
            "filter": json.dumps(cql) if isinstance(cql, dict) and cql else None,
        },
    )
    count = result.get("count") if isinstance(result, dict) else None
    if not isinstance(count, int) or isinstance(count, bool):
        raise ValueError("feature-count answered without a count")
    return count


async def _counts(env: ToolEnv, part: Part) -> tuple[int | None, int | None]:
    """The features a filter write keeps before and after it, counted at
    once; both None when either count fails, which never stops the write."""
    assert part.counted is not None
    try:
        before, after = await asyncio.gather(
            _count(env, part.counted, part.change["before"]),
            _count(env, part.counted, part.change["written"]),
        )
    except Exception:
        logger.info("map_update could not count a filter's features", exc_info=True)
        return None, None
    return before, after


async def apply(env: ToolEnv, planned: Planned) -> MapUpdated:
    """Makes the plan's writes in order. A write that fails before any landed
    fails the call; after that the call ends there and returns what was
    applied, what failed and the record that takes the applied part back. A
    write without an answer is read back first (``_write``). A filter's
    features are counted right before its write (``_counts``)."""
    project_id = open_project(env)
    waiting = [step.confirm for step in planned.steps if step.confirm is not None]
    if waiting:
        return MapUpdated(
            project_id=project_id, applied=[], confirm=waiting, note=CONFIRM_NOTE
        )
    # Before the first write: a view fitted to a layer reads, and can fail.
    targets: dict[int, ViewTarget] = {}
    for step in planned.steps:
        if step.view is not None:
            try:
                targets[step.index] = await view_target(
                    env, step.view, planned.state, step.fitted_query
                )
            except ToolFailed as exc:
                raise ToolFailed(_at(step.index, step.op, exc.message)) from exc

    applied: list[AppliedOp] = []
    views: list[AppliedOp] = []
    changes: list[dict[str, Any]] = []
    #: The ids core answered for the groups this call added.
    ids: dict[int, int] = {}
    #: The groups there were before the call.
    before = set(_group_rows(planned.state)) if planned.state is not None else set()
    shown: list[ViewTarget] = []
    failed: FailedOp | None = None
    landed = False
    partly = False
    # A Stop or the answer's clock can end the call after a write landed:
    # the record follows ``changes`` as the writes land.
    env.landed.keep(
        lambda: MapUpdated(project_id=project_id, applied=[], changes=changes).undo()
    )
    for step in planned.steps:
        done: list[Part] = []
        for part in step.parts:
            if part.counted is not None:
                step.count_before, step.count_after = await _counts(env, part)
            try:
                reply = await _write(
                    env, project_id, part, ids, before | set(ids.values())
                )
            except _NotApplied as stopped:
                reason = stopped.reason
                if not landed:
                    whole = reason in (VIEWER, SIGN_IN_EXPIRED)
                    raise ToolFailed(
                        reason if whole else _at(step.index, step.op, reason)
                    ) from stopped.cause
                # Core's words can quote the request: masked as every error is.
                failed = FailedOp(
                    index=step.index, reason=failures.redact(reason, env.secrets())
                )
                break
            except Exception:
                if not landed:
                    raise
                logger.exception("map_update stopped after a write landed")
                failed = FailedOp(index=step.index, reason=STOPPED)
                break
            landed = True
            done.append(part)
            if step.op == "add_group" and step.group_id is not None:
                new_id = reply.get("id") if isinstance(reply, dict) else None
                if not isinstance(new_id, int) or isinstance(new_id, bool):
                    failed = FailedOp(index=step.index, reason=NO_GROUP_ID)
                    break
                ids[step.group_id] = new_id
            _record(changes, _real_change(part.change, ids))
        if step.view is not None:
            shown.append(targets[step.index])
            views.append(
                AppliedOp(
                    index=step.index,
                    op=step.op,
                    layer_project_id=step.layer_project_id,
                    summary=step.summary,
                )
            )
            applied.append(views[-1])
        elif done:
            applied.append(
                AppliedOp(
                    index=step.index,
                    op=step.op,
                    layer_project_id=step.layer_project_id,
                    group_id=_answered(step.group_id, ids),
                    fields=[name for part in done for name in part.fields],
                    summary=" ".join(part.summary for part in done),
                    count_before=step.count_before,
                    count_after=step.count_after,
                )
            )
            partly = failed is not None
        if failed is not None:
            break
    # A place a later view of the call replaces is said so in its summary.
    for n, (said, target) in enumerate(zip(views, shown, strict=True)):
        later = shown[n + 1 :]
        if (target.bbox is not None or target.camera is not None) and any(
            other.bbox is not None
            or (other.camera is not None and target.bbox is not None)
            for other in later
        ):
            said.summary = f"{said.summary} {REPLACED_VIEW}"
    note = None
    if failed is not None:
        note = (PARTLY_NOTE if partly else FAILED_NOTE).format(index=failed.index)
    return MapUpdated(
        project_id=project_id,
        applied=applied,
        failed=failed,
        view=merged_view(shown),
        note=note,
        changes=changes,
    )


async def read_facts(
    env: ToolEnv, project_id: UUID, state: MapRead, operations: Sequence[MapOp]
) -> Facts:
    """What the plan needs beside the map, read at once: the fields of each
    layer a filter operation names (only a layer whose data the user can
    read and that has fields reaches geoapi; the plan refuses the others),
    the removals the user picked in a card, and for a removal without a pick
    the project's workflows and print layouts, and the outlines of each
    area a filter operation sets (``read_area_sources``)."""
    filtered = {op.layer_project_id for op in operations if isinstance(op, FilterLayer)}
    readable = [
        link
        for link in sorted(filtered)
        if (row := state.rows.get(link)) is not None
        and not row.get("locked")
        and _copy_status(row) not in _COPYING
        and row.get("type") in ("feature", "table")
        and row.get("layer_id")
    ]

    async def fields_of(link: int) -> Mapping[str, str] | None:
        row = state.rows[link]
        layer = _Layer(
            project_id,
            link,
            str(row["layer_id"]),
            str(row.get("name") or ""),
            row.get("feature_layer_geometry_type"),
        )
        try:
            return await _fields(env, layer)
        # A refused or unreadable answer.
        except (ToolFailed, KeyError, AttributeError, TypeError):
            return None

    removed = [op.layer_project_id for op in operations if isinstance(op, RemoveLayer)]
    picked = frozenset(
        link for link in removed if consented(env.asks, removal_value(link))
    )
    # A removal without a pick is refused with where the layer is used.
    asking = any(link not in picked and link in state.rows for link in removed)

    async def listed(path: str) -> Sequence[Any] | None:
        if not asking:
            return None
        try:
            found = await core_read(env, f"/{project_id}/{path}")
        except ToolFailed:
            return None
        return found if isinstance(found, list) else None

    found, workflows, layouts, areas = await asyncio.gather(
        asyncio.gather(*map(fields_of, readable)),
        listed("workflow"),
        listed("report-layout"),
        read_area_sources(env, project_id, state, operations),
    )
    return Facts(
        fields=dict(zip(readable, found, strict=True)),
        picked=picked,
        workflows=workflows,
        layouts=layouts,
        areas=areas,
    )


async def _update_map(env: ToolEnv, args: MapUpdateInput) -> MapUpdated:
    project_id = open_project(env)
    page = env.page
    if not isinstance(page, ProjectMapContext):
        raise ToolFailed("The map can only be changed on a project's Map page.")
    # A call that only sets a view reaches no core route: the view is the
    # user's own, also for a user who may only view the project.
    if all(reads_nothing(operation) for operation in args.operations):
        return await apply(env, plan(args.operations, None, page))
    check_outline_budget(args.operations)
    state = await read_map(env, project_id)
    facts = await read_facts(env, project_id, state, args.operations)
    if facts.areas:
        # Building an area simplifies outlines, which takes time: off the
        # event loop.
        planned = await asyncio.to_thread(
            plan, args.operations, state, page, facts=facts
        )
    else:
        planned = plan(args.operations, state, page, facts=facts)
    updated = await apply(env, planned)
    # The card that asks for these values is no repeat of an earlier card
    # whose answer the tool cannot take (``ToolEnv.confirm_values``).
    env.confirm_values.update(item.value for item in updated.confirm)
    return updated


#: The tools whose results in the answer a map change can make stale.
_INVALIDATES = frozenset(
    {
        "project_get_layers",
        GET_STYLE.wire_name,
        "map_update",
        "project_count_features",
        "project_field_statistics",
        "project_group_statistics",
        "project_area_statistics",
        "project_sample_features",
        "style_update",
    }
)


def _made_stale(result: dict[str, Any]) -> frozenset[str]:
    """What a returned map change made stale: a style edit only after a
    change of what a style call does (a layer's active style, its filter, which
    the legend numbers count under, or the layer itself); every other tool of
    ``_INVALIDATES`` always."""
    applied = result.get("applied")
    styles = any(
        isinstance(op, dict)
        and (
            op.get("op") in ("filter", "remove_layer")
            or (
                op.get("op") == "set_layer"
                and "active_style_id" in (op.get("fields") or [])
            )
        )
        for op in (applied if isinstance(applied, list) else [])
    )
    return _INVALIDATES if styles else _INVALIDATES - {"style_update"}


MAP_UPDATE: ToolSpec[MapUpdateInput, MapUpdated] = ToolSpec(
    name="map.update",
    description=(
        "Change what the map of the open project shows. One call takes a list "
        "of operations, applied in order: set_layer (show or hide a layer, its "
        "position against the basemap, which of its named styles the map "
        "draws, its legend, its name), filter (a layer's saved filter, row by "
        "row, with the row numbers project_get_layers shows; put every row "
        "change of a layer in one filter operation, whose row numbers all name "
        "the rows as read: a filter change renumbers the rows, so read the "
        "layers again before the next one; area beside rows limits it to "
        "inside or outside regions from catalog_find_region, features of "
        "another polygon layer or the current view), move (the order of layers and "
        "groups, into and out of groups), add_group, rename_group, set_group, "
        "remove_group (an empty group), remove_layer (call it first, before "
        "any card: it is applied only after the user's pick in a card, and a "
        "call without it changes nothing and answers confirm, which says what "
        "to ask), "
        "set_basemap, set_scene (the 3D scene) and set_view (the camera, 2D or 3D, the projection). Every operation "
        "is checked against the map before the first change, and one that "
        "does not fit refuses the whole call with nothing changed. After that "
        "the operations stop at the first one the server refuses: the result "
        "lists what was applied (applied, each with its index and what "
        "changed) and the operation that failed (failed, with its index and "
        "the reason); the ones after it were not tried. Indexes name an "
        "operation by its place in operations, counting from 0. A view change "
        "is not saved: the page moves the map for this user only. To take a "
        "layer out of sight, hide it (visible false) rather than remove it: "
        "remove only when the user says remove or delete. "
        "The user can take the changes back with the dock's undo button, "
        "except the view, which is the user's own to move back, and a removed "
        "layer, which the undo button does not bring back."
    ),
    input_model=MapUpdateInput,
    output_model=MapUpdated,
    run=_update_map,
    surfaces=MAP_SURFACES,
    risk="write",
    scope="goat:write",
    repeatable=REPEATED_MAP_EDIT,
    # The layer list and a style's read show the map's state, the filtered
    # reads count under the saved filters (as_drawn), a style edit names the
    # active style it edits (stale only after a change of it, ``_made_stale``),
    # and an earlier change made again after this one is a new change, not a
    # repeat.
    invalidates=_INVALIDATES,
    stale=_made_stale,
    # Whatever the earlier call named: the map changed.
    same=frozenset(),
)

MAP_TOOLS: tuple[ToolSpec[Any, Any], ...] = (MAP_UPDATE,)
"""The tools that change the map itself."""
