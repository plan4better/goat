"""Operations that edit a stored workflow config, for the AI assistant.

`apply(config, operations)` returns a new config with the operations applied
in order, or raises `OperationError` with a message the model can act on.
The given config is never changed, and an operation that fails applies none
of the others. Each operation writes what the editor writes for the same
change (`apps/web/lib/validations/workflow.ts`, `reactFlowToConfig` in
`apps/web/lib/store/workflow/slice.ts`); everything it does not name (other
steps, their positions, sizes, colours and unknown keys, the viewport, the
variables) stays as stored, byte for byte.

An operation is a JSON object with an `op` and the fields below; every field
not marked optional is required, and an unknown field is refused.

- `add_node` `node`: a whole node as the editor stores it. Without a
  `position` it is placed next to the steps it is connected to once all
  operations are applied.
- `remove_node` `node_id`: the step or note and every connection to or from it.
- `set_settings` `node_id`, `settings`: merged into a tool step's
  `data.config`, setting by setting; a null value removes the setting.
- `set_data` `node_id`, `data`: merged into the `data` of a dataset, export
  or If step, key by key from the kind's own keys; a null value removes the
  key. A dataset step's layer reference changes as one.
- `connect` `source`, `target`, `target_handle` (optional),
  `source_handle` (optional): a connection, in the stored edge shape. One
  that closes a loop is refused, and so is a second one into an input,
  unless the two lie on different branches of one If step.
- `disconnect` `source`, `target`, `target_handle` (optional): the
  connections from `source` into `target` (into that input only, when given).
- `rename_node` `node_id`, `label`: the step's `data.label`.
- `set_note_text` `node_id`, `text`, `width`, `height`, `color` (the last
  three optional): a note's HTML (`data.text`), its size and its colour
  (`data.backgroundColor`). The text is stored as given: the caller builds
  safe HTML from the model's text (the assistant's `note_html`), never
  passes the model's text as markup.
- `move_node` `node_id`, `position`: `{"x": ..., "y": ...}`.

Positions and note sizes are bounded, so a placement always ends. The checks
of what a step is configured to do (tool inputs, settings, a loop already
stored) stay with processes' full check, which runs on the result like on
any save. Standard library only, like `checks`.
"""

import copy
import math
import re
import uuid
from collections.abc import Callable, Mapping, Sequence
from typing import Any, TypeGuard

from goatlib.workflows.checks import NODE_TYPES, shape_issues


class OperationError(ValueError):
    """An operation that cannot be applied. `index` and `op` name the
    operation (None for a config that cannot be edited at all); the message
    starts with them."""

    def __init__(
        self, message: str, *, index: int | None = None, op: str | None = None
    ) -> None:
        if index is not None:
            prefix = f"operation {index}" + (f" ({op})" if op else "")
            message = f"{prefix}: {message}"
        super().__init__(message)
        self.index = index
        self.op = op


class _RefusedError(Exception):
    """An operation's own refusal; `apply` adds which operation it was."""


class _Edit:
    """The config being edited: a deep copy of the stored one."""

    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        self.nodes: list[dict[str, Any]] = config["nodes"]
        self.edges: list[Any] = config["edges"]
        #: The ids of the nodes added without a position, in the order added.
        self.unplaced: list[str] = []

    def node(self, node_id: str) -> dict[str, Any]:
        for node in self.nodes:
            if node["id"] == node_id:
                return node
        known = ", ".join(node["id"] for node in self.nodes) or "none"
        raise _RefusedError(
            f"there is no step or note with the id {node_id!r}. The ids are: {known}."
        )


def _text(fields: Mapping[str, Any], name: str) -> str:
    value = fields.get(name)
    if not isinstance(value, str) or not value.strip():
        raise _RefusedError(f"{name} must be a non-empty string.")
    return value


def _remove_node(edit: _Edit, fields: Mapping[str, Any]) -> None:
    node_id = _text(fields, "node_id")
    node = edit.node(node_id)
    edit.nodes.remove(node)
    edit.edges[:] = [
        edge
        for edge in edit.edges
        if not (
            isinstance(edge, dict)
            and node_id in (edge.get("source"), edge.get("target"))
        )
    ]


