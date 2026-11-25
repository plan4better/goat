"""The dock's Undo of an answer's map changes.

``map_update`` keeps in its audit row (``tool_call.undo``, kind ``map``) what
each landed write changed: the state before and the state written. Core keeps
no revisions of the map, so the Undo compares. It reads the map once, takes
the answer's changes of one thing together (the oldest state before, the
newest state written), and then, thing by thing:

- the map holds the state before already: nothing to do (an Undo that
  stopped half way goes on from there);
- the map still holds what the answer wrote: the state before is written;
- the map holds something else, so a person changed it since: it is left
  and asked about first; ``force`` then writes the state before all the same.

A layer's and a group's state are compared field by field, the order by
where the items the answer placed stand now. A layer or a group that is gone
has nothing left to take back. A group the answer added is deleted only
while it is empty, because core deletes a group with the layers in it; a
group it removed is created again under a new id, and the tree before is
read with that id in the old one's place, so its layers go back into it; a
layer it removed does not come back, which the answer to the Undo says.

The writes go out in an order in which none needs a later one: groups
created again, the tree, layers, groups, filters, basemap, scene, and the
added groups' deletion last. A write core refuses for what it holds (400 or
422: a filter that is no longer valid, a scene core rejects, the nesting
limit) is left out and said (``map_refused``); the rest goes on. A write
core refuses for who asks, cannot take right now or does not answer ends
the Undo there: the rows stay free, and the next Undo finds what went back
already in place.
"""

import asyncio
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from functools import partial
from typing import Any
from uuid import UUID

from pydantic_ai.exceptions import ToolFailed

from assistant.maps.state import MAP_READS, MapRead, map_read
from assistant.tools.http import ServiceClients, ServiceError, call_service
from assistant.tools.map_edits import bare_query, group_state, layer_state
from assistant.tools.styles import _canonical, _styles_of

NO_GROUP_ID = "Core created the group again without answering its id."

#: The statuses with which core refuses a write for what it holds: asking
#: again changes nothing.
REFUSED_FOR_GOOD = frozenset({400, 422})


@dataclass(frozen=True)
class MapChanges:
    """Every map record of one answer on one project, oldest first."""

    project_id: str
    #: The audit rows that hold them.
    rows: list[UUID]
    #: Their changes, in the order the writes landed.
    changes: list[dict[str, Any]]
    undone: bool


@dataclass(frozen=True)
class RestoredMap:
    """What one Undo wrote back of a project's map."""

    project_id: str
    #: The layers whose state, name or filter went back.
    layers: list[int] = field(default_factory=list)
    #: The order and the grouping of layers.
    tree: bool = False
    #: A group's name or state, a group created again, an added group deleted.
    groups: bool = False
    basemap: bool = False
    scene: bool = False
    #: What does not come back and is not asked about: "layer_removed" (a
    #: removed layer), "group_in_use" (an added group that holds something),
    #: "map_refused" (a write core refused for what it holds).
    not_restored: list[str] = field(default_factory=list)

    @property
    def went_back(self) -> bool:
        """Whether this Undo wrote anything of the map back."""
        return bool(
            self.layers or self.tree or self.groups or self.basemap or self.scene
        )


@dataclass(frozen=True)
class ChangedMap:
    """A part of the map changed since the answer wrote it: the Undo asks
    first. ``object`` is the change's (``layer_state``, ``filter``, ``tree``,
    ...), with the layer or the group it belongs to."""

    object: str
    layer_project_id: int | None = None
    group_id: int | None = None


# ---- the records of an answer ------------------------------------------------------