#: The input a step of these kinds reads on: the editor's handle id
#: (`ExportNode`, `IfNode`).
_SINGLE_INPUT = "input"
#: The input a connection into a tool without `targetHandle` feeds, as the
#: runner and processes read it.
_TOOL_DEFAULT_INPUT = "input_layer_id"
#: A tool step's output handle (`ToolNode`); a dataset's has no id.
_TOOL_OUTPUT = "output"
#: An If step's output handles (`IF_TRUE_HANDLE`, `IF_FALSE_HANDLE`).
_IF_BRANCHES = ("true", "false")
#: The namespace of the connection ids `connect` derives.
_EDGE_NAMESPACE = uuid.UUID("0c6f7e52-8d1b-4a39-9f7e-3b5d2c1a4e60")


def _kind(node: Mapping[str, Any]) -> str:
    return str(node["type"])


#: A node's kind in the words of the model's workflow view.
_DESCRIBED = {
    "dataset": "a dataset step",
    "tool": "a tool step",
    "export": "an export step",
    "if": "an If step",
    "textAnnotation": "a note",
}


def _described(node: Mapping[str, Any]) -> str:
    return _DESCRIBED[_kind(node)]


def _target_input(edge: Mapping[str, Any], target_kind: str | None) -> str | None:
    """The input a stored connection feeds: its `targetHandle`, or what a
    missing one means for its target's kind."""
    handle = edge.get("targetHandle")
    if isinstance(handle, str) and handle:
        return handle
    if target_kind in ("export", "if"):
        return _SINGLE_INPUT
    if target_kind == "tool":
        return _TOOL_DEFAULT_INPUT
    return None


def _feeds(edit: _Edit, target_id: str) -> list[tuple[dict[str, Any], str | None]]:
    """The connections into `target_id` with the input each feeds."""
    target_kind = next(
        (_kind(node) for node in edit.nodes if node["id"] == target_id), None
    )
    return [
        (edge, _target_input(edge, target_kind))
        for edge in edit.edges
        if isinstance(edge, dict) and edge.get("target") == target_id
    ]


def _source_handle(source: Mapping[str, Any], given: Any) -> str | None:
    kind = _kind(source)
    name = source["id"]
    if kind == "textAnnotation":
        raise _RefusedError(f"{name!r} is a note; notes take no connections.")
    if kind == "export":
        raise _RefusedError(
            f"{name!r} is an export step: it saves a result and nothing reads from it."
        )
    if kind == "if":
        if given not in _IF_BRANCHES:
            raise _RefusedError(
                f"{name!r} is an If step: source_handle must be 'true' or 'false', "
                "the branch the connection leaves from."
            )
        return str(given)
    if kind == "tool":
        if given not in (None, _TOOL_OUTPUT):
            raise _RefusedError(
                f"{name!r} is a tool step: its only output is 'output'; "
                "leave source_handle out."
            )
        return _TOOL_OUTPUT
    if given is not None:
        raise _RefusedError(
            f"{name!r} is a dataset step with one output; leave source_handle out."
        )
    return None


def _target_handle(target: Mapping[str, Any], given: Any) -> str:
    kind = _kind(target)
    name = target["id"]
    if kind == "textAnnotation":
        raise _RefusedError(f"{name!r} is a note; notes take no connections.")
    if kind == "dataset":
        raise _RefusedError(f"{name!r} is a dataset step: it reads from nothing.")
    if isinstance(given, str):
        given = given.strip()
    if kind in ("export", "if"):
        if given not in (None, _SINGLE_INPUT):
            raise _RefusedError(
                f"{name!r} is {_described(target)} with the one input 'input'; "
                "leave target_handle out."
            )
        return _SINGLE_INPUT
    if not isinstance(given, str) or not given:
        raise _RefusedError(
            f"{name!r} is a tool step: target_handle must name the tool's layer "
            "input the connection feeds."
        )
    if given == _SINGLE_INPUT:
        # The editor's handle until the tool's inputs have loaded: a run
        # passes it to the tool, which never reads it.
        raise _RefusedError(
            f"{name!r} is a tool step: 'input' feeds none of its inputs; name the "
            "tool's layer input, for example input_layer_id."
        )
    return given


def _edge_id(edit: _Edit, *parts: str | None) -> str:
    """`edge-` and a UUID derived from the connection's ends, so the same
    operations give the same config; the editor's ids are `edge-` and a
    random UUID."""
    taken = {edge.get("id") for edge in edit.edges if isinstance(edge, dict)}
    key = "\x1f".join(part or "" for part in parts)
    attempt = 0
    while True:
        name = key if attempt == 0 else f"{key}\x1f{attempt}"
        edge_id = f"edge-{uuid.uuid5(_EDGE_NAMESPACE, name)}"
        if edge_id not in taken:
            return edge_id
        attempt += 1


def _links(edit: _Edit) -> list[tuple[str, str, Any]]:
    """Each connection as (source, target, sourceHandle)."""
    return [
        (edge["source"], edge["target"], edge.get("sourceHandle"))
        for edge in edit.edges
        if isinstance(edge, dict)
        and isinstance(edge.get("source"), str)
        and isinstance(edge.get("target"), str)
    ]


def _path(edit: _Edit, start: str, goal: str) -> list[str] | None:
    """The shortest path of steps from `start` down to `goal`, or None."""
    successors: dict[str, list[str]] = {}
    for source, target, _ in _links(edit):
        successors.setdefault(source, []).append(target)
    previous: dict[str, str | None] = {start: None}
    queue = [start]
    while queue:
        current = queue.pop(0)
        if current == goal:
            path = [current]
            while (step := previous[path[-1]]) is not None:
                path.append(step)
            return path[::-1]
        for successor in successors.get(current, []):
            if successor not in previous:
                previous[successor] = current
                queue.append(successor)
    return None


def _downstream(links: list[tuple[str, str, Any]], starts: set[str]) -> set[str]:
    """`starts` and every step they lead to."""
    successors: dict[str, list[str]] = {}
    for source, target, _ in links:
        successors.setdefault(source, []).append(target)
    found = set(starts)
    queue = list(starts)
    while queue:
        for successor in successors.get(queue.pop(), []):
            if successor not in found:
                found.add(successor)
                queue.append(successor)
    return found


def _branch_steps(edit: _Edit) -> dict[tuple[str, str], set[str]]:
    """The steps each branch of each If step reaches and the other does not:
    the steps a run skips when the If takes the other branch
    (`mark_skipped_descendants` in `goatlib.tools.workflow_runner`)."""
    links = _links(edit)
    steps: dict[tuple[str, str], set[str]] = {}
    for node in edit.nodes:
        if _kind(node) != "if":
            continue
        for branch in _IF_BRANCHES:
            taken = {t for s, t, h in links if s == node["id"] and h == branch}
            other = {t for s, t, h in links if s == node["id"] and h != branch}
            steps[(node["id"], branch)] = _downstream(links, taken) - _downstream(
                links, other
            )
    return steps


def _branches(
    branch_steps: Mapping[tuple[str, str], set[str]], source: Any
) -> set[tuple[str, str]]:
    """The (If step, branch) pairs a connection from `source` lies on: those
    whose branch alone reaches `source`. A connection leaving an If step
    itself lies on none: a run passes the If's input on along every
    connection from it, whichever branch it took (`execute_if_node`,
    `get_input_layer_id`)."""
    return {
        (if_id, branch)
        for (if_id, branch), steps in branch_steps.items()
        if source in steps
    }


def _exclusive(first: set[tuple[str, str]], second: set[tuple[str, str]]) -> bool:
    """Whether the two lie on different branches of one If step, so a run
    that evaluates that If skips one of them. A run that skips the If itself
    (it sits on a branch of another If not taken) evaluates neither branch;
    two feeders that the outer If's taken branch also reaches then both
    run."""
    return any(
        if_id == other_id and branch != other_branch
        for if_id, branch in first
        for other_id, other_branch in second
    )