def _whole(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def map_groups(records: Sequence[tuple[UUID, dict[str, Any]]]) -> list[MapChanges]:
    """The ``map`` records of a run by project, in the order of the calls. A
    record without a change an Undo can read is left out."""
    grouped: dict[str, list[tuple[UUID, dict[str, Any]]]] = {}
    for row, record in records:
        project_id, changes = record.get("project_id"), record.get("changes")
        if (
            record.get("kind") != "map"
            or not isinstance(project_id, str)
            or not isinstance(changes, list)
            or not _readable(changes)
        ):
            continue
        grouped.setdefault(project_id, []).append((row, record))
    return [
        MapChanges(
            project_id=project_id,
            rows=[row for row, _ in rows],
            changes=[
                change for _, record in rows for change in _readable(record["changes"])
            ],
            undone=all("undone_at" in record for _, record in rows),
        )
        for project_id, rows in grouped.items()
    ]


def _readable(changes: list[Any]) -> list[dict[str, Any]]:
    return [
        change
        for change in changes
        if isinstance(change, dict) and isinstance(change.get("object"), str)
    ]


#: The changes whose state is one value, and those whose state is the fields
#: an operation set, each with the key that names its layer or group.
_VALUES: dict[str, str | None] = {
    "layer_name": "layer_project_id",
    "filter": "layer_project_id",
    "group_name": "group_id",
    "tree": None,
    "basemap": None,
    "scene": None,
}
_FIELDS = {"layer_state": "layer_project_id", "group_state": "group_id"}

#: (object, layer or group, field of a state).
_Key = tuple[str, int | None, str | None]


@dataclass(frozen=True)
class _Removed:
    """A group the answer removed."""

    name: str
    parent_id: int | None
    #: The id it had; None for a record that does not name it.
    group_id: int | None
    #: Its place among its siblings; None for a record that does not say.
    order: int | None = None


@dataclass
class _Answer:
    """What an answer's changes come to."""

    #: Per thing, the state before the answer's first change of it and the
    #: state its last change wrote.
    values: dict[_Key, tuple[Any, Any]]
    #: The groups it added and did not remove again.
    added: list[int]
    #: The groups it removed, the last removed first, without those it added.
    removed: list[_Removed]
    #: It removed a layer.
    layer_removed: bool
    #: Every group id its changes name.
    seen: set[int]


_Item = tuple[str, int]
#: A tree as each parent's items, top first (None: the top level).
_Children = dict[int | None, list[_Item]]


def _children(items: Any, alias: Mapping[int, int] | None = None) -> _Children:
    """A tree in the records' form (``MapRead.tree``) by parent; a group id
    goes through ``alias``. An item that cannot be read is left out."""
    alias = alias or {}
    found: dict[int | None, list[tuple[int, _Item]]] = {}
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        kind, item_id, order = (
            item.get("type"),
            _whole(item.get("id")),
            _whole(item.get("order")),
        )
        parent = item.get("parent_id")
        if (
            kind not in ("layer", "group")
            or item_id is None
            or order is None
            or (parent is not None and _whole(parent) is None)
        ):
            continue
        if kind == "group":
            item_id = alias.get(item_id, item_id)
        if parent is not None:
            parent = alias.get(parent, parent)
        found.setdefault(parent, []).append((order, (kind, item_id)))
    return {
        parent: [item for _, item in sorted(rows, key=lambda row: row[0])]
        for parent, rows in found.items()
    }


def _parents(children: _Children) -> dict[_Item, int | None]:
    return {item: parent for parent, items in children.items() for item in items}


def _among(children: _Children, items: set[_Item]) -> _Children:
    """Where ``items`` stand in a tree: each parent's, in their order, with
    every other item left out."""
    found: _Children = {}
    for parent, held in children.items():
        kept = [item for item in held if item in items]
        if kept:
            found[parent] = kept
    return found


def _tree_groups(change: Mapping[str, Any]) -> set[int]:
    """The groups a tree change's two trees list."""
    return {
        item_id
        for key in ("before", "written")
        for kind, item_id in _parents(_children(change.get(key)))
        if kind == "group"
    }


def _collapsed(changes: Sequence[dict[str, Any]]) -> _Answer:
    """The changes of one thing taken together, newest first: the oldest
    state before, the newest state written."""
    values: dict[_Key, list[Any]] = {}
    added: list[int] = []
    removed: list[_Removed] = []
    seen: set[int] = set()
    layer_removed = False

    def note(key: _Key, before: Any, written: Any) -> None:
        if key in values:
            values[key][0] = before
        else:
            values[key] = [before, written]

    for change in reversed(changes):
        kind = change["object"]
        if kind in _FIELDS:
            target = _whole(change.get(_FIELDS[kind]))
            before, written = change.get("before"), change.get("written")
            if (
                target is None
                or not isinstance(before, dict)
                or not isinstance(written, dict)
            ):
                continue
            if kind == "group_state":
                seen.add(target)
            for name in written:
                if name in before:
                    note((kind, target, name), before[name], written[name])
        elif kind in _VALUES:
            named = _VALUES[kind]
            target = _whole(change.get(named)) if named else None
            if (
                (named and target is None)
                or "before" not in change
                or "written" not in change
            ):
                continue
            if kind == "group_name" and target is not None:
                seen.add(target)
            if kind == "tree":
                seen |= _tree_groups(change)
            note((kind, target, None), change["before"], change["written"])
        elif kind == "group_added":
            group_id = _whole(change.get("group_id"))
            if group_id is not None:
                added.append(group_id)
                seen.add(group_id)
        elif kind == "group_removed":
            before = change.get("before")
            if isinstance(before, dict) and isinstance(before.get("name"), str):
                group_id = _whole(change.get("group_id"))
                if group_id is not None:
                    seen.add(group_id)
                removed.append(
                    _Removed(
                        name=before["name"],
                        parent_id=_whole(before.get("parent_id")),
                        group_id=group_id,
                        order=_whole(before.get("order")),
                    )
                )
        elif kind == "layer_removed":
            layer_removed = True
    # A group the answer added and removed again was not there before it:
    # neither created nor deleted.
    both = {item.group_id for item in removed} & set(added)
    return _Answer(
        values={key: (pair[0], pair[1]) for key, pair in values.items()},
        added=[group_id for group_id in added if group_id not in both],
        removed=[item for item in removed if item.group_id not in both],
        layer_removed=layer_removed,
        seen=seen,
    )


# ---- core --------------------------------------------------------------------------


async def _read(
    clients: ServiceClients, bearer: str | None, project_id: str
) -> MapRead | None:
    """The project's map as core holds it now (the reads of ``read_map``,
    with the user's sign-in); None for a project that no longer exists."""
    try:
        answers = await asyncio.gather(
            *(
                call_service(
                    clients,
                    "core",
                    "GET",
                    f"/api/v2/project/{project_id}{path}",
                    bearer=bearer,
                )
                for path in MAP_READS
            )
        )
    except ServiceError as error:
        if error.status == 404:
            return None
        raise
    return map_read(*answers)


def _code(error: ServiceError) -> str | None:
    detail = error.body.get("detail") if isinstance(error.body, dict) else None
    code = detail.get("code") if isinstance(detail, dict) else None
    return code if isinstance(code, str) else None


def _groups(state: MapRead) -> dict[int, dict[str, Any]]:
    """The group rows by id."""
    return {
        row["id"]: row
        for row in state.groups
        if isinstance(row, dict) and _whole(row.get("id")) is not None
    }


def _scene(value: Any) -> dict[str, Any] | None:
    """A scene for comparing: core stores an empty one as none."""
    return value if isinstance(value, dict) and value else None


def _style(value: Any) -> str | None:
    return _canonical(value) if value is not None else None


def _in_use(state: MapRead, group_id: int) -> bool:
    """Whether a group holds a layer or a group, by the rows and by the map
    document's tree."""
    entry = state.group_entries().get(group_id) or {}
    return bool(
        any(
            row.get("layer_project_group_id") == group_id for row in state.rows.values()
        )
        or any(row.get("parent_id") == group_id for row in _groups(state).values())
        or entry.get("children")
    )


def _state_held(link: int, body: Mapping[str, Any], held: MapRead) -> bool:
    """Whether the map holds a layer's state fields as ``body`` has them."""
    return link in held.rows and all(
        layer_state(held, link)[key] == value for key, value in body.items()
    )


def _name_held(link: int, name: Any, held: MapRead) -> bool:
    return link in held.rows and bool(held.rows[link].get("name") == name)


def _filter_held(link: int, query: Any, held: MapRead) -> bool:
    return link in held.rows and bare_query(held.rows[link].get("query")) == query


def _group_held(group_id: int, key: str, value: Any, held: MapRead) -> bool:
    """Whether the map holds a group's name, or a field of its state."""
    row = _groups(held).get(group_id)
    if row is None:
        return False
    held_value = row.get("name") if key == "name" else group_state(row)[key]
    return bool(held_value == value)


def _basemap_held(basemap: Any, held: MapRead) -> bool:
    return bool(held.project.get("basemap") == basemap)


def _scene_held(scene: Any, held: MapRead) -> bool:
    return bool(_scene(held.document.get("scene")) == scene)


def _group_gone(group_id: int, held: MapRead) -> bool:
    return group_id not in _groups(held)


@dataclass(frozen=True)
class _Write:
    """One write that takes a thing back."""

    method: str
    #: The path after the project's.
    path: str
    body: Any
    #: Whether a read of the map holds what the write sends.
    landed: Callable[[MapRead], bool]
    #: What the Undo's answer names once it went back: the layer, or a part
    #: of the map (``RestoredMap``'s flags).
    layer: int | None = None
    part: str | None = None


class _Restore:
    """One Undo of a project's map changes, on one read of the map."""

    def __init__(
        self,
        clients: ServiceClients,
        bearer: str | None,
        group: MapChanges,
        force: bool,
        state: MapRead,
    ) -> None:
        self.clients = clients
        self.bearer = bearer
        self.project_id = group.project_id
        self.force = force
        self.state = state
        self.groups = _groups(state)
        self.answer = _collapsed(group.changes)
        self.asked: list[ChangedMap] = []
        self.layers: set[int] = set()
        self.parts: set[str] = set()
        self.not_restored: list[str] = (
            ["layer_removed"] if self.answer.layer_removed else []
        )
        #: A removed group's id -> the id of the group that stands for it now.
        self.alias: dict[int, int] = {}
        #: The groups this Undo created, with their parents, and the place
        #: among its siblings each had before the answer removed it.
        self.created: dict[int, int | None] = {}
        self.created_order: dict[int, int] = {}
        #: Groups to open or close with the tree's write.
        self.expanded: dict[int, bool] = {}

    # ---- deciding

    def _goes_back(
        self, change: ChangedMap, now: Any, before: Any, written: Any
    ) -> bool:
        """Whether the state before is written. Not when the answer left the
        thing as it was or the map holds the state before already; when the
        map holds something else than the answer wrote, only with ``force``,
        and the user is asked first."""
        if before == written or now == before:
            return False
        if now == written or self.force:
            return True
        if change not in self.asked:
            self.asked.append(change)
        return False

    def _layer_writes(self) -> list[_Write]:
        """Per layer: the state fields that go back in one write, then the name."""
        values = self.answer.values
        writes: list[_Write] = []
        links = sorted(
            {
                link
                for kind, link, _ in values
                if kind in ("layer_state", "layer_name") and link is not None
            }
        )
        for link in links:
            row = self.state.rows.get(link)
            # A layer the user can no longer open has no state of theirs.
            if row is None or row.get("locked"):
                continue
            now = layer_state(self.state, link)
            styles = _styles_of(self.state, link)
            change = ChangedMap("layer_state", layer_project_id=link)
            body: dict[str, Any] = {}
            for (kind, target, name), (before, written) in values.items():
                if kind != "layer_state" or target != link or name not in now:
                    continue
                if name == "active_style_id":
                    before, written = _style(before), _style(written)
                    if before == written or now[name] == before:
                        continue
                    if before not in styles:
                        # Nothing to go back to. Asked once; asking again
                        # changes nothing, so Undo anyway leaves the layer.
                        if not self.force and change not in self.asked:
                            self.asked.append(change)
                        continue
                    if written not in styles:
                        # The layer cannot draw a style it no longer has:
                        # the one it draws now is core's pick, not a person's.
                        written = now[name]
                if self._goes_back(change, now[name], before, written):
                    body[str(name)] = before
            if body:
                writes.append(
                    _Write(
                        "PATCH",
                        f"/layer/{link}/map-state",
                        body,
                        partial(_state_held, link, body),
                        layer=link,
                    )
                )
            if ("layer_name", link, None) in values:
                before, written = values[("layer_name", link, None)]
                if self._goes_back(
                    ChangedMap("layer_name", layer_project_id=link),
                    row.get("name"),
                    before,
                    written,
                ):
                    writes.append(
                        _Write(
                            "PUT",
                            f"/layer/{link}",
                            {"name": before},
                            partial(_name_held, link, before),
                            layer=link,
                        )
                    )
        return writes

    def _group_writes(self) -> list[_Write]:
        """Per group: shown or hidden, then the name. Open or closed is
        stored with the tree and goes with its write (``expanded``). A group
        the answer added keeps what it has: it goes, or it stays as it is."""
        values = self.answer.values
        writes: list[_Write] = []
        for (kind, group_id, name), (before, written) in sorted(
            values.items(),
            key=lambda item: (item[0][1] or 0, item[0][0] != "group_state"),
        ):
            if kind not in ("group_state", "group_name") or group_id is None:
                continue
            row = self.groups.get(group_id)
            if row is None or group_id in self.answer.added:
                continue
            if kind == "group_name":
                if self._goes_back(
                    ChangedMap("group_name", group_id=group_id),
                    row.get("name"),
                    before,
                    written,
                ):
                    writes.append(
                        _Write(
                            "PUT",
                            f"/group/{group_id}",
                            {"name": before},
                            partial(_group_held, group_id, "name", before),
                            part="groups",
                        )
                    )
                continue
            now = group_state(row)
            if name not in now or not self._goes_back(
                ChangedMap("group_state", group_id=group_id), now[name], before, written
            ):
                continue
            if name == "expanded":
                self.expanded[group_id] = bool(before)
                continue
            writes.append(
                _Write(
                    "PATCH",
                    f"/group/{group_id}/map-state",
                    {"visible": before},
                    partial(_group_held, group_id, "visible", before),
                    part="groups",
                )
            )
        return writes

    def _filter_writes(self) -> list[_Write]:
        """Per layer, its whole saved query, compared without the keys core
        answers empty (``bare_query``); none clears the filter."""
        writes: list[_Write] = []
        for (kind, link, _), pair in sorted(
            self.answer.values.items(), key=lambda item: item[0][1] or 0
        ):
            row = self.state.rows.get(link) if link is not None else None
            if kind != "filter" or link is None or row is None or row.get("locked"):
                continue
            before, written = bare_query(pair[0]), bare_query(pair[1])
            if self._goes_back(
                ChangedMap("filter", layer_project_id=link),
                bare_query(row.get("query")),
                before,
                written,
            ):
                writes.append(
                    _Write(
                        "PUT",
                        f"/layer/{link}",
                        {"query": before},
                        partial(_filter_held, link, before),
                        layer=link,
                    )
                )
        return writes

    def _project_writes(self) -> list[_Write]:
        """The basemap and the scene, each through the project's update with
        its key alone."""
        values = self.answer.values
        writes: list[_Write] = []
        if ("basemap", None, None) in values:
            before, written = values[("basemap", None, None)]
            if self._goes_back(
                ChangedMap("basemap"),
                self.state.project.get("basemap"),
                before,
                written,
            ):
                writes.append(
                    _Write(
                        "PUT",
                        "",
                        {"basemap": before},
                        partial(_basemap_held, before),
                        part="basemap",
                    )
                )
        if ("scene", None, None) in values:
            before, written = (_scene(value) for value in values[("scene", None, None)])
            if self._goes_back(
                ChangedMap("scene"),
                _scene(self.state.document.get("scene")),
                before,
                written,
            ):
                writes.append(
                    _Write(
                        "PUT",
                        "",
                        {"scene": before},
                        partial(_scene_held, before),
                        part="scene",
                    )
                )
        return writes

    def _to_create(self) -> list[_Removed]:
        """The removed groups to create again, a parent before the group in
        it. One that is back already (a group of its name under its parent
        that the answer's records do not know) only gets its ``alias``, and
        so does not come twice when the Undo is pressed again."""
        wanted: list[_Removed] = []
        pending: set[int] = set()
        taken: set[int] = set()
        for item in self.answer.removed:
            parent = item.parent_id
            if parent is not None:
                parent = self.alias.get(parent, parent)
                # The group it was in is gone: nothing to put it into.
                if parent not in self.groups and parent not in pending:
                    continue
            back = [
                group_id
                for group_id, row in self.groups.items()
                if row.get("name") == item.name
                and row.get("parent_id") == parent
                and group_id not in self.answer.seen
                and group_id not in taken
                and (item.group_id is None or group_id > item.group_id)
            ]
            if back:
                taken.add(back[0])
                if item.group_id is not None:
                    self.alias[item.group_id] = back[0]
                continue
            wanted.append(item)
            if item.group_id is not None:
                pending.add(item.group_id)
        return wanted

    def _standing(self) -> set[_Item]:
        """The groups that stand for the removed ones the records name."""
        return {("group", group_id) for group_id in self.alias.values()}

    def _restorable(
        self, kept: set[_Item], before: _Children, groups: set[int]
    ) -> set[_Item]:
        """The items the tree before places again: those of ``kept`` it
        lists under a parent among ``groups`` (or at the top level), without
        the groups the answer added."""
        placed = _parents(before)
        return {
            item
            for item in kept
            if item in placed
            and (placed[item] is None or placed[item] in groups)
            and not (item[0] == "group" and item[1] in self.answer.added)
        }

    def _tree_goes_back(self, pending: set[int]) -> bool:
        """Whether the tree before is written: decided on the items of the
        tree the answer wrote that still exist, by their parent and their
        order among themselves. ``pending`` are the removed groups this Undo
        creates again."""
        pair = self.answer.values.get(("tree", None, None))
        if pair is None:
            return False
        now = _children(self.state.tree())
        before, written = _children(pair[0], self.alias), _children(pair[1])
        kept = set(_parents(written)) & set(_parents(now))
        back = self._restorable(
            kept | self._standing(), before, set(self.groups) | pending
        )
        if (
            not back
            or _among(before, back) == _among(written, back)
            or _among(now, back) == _among(before, back)
        ):
            return False
        if _among(now, kept) == _among(written, kept) or self.force:
            return True
        self.asked.append(ChangedMap("tree"))
        return False

    def _tree_write(self, restore: bool) -> _Write | None:
        """The one write of the tree, None when it has nothing to change: the
        items the tree before places back where it had them (``restore``), a
        group this Undo created at its place, and the groups to open or
        close. Every other item keeps its parent and its place among its
        siblings as far as it can. The whole tree is sent, counted from 0
        under each parent, as ``map_update`` sends it; an added group that is
        empty is left out, since it goes."""
        pair = self.answer.values.get(("tree", None, None))
        now = _children(self.state.tree())
        for group_id, parent in self.created.items():
            now.setdefault(parent, []).insert(0, ("group", group_id))
        live = set(self.groups) | set(self.created)
        before = _children(pair[0], self.alias) if pair is not None else {}
        kept = self._standing()
        if restore and pair is not None:
            kept |= set(_parents(_children(pair[1]))) & set(_parents(now))
        back = self._restorable(kept, before, live)
        # Without a tree change of the answer, a created group goes back to
        # the place it had among its siblings; with one, the tree before
        # places what it can.
        own = (
            {
                ("group", group_id): order
                for group_id, order in self.created_order.items()
            }
            if pair is None
            else {}
        )
        final: _Children = {}
        for parent in (None, *sorted(live)):
            placed = [item for item in before.get(parent, []) if item in back]
            for index, item in enumerate(now.get(parent, [])):
                if item not in back and item not in own:
                    placed.insert(min(index, len(placed)), item)
            for item in now.get(parent, []):
                if item in own:
                    placed.insert(min(own[item], len(placed)), item)
            final[parent] = placed
        moved = final != {parent: now.get(parent, []) for parent in final}
        if not moved and not self.expanded:
            return None
        leaving = {
            group_id for group_id in self.answer.added if not final.get(group_id)
        }
        items: list[dict[str, Any]] = []

        def walk(parent: int | None, above: frozenset[int]) -> None:
            order = 0
            for kind, item_id in final.get(parent, []):
                if kind == "group" and (item_id in leaving or item_id in above):
                    continue
                item = {
                    "id": item_id,
                    "type": kind,
                    "order": order,
                    "parent_id": parent,
                }
                order += 1
                if kind == "group" and item_id in self.expanded:
                    item["expanded"] = self.expanded[item_id]
                items.append(item)
                if kind == "group":
                    walk(item_id, above | {item_id})

        walk(None, frozenset())
        sent = _children(items)
        expanded = dict(self.expanded)

        def landed(held: MapRead) -> bool:
            rows = _groups(held)
            return _among(_children(held.tree()), set(_parents(sent))) == sent and all(
                group_id in rows and group_state(rows[group_id])["expanded"] == value
                for group_id, value in expanded.items()
            )

        return _Write(
            "PUT",
            "/layer-tree",
            {"items": items},
            landed,
            part="tree" if moved and restore else None,
        )

    # ---- writing

    def _refused(self, error: ServiceError) -> bool:
        """Whether core refused a write for what it holds, not for who asks
        or because it cannot right now: that one thing does not come back,
        which is noted once, and the Undo goes on."""
        if error.status not in REFUSED_FOR_GOOD:
            return False
        if "map_refused" not in self.not_restored:
            self.not_restored.append("map_refused")
        return True

    async def _send(self, write: _Write) -> bool:
        """Makes one write, as ``_call`` does. False also when core refuses
        it for what it holds (``_refused``)."""
        try:
            return await self._call(write)
        except ServiceError as error:
            if not self._refused(error):
                raise
        return False

    async def _call(self, write: _Write) -> bool:
        """Makes one write. False when core no longer finds its target: a
        layer or a group that is gone has nothing left to take back. A write
        without an answer (no answer in time, a dropped connection) may have
        landed all the same: the map is read once, and counts when it holds
        what was sent; else the write failed as it did."""
        try:
            await call_service(
                self.clients,
                "core",
                write.method,
                f"/api/v2/project/{self.project_id}{write.path}",
                bearer=self.bearer,
                json_body=write.body,
            )
        except ServiceError as error:
            if error.status == 404:
                return False
            raise
        except ToolFailed as failure:
            try:
                held = await _read(self.clients, self.bearer, self.project_id)
            except ToolFailed:
                raise failure from None
            if held is None or not write.landed(held):
                raise
        return True

    async def _send_state(self, link: int, write: _Write) -> bool:
        """A layer's state. A style the layer lost between the read and the
        write is left out of it, and asked about as one that is gone."""
        try:
            return await self._call(write)
        except ServiceError as error:
            if not (
                error.status == 422
                and _code(error) == "style_not_on_layer"
                and "active_style_id" in write.body
            ):
                if not self._refused(error):
                    raise
                return False
        change = ChangedMap("layer_state", layer_project_id=link)
        if not self.force and change not in self.asked:
            self.asked.append(change)
        body = {k: v for k, v in write.body.items() if k != "active_style_id"}
        if not body:
            return False
        return await self._send(
            _Write(
                write.method,
                write.path,
                body,
                partial(_state_held, link, body),
                layer=link,
            )
        )

    async def _create(self, item: _Removed) -> None:
        """A removed group again, with its name under its parent."""
        parent = item.parent_id
        if parent is not None:
            parent = self.alias.get(parent, parent)
        body: dict[str, Any] = {"name": item.name}
        if parent is not None:
            body["parent_id"] = parent
        known = set(self.groups) | set(self.created)
        reply: Any = None
        failure: ToolFailed | None = None
        try:
            reply = await call_service(
                self.clients,
                "core",
                "POST",
                f"/api/v2/project/{self.project_id}/group",
                bearer=self.bearer,
                json_body=body,
            )
        except ServiceError as error:
            # The group it was in is gone, or core refuses the group.
            if error.status == 404 or self._refused(error):
                return
            raise
        except ToolFailed as error:
            failure = error
        new_id = _whole(reply.get("id")) if isinstance(reply, dict) else None
        if new_id is None:
            # No answer, or one without the id: the group is the one of that
            # name under that parent that was not there before.
            failure = failure or ToolFailed(NO_GROUP_ID)
            try:
                held = await _read(self.clients, self.bearer, self.project_id)
            except ToolFailed:
                raise failure from None
            made = [
                group_id
                for group_id, row in (_groups(held) if held is not None else {}).items()
                if group_id not in known
                and row.get("name") == item.name
                and row.get("parent_id") == parent
            ]
            if not made:
                raise failure
            new_id = max(made)
        self.created[new_id] = parent
        if item.order is not None:
            self.created_order[new_id] = item.order
        if item.group_id is not None:
            self.alias[item.group_id] = new_id
        self.parts.add("groups")

    async def _delete_added(self) -> None:
        """The groups the answer added, each only while it holds nothing on
        a read made right before: core deletes a group with its layers."""
        for group_id in self.answer.added:
            if group_id not in self.groups:
                continue
            held = await _read(self.clients, self.bearer, self.project_id)
            if held is None or group_id not in _groups(held):
                continue
            if _in_use(held, group_id):
                if "group_in_use" not in self.not_restored:
                    self.not_restored.append("group_in_use")
                continue
            if await self._send(
                _Write(
                    "DELETE",
                    f"/group/{group_id}",
                    None,
                    partial(_group_gone, group_id),
                )
            ):
                self.parts.add("groups")

    async def run(self) -> tuple[RestoredMap, list[ChangedMap]]:
        # Everything is decided on the one read, before the first write.
        wanted = self._to_create()
        restore = self._tree_goes_back(
            {item.group_id for item in wanted if item.group_id is not None}
        )
        layers = self._layer_writes()
        groups = self._group_writes()
        later = [*self._filter_writes(), *self._project_writes()]

        for item in wanted:
            await self._create(item)
        tree = self._tree_write(restore)
        if tree is not None and await self._send(tree):
            if tree.part is not None:
                self.parts.add(tree.part)
            if self.expanded:
                self.parts.add("groups")
        for write in (*layers, *groups, *later):
            sent = await (
                self._send_state(write.layer, write)
                if write.method == "PATCH" and write.layer is not None
                else self._send(write)
            )
            if not sent:
                continue
            if write.layer is not None:
                self.layers.add(write.layer)
            elif write.part is not None:
                self.parts.add(write.part)
        await self._delete_added()
        return (
            RestoredMap(
                project_id=self.project_id,
                layers=sorted(self.layers),
                tree="tree" in self.parts,
                groups="groups" in self.parts,
                basemap="basemap" in self.parts,
                scene="scene" in self.parts,
                not_restored=list(self.not_restored),
            ),
            self.asked,
        )


async def restore_map(
    clients: ServiceClients, bearer: str | None, group: MapChanges, force: bool
) -> tuple[RestoredMap | None, list[ChangedMap]]:
    """An answer's map changes taken back: what went back and what does not
    come back, and what the user is asked about first because it was changed
    since (never with ``force``). None for a project that no longer exists:
    nothing is left to take back."""
    state = await _read(clients, bearer, group.project_id)
    if state is None:
        return None, []
    return await _Restore(clients, bearer, group, force, state).run()