def _connect(edit: _Edit, fields: Mapping[str, Any]) -> None:
    source_id = _text(fields, "source")
    target_id = _text(fields, "target")
    source = edit.node(source_id)
    target = edit.node(target_id)
    if source_id == target_id:
        raise _RefusedError(f"{source_id!r} cannot read from itself.")
    source_handle = _source_handle(source, fields.get("source_handle"))
    target_handle = _target_handle(target, fields.get("target_handle"))
    loop = _path(edit, target_id, source_id)
    if loop is not None:
        shown = " -> ".join(repr(step) for step in loop)
        raise _RefusedError(
            f"connecting {source_id!r} to {target_id!r} would make a loop: {shown}."
        )
    feeders = [edge for edge, fed in _feeds(edit, target_id) if fed == target_handle]
    if feeders:
        branch_steps = _branch_steps(edit)
        new = _branches(branch_steps, source_id)
        for existing in feeders:
            fed_by = existing.get("source")
            gone = all(node["id"] != fed_by for node in edit.nodes)
            named = f"{fed_by!r}" + (
                " (a connection from a step that no longer exists)" if gone else ""
            )
            if _kind(target) == "if":
                raise _RefusedError(
                    f"{target_id!r} is an If step and takes exactly one input; it is "
                    f"already fed by {named}. Disconnect it first."
                )
            old = _branches(branch_steps, fed_by)
            if not _exclusive(new, old):
                raise _RefusedError(
                    f"input {target_handle!r} of {target_id!r} is already fed by "
                    f"{named}; disconnect it first (only the two branches of one If "
                    "step may feed the same input)."
                )
    # The keys, and their order, of the editor's stored connection.
    edge: dict[str, Any] = {
        "id": _edge_id(edit, source_id, source_handle, target_id, target_handle),
        "source": source_id,
    }
    if source_handle is not None:
        edge["sourceHandle"] = source_handle
    edge["target"] = target_id
    edge["targetHandle"] = target_handle
    edit.edges.append(edge)


def _disconnect(edit: _Edit, fields: Mapping[str, Any]) -> None:
    source_id = _text(fields, "source")
    target_id = _text(fields, "target")
    handle = fields.get("target_handle")
    if handle is not None:
        if not isinstance(handle, str) or not handle.strip():
            raise _RefusedError("target_handle must be a non-empty string.")
        handle = handle.strip()
    feeds = _feeds(edit, target_id)
    matched = [
        edge
        for edge, fed in feeds
        if edge.get("source") == source_id and (handle is None or fed == handle)
    ]
    if matched:
        edit.edges[:] = [
            edge for edge in edit.edges if not any(edge is m for m in matched)
        ]
        return
    # Both ends must exist for the refusal to say what the target reads.
    edit.node(source_id)
    edit.node(target_id)
    into = f" into {handle!r}" if handle is not None else ""
    fed_by = ", ".join(f"{edge.get('source')!r} into {fed!r}" for edge, fed in feeds)
    raise _RefusedError(
        f"there is no connection from {source_id!r} to {target_id!r}{into}. "
        f"{target_id!r} is fed by: {fed_by or 'nothing'}."
    )


def _data(node: dict[str, Any]) -> dict[str, Any]:
    data = node.get("data")
    if not isinstance(data, dict):
        raise _RefusedError(f"the step {node['id']!r} has no data object to change.")
    return data


def _set_settings(edit: _Edit, fields: Mapping[str, Any]) -> None:
    node = edit.node(_text(fields, "node_id"))
    settings = fields["settings"]
    if not isinstance(settings, dict):
        raise _RefusedError("settings must be an object of setting names and values.")
    if _kind(node) != "tool":
        raise _RefusedError(
            f"{node['id']!r} is {_described(node)}; only a tool step has settings."
        )
    data = _data(node)
    config = data.get("config")
    if config is None:
        config = data["config"] = {}
    if not isinstance(config, dict):
        raise _RefusedError(f"the settings of {node['id']!r} are not an object.")
    for name, value in settings.items():
        if value is None:
            config.pop(name, None)
        else:
            config[name] = copy.deepcopy(value)


#: The `data` keys a run writes (the union is core's
#: `WORKFLOW_NODE_DATA_VOLATILE`); no operation sets them.
RUN_STATE_KEYS = frozenset(
    {"status", "jobId", "error", "outputLayerId", "exportedLayerId", "activeHandle"}
)
#: The `data` keys `set_data` changes, per kind
#: (`apps/web/lib/validations/workflow.ts`; `unresolved` is a template's
#: unresolved input, cleared when a layer is chosen).
_DATA_KEYS: dict[str, tuple[str, ...]] = {
    "dataset": (
        "label",
        "projectLayerId",
        "layerId",
        "layerName",
        "geometryType",
        "layerType",
        "filter",
        "filterInitialized",
        "unresolved",
    ),
    "export": (
        "label",
        "datasetName",
        "addToProject",
        "overwritePrevious",
        "destination",
        "targetLayerId",
        "targetLayerName",
        "outputStyle",
    ),
    "if": ("label", "mode", "condition", "customExpression"),
}
#: Why a key no operation of `set_data` takes is refused.
_DATA_REFUSED = {
    "type": "the type cannot change; remove the step and add another",
    "config": "only a tool step has settings; use set_settings",
    "processId": "only a tool step has a processId",
}
_BOOLEANS = frozenset(
    {"addToProject", "overwritePrevious", "filterInitialized", "unresolved"}
)
_CHOICES = {
    "destination": ("new", "existing"),
    "mode": ("simple", "custom"),
    "layerType": ("feature", "table", "raster"),
}
_OBJECTS = frozenset({"filter", "condition", "outputStyle"})
#: A dataset step's reference to its layer, which the editor's layer picker
#: (`DatasetNodeSettings`) replaces as one: a key it does not set goes.
_LAYER_GROUP = (
    "projectLayerId",
    "layerId",
    "layerName",
    "geometryType",
    "layerType",
    "filter",
)


def _check_data_value(key: str, value: Any) -> None:
    if value is None:
        if key == "label":
            raise _RefusedError("label cannot be removed.")
        return
    if key in _BOOLEANS:
        if not isinstance(value, bool):
            raise _RefusedError(f"{key} must be true or false.")
    elif key in _CHOICES:
        if value not in _CHOICES[key]:
            raise _RefusedError(f"{key} must be one of: {', '.join(_CHOICES[key])}.")
    elif key in _OBJECTS:
        if not isinstance(value, dict):
            raise _RefusedError(f"{key} must be an object.")
    elif key == "projectLayerId":
        if not (isinstance(value, int) and not isinstance(value, bool) and value > 0):
            raise _RefusedError(
                "projectLayerId must be a positive whole number, or null for a "
                "layer outside the project."
            )
    elif key == "customExpression":
        if not isinstance(value, str):
            raise _RefusedError("customExpression must be a string.")
    elif not isinstance(value, str) or not value.strip():
        raise _RefusedError(f"{key} must be a non-empty string.")


def _set_data(edit: _Edit, fields: Mapping[str, Any]) -> None:
    node = edit.node(_text(fields, "node_id"))
    given = fields["data"]
    if not isinstance(given, dict):
        raise _RefusedError("data must be an object of keys and values.")
    kind = _kind(node)
    if kind == "tool":
        raise _RefusedError(
            f"{node['id']!r} is a tool step; use set_settings for its settings "
            "and rename_node for its name."
        )
    if kind == "textAnnotation":
        raise _RefusedError(f"{node['id']!r} is a note; use set_note_text.")
    accepted = _DATA_KEYS[kind]
    for key, value in given.items():
        if key in RUN_STATE_KEYS:
            raise _RefusedError(f"{key} is written by a run; no operation sets it.")
        if key in _DATA_REFUSED:
            raise _RefusedError(f"{key}: {_DATA_REFUSED[key]}.")
        if key not in accepted:
            raise _RefusedError(
                f"{node['id']!r} is {_described(node)} without the key {key!r}; "
                f"its keys are: {', '.join(accepted)}."
            )
        _check_data_value(key, value)
    changes = {
        key: value.strip() if key == "label" else copy.deepcopy(value)
        for key, value in given.items()
    }
    if kind == "dataset":
        changes = _layer_changes(node, changes)
    data = _data(node)
    for key, value in changes.items():
        if value is None:
            data.pop(key, None)
        else:
            data[key] = value


def _layer_changes(node: Mapping[str, Any], changes: dict[str, Any]) -> dict[str, Any]:
    """A dataset step's changes with its layer reference replaced as one, as
    the editor's picker does: a new `layerId` drops the other reference keys
    not given, takes the layer's name as the label unless one is given, and
    marks the filter as set and the input as resolved. A null `layerId`
    leaves the step open for a person to choose its layer."""
    if "layerId" not in changes:
        loose = [key for key in _LAYER_GROUP if key in changes and key != "filter"]
        if loose:
            raise _RefusedError(
                f"{loose[0]} is part of the step's layer reference; give layerId "
                "with it."
            )
        return changes
    if changes["layerId"] is None:
        if changes.get("filter") is not None:
            raise _RefusedError(
                f"{node['id']!r}: a step left open takes no filter; choosing its "
                "layer replaces it."
            )
        return {**changes, **{key: None for key in _LAYER_GROUP}}
    swapped: dict[str, Any] = {key: None for key in _LAYER_GROUP}
    swapped.update(changes)
    if "label" not in changes and changes.get("layerName") is not None:
        swapped["label"] = changes["layerName"]
    swapped.setdefault("filterInitialized", True)
    swapped.setdefault("unresolved", False)
    return swapped


def _rename_node(edit: _Edit, fields: Mapping[str, Any]) -> None:
    node = edit.node(_text(fields, "node_id"))
    label = _text(fields, "label").strip()
    if _kind(node) == "textAnnotation":
        raise _RefusedError(
            f"{node['id']!r} is a note and has no name; change its text with "
            "set_note_text."
        )
    _data(node)["label"] = label


def _set_note_text(edit: _Edit, fields: Mapping[str, Any]) -> None:
    node = edit.node(_text(fields, "node_id"))
    text = _text(fields, "text")
    sizes = {name: fields.get(name) for name in ("width", "height")}
    _check_note_sizes(sizes)
    color = fields.get("color")
    if color is not None and not (
        isinstance(color, str) and _HEX_COLOR.fullmatch(color)
    ):
        raise _RefusedError("color must be a colour like #F2CE58.")
    if _kind(node) != "textAnnotation":
        raise _RefusedError(f"{node['id']!r} is {_described(node)}, not a note.")
    data = _data(node)
    data["text"] = text
    for name, size in sizes.items():
        if size is not None:
            data[name] = size
    if color is not None:
        data["backgroundColor"] = color


#: A note's colour as the editor stores it (`backgroundColor`).
_HEX_COLOR = re.compile(r"#[0-9A-Fa-f]{6}")
#: The largest coordinate a position may have, either way.
_POSITION_LIMIT = 1_000_000
#: The largest width or height a note may have.
_SIZE_LIMIT = 10_000


def _between(value: Any, low: float, high: float) -> TypeGuard[int | float]:
    """A number (not a boolean) from `low` to `high`. Compared without
    converting to float, so an integer beyond float's range is out of bounds,
    not an OverflowError; NaN and infinities compare false."""
    return (
        isinstance(value, int | float)
        and not isinstance(value, bool)
        and low <= value <= high
    )


def _coordinate(value: Any) -> TypeGuard[int | float]:
    return _between(value, -_POSITION_LIMIT, _POSITION_LIMIT)


def _note_size(value: Any) -> TypeGuard[int | float]:
    return _between(value, 0, _SIZE_LIMIT) and value > 0


def _position(value: Any) -> dict[str, Any]:
    if not (
        isinstance(value, dict)
        and set(value) == {"x", "y"}
        and _coordinate(value["x"])
        and _coordinate(value["y"])
    ):
        raise _RefusedError(
            'position must be {"x": <number>, "y": <number>}, each between '
            f"-{_POSITION_LIMIT} and {_POSITION_LIMIT}."
        )
    return {"x": value["x"], "y": value["y"]}


def _check_note_sizes(sizes: Mapping[str, Any]) -> None:
    for name, size in sizes.items():
        if size is not None and not _note_size(size):
            raise _RefusedError(
                f"{name} must be a positive number up to {_SIZE_LIMIT}."
            )


def _move_node(edit: _Edit, fields: Mapping[str, Any]) -> None:
    node = edit.node(_text(fields, "node_id"))
    position = _position(fields["position"])
    if "position" in node:
        node["position"] = position
        return
    index = next(i for i, other in enumerate(edit.nodes) if other is node)
    edit.nodes[index] = _with_position(node, position)


def _add_node(edit: _Edit, fields: Mapping[str, Any]) -> None:
    node = fields["node"]
    if not isinstance(node, dict):
        raise _RefusedError("node must be an object: a whole step or note.")
    node_id = node.get("id")
    if not isinstance(node_id, str) or not node_id:
        raise _RefusedError("the node's id must be a non-empty string.")
    if any(other["id"] == node_id for other in edit.nodes):
        raise _RefusedError(
            f"the id {node_id!r} is already in use; give the node another."
        )
    kind = node.get("type")
    if not isinstance(kind, str) or kind not in NODE_TYPES:
        raise _RefusedError(
            f"the node has an unknown type {kind!r}; the types are: "
            f"{', '.join(sorted(NODE_TYPES))}."
        )
    data = node.get("data")
    if not isinstance(data, dict):
        raise _RefusedError("the node's data must be an object.")
    if data.get("type") != kind:
        # The runner and the checks dispatch on `data.type`.
        raise _RefusedError(f"the node's data.type must be {kind!r}, its type.")
    if kind == "textAnnotation":
        _check_note_sizes({name: data.get(name) for name in ("width", "height")})
    if "position" in node:
        _position(node["position"])
    else:
        edit.unplaced.append(node_id)
    added = copy.deepcopy(node)
    # The editor's `addNode`: notes first, steps last.
    if kind == "textAnnotation":
        edit.nodes.insert(0, added)
    else:
        edit.nodes.append(added)


#: The layout of the assistant's drafts (`assistant.workflows.draft`): a
#: column per step of depth, the steps of a column a row apart.
_COLUMN = 360
_ROW = 200
#: A step's largest drawn size there; a note has its own (`data.width`,
#: `data.height`, the editor's defaults when missing).
_STEP_SIZE: tuple[float, float] = (360, 160)
_NOTE_SIZE: tuple[float, float] = (400, 200)
#: The space between the workflow and a node placed right of it.
_GAP = 40


class _Box:
    def __init__(self, x: float, y: float, width: float, height: float) -> None:
        self.x, self.y, self.width, self.height = x, y, width, height

    def overlaps(self, other: "_Box") -> bool:
        return (
            self.x < other.x + other.width
            and other.x < self.x + self.width
            and self.y < other.y + other.height
            and other.y < self.y + self.height
        )


def _size(node: Mapping[str, Any]) -> tuple[float, float]:
    """A node's size for placing others; a stored note size out of bounds
    counts as the editor's default (core checks only a config's shape)."""
    if node["type"] != "textAnnotation":
        return _STEP_SIZE
    data = node.get("data")
    data = data if isinstance(data, dict) else {}
    width, height = data.get("width"), data.get("height")
    return (
        width if _note_size(width) else _NOTE_SIZE[0],
        height if _note_size(height) else _NOTE_SIZE[1],
    )


def _box(node: Mapping[str, Any]) -> _Box | None:
    """Where a node lies, or None when its position is not two numbers
    within bounds."""
    position = node.get("position")
    if not (
        isinstance(position, dict)
        and _coordinate(position.get("x"))
        and _coordinate(position.get("y"))
    ):
        return None
    return _Box(position["x"], position["y"], *_size(node))


def _with_position(node: dict[str, Any], position: dict[str, Any]) -> dict[str, Any]:
    """The node, which has no position, with `position` after its type, where
    the editor keeps it."""
    placed: dict[str, Any] = {}
    for key, value in node.items():
        placed[key] = value
        if key == "type":
            placed["position"] = position
    return placed


def _free_spot(
    edit: _Edit, node: Mapping[str, Any], x: float, y: float
) -> tuple[float, float]:
    """(x, y), or the first spot whole rows below it that overlaps no node:
    each pass jumps below every node the spot overlaps, so it ends after at
    most one pass per node."""
    taken = [box for other in edit.nodes if (box := _box(other)) is not None]
    width, height = _size(node)
    start = y
    while overlapped := [
        box for box in taken if _Box(x, y, width, height).overlaps(box)
    ]:
        bottom = max(box.y + box.height for box in overlapped)
        y = start + math.ceil((bottom - start) / _ROW) * _ROW
    return x, y


def _place(edit: _Edit) -> None:
    """Gives each node added without a position one: a column right of the
    steps it reads from, else a column left of the steps it feeds, else right
    of the whole workflow; in the first free spot downwards from there. Nodes
    placed earlier count as placed, so a chain of new steps follows its first
    placed one."""
    by_id = {node["id"]: index for index, node in enumerate(edit.nodes)}
    pending = [
        node_id
        for node_id in dict.fromkeys(edit.unplaced)
        if node_id in by_id and "position" not in edit.nodes[by_id[node_id]]
    ]

    def boxes(ids: list[Any]) -> list[_Box]:
        found = (_box(edit.nodes[by_id[i]]) for i in ids if i in by_id)
        return [box for box in found if box is not None]

    def put(node_id: str, x: float, y: float) -> None:
        index = by_id[node_id]
        node = edit.nodes[index]
        x, y = _free_spot(edit, node, x, y)
        edit.nodes[index] = _with_position(node, {"x": round(x), "y": round(y)})

    while pending:
        progress = False
        for node_id in list(pending):
            edges = [edge for edge in edit.edges if isinstance(edge, dict)]
            sources = boxes(
                [e.get("source") for e in edges if e.get("target") == node_id]
            )
            targets = boxes(
                [e.get("target") for e in edges if e.get("source") == node_id]
            )
            if sources:
                x = max(box.x for box in sources) + _COLUMN
                y = sum(box.y for box in sources) / len(sources)
            elif targets:
                x = min(box.x for box in targets) - _COLUMN
                y = sum(box.y for box in targets) / len(targets)
            else:
                continue
            put(node_id, x, y)
            pending.remove(node_id)
            progress = True
        if progress:
            continue
        # Nothing left is connected to a placed node.
        node_id = pending.pop(0)
        placed = [box for node in edit.nodes if (box := _box(node)) is not None]
        if placed:
            x = max(box.x + box.width for box in placed) + _GAP
            y = min(box.y for box in placed)
        else:
            x = y = 0
        put(node_id, x, y)


#: Each operation: its function and its fields, required then optional.
_OPERATIONS: dict[
    str,
    tuple[Callable[[_Edit, Mapping[str, Any]], None], tuple[str, ...], tuple[str, ...]],
] = {
    "add_node": (_add_node, ("node",), ()),
    "remove_node": (_remove_node, ("node_id",), ()),
    "connect": (
        _connect,
        ("source", "target"),
        ("target_handle", "source_handle"),
    ),
    "disconnect": (_disconnect, ("source", "target"), ("target_handle",)),
    "set_settings": (_set_settings, ("node_id", "settings"), ()),
    "set_data": (_set_data, ("node_id", "data"), ()),
    "rename_node": (_rename_node, ("node_id", "label"), ()),
    "set_note_text": (
        _set_note_text,
        ("node_id", "text"),
        ("width", "height", "color"),
    ),
    "move_node": (_move_node, ("node_id", "position"), ()),
}


def _check_fields(
    fields: Mapping[str, Any], required: Sequence[str], optional: Sequence[str]
) -> None:
    accepted = (*required, *optional)
    unknown = [key for key in fields if key not in accepted]
    if unknown:
        raise _RefusedError(
            f"unknown field {unknown[0]!r}; the fields are: {', '.join(accepted)}."
        )
    missing = [name for name in required if fields.get(name) is None]
    if missing:
        raise _RefusedError(f"{missing[0]} is missing.")


def apply(
    config: Mapping[str, Any], operations: Sequence[Mapping[str, Any]]
) -> dict[str, Any]:
    """`config` with `operations` applied in order, as a new config.

    Raises OperationError for a damaged config (`checks.shape_issues`), an
    operation list that is not a list, and the first operation that cannot be
    applied; nothing is applied then.
    """
    damaged = shape_issues(config)
    if damaged:
        reasons = " ".join(issue.message for issue in damaged)
        raise OperationError(
            f"The workflow's stored configuration is damaged and cannot be edited: {reasons}"
        )
    if not isinstance(operations, list | tuple):
        raise OperationError("The operations must be a list.")
    edit = _Edit(copy.deepcopy(dict(config)))
    for index, operation in enumerate(operations):
        if not isinstance(operation, dict):
            raise OperationError(
                'an operation is an object with an "op" field.', index=index
            )
        name = operation.get("op")
        fields = {key: value for key, value in operation.items() if key != "op"}
        known = _OPERATIONS.get(name) if isinstance(name, str) else None
        if known is None:
            raise OperationError(
                f"unknown operation; the operations are: {', '.join(_OPERATIONS)}.",
                index=index,
                op=str(name) if name is not None else None,
            )
        run, required, optional = known
        try:
            _check_fields(fields, required, optional)
            run(edit, fields)
        except _RefusedError as refused:
            raise OperationError(str(refused), index=index, op=name) from None
    _place(edit)
    return edit.config
