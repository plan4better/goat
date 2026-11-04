"""Edits of a workflow that exists (``workflow_get``, ``workflow_update``).

The model changes a stored workflow with step-level operations: add a step as
``workflow_create``'s draft takes one, remove a step or note, change a tool
step's settings, a dataset step's layer or an export step's saved name,
rename a step, connect and disconnect steps, add a note or change its text.
``plan`` turns them into goatlib's low-level operations
(``goatlib.workflows.ops``), which apply them to a copy of the stored config.
A new step's node is built by the draft converter (``draft.step_data``,
``note_html``), so an edit writes what a create writes, and what
``workflow_create`` refuses (a tool outside the user's toolbox, a locked
layer, a layer input set as a setting) is refused here too.

The model names a step by its stored node id, the id ``workflow_view``
shows; a step or note added in the same call by the id it gave it; and one
of a workflow it created from a draft in the conversation also by its id in
the draft (``EditContext.draft_ids``), which it knows from writing the
draft. A new node's id is derived from that id and the call's salt, as
``to_config`` derives one: an export's node id names its result layer, so
no two workflows share one. Pure: the caller looks up the project's layers,
the regions' boundaries and the tools' titles and layer inputs.
"""

import json
import math
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import Annotated, Any, Literal, TypeGuard
from uuid import UUID

from goatlib.workflows.ops import OperationError
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator

from assistant.workflows.draft import (
    CANVAS_HEIGHT,
    CANVAS_WIDTH,
    EXPRESSIONS,
    INPUT_PATTERN,
    MAX_NOTE_CHARS,
    MAX_NOTES,
    NOTE_COLORS,
    NOTE_HEIGHT,
    NOTE_WIDTH,
    STEP_ID_PATTERN,
    Box,
    DatasetStep,
    DraftError,
    DraftNote,
    NoteColor,
    ProjectLayer,
    Region,
    Step,
    StepFilter,
    ToolStep,
    check_note_text,
    node_id,
    note_height,
    note_html,
    note_node_id,
    step_data,
    viewport,
)
from assistant.workflows.runs import Setting, step_settings

MAX_OPERATIONS = 30
#: The characters of a name or a condition's text value the view shows.
NAME_CHARS = 80
#: The entries of a condition's list value the view shows.
_LISTED_VALUES = 20
#: The characters of an If step's custom expression the view shows.
_EXPRESSION_CHARS = 300
#: The longest id of a stored step or note the model can name.
MAX_ID_CHARS = 200
#: The characters of a note's text the view shows at most.
_NOTE_TEXT_CHARS = MAX_NOTE_CHARS

#: A node's kind in the model's words.
_KINDS = {
    "dataset": "a dataset step",
    "tool": "a tool step",
    "export": "an export step",
    "if": "an If step",
    "textAnnotation": "a note",
}
#: goatlib's names for what the model's operations call otherwise.
_MODEL_TERMS = (
    ("source_handle", "branch"),
    ("target_handle", "input"),
    ("rename_node", "rename"),
)
_NOTE_TEXT_DESCRIPTION = (
    "Plain text in the language of the user's message, no HTML: a blank line "
    "starts a new paragraph, lines starting with '- ' form a list."
)


def _step_ref(value: str) -> str:
    if not value:
        raise ValueError("String should have at least 1 character")
    if len(value) > MAX_ID_CHARS:
        raise ValueError(f"String should have at most {MAX_ID_CHARS} characters")
    return value


#: A step or note named by an operation. Checked by a validator, which the
#: schema does not show: the operations' description says once what it is.
StepRef = Annotated[str, AfterValidator(_step_ref)]


class EditError(ValueError):
    """An operation the model has to change; the message says which and why."""


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class AddStep(_Model):
    op: Literal["add_step"]
    step: Step = Field(
        description=(
            "A step as workflow_create's draft takes it (dataset, tool or export), "
            "with an id of its own that later operations of this call can name. "
            "It is placed next to the steps it is connected to."
        )
    )


class AddNote(_Model):
    op: Literal["add_note"]
    id: str = Field(
        pattern=STEP_ID_PATTERN,
        description="An id of its own, which later operations of this call can name.",
    )
    text: str = Field(
        min_length=1,
        description=_NOTE_TEXT_DESCRIPTION,
        json_schema_extra={"maxLength": MAX_NOTE_CHARS},
    )
    color: NoteColor = Field(default="yellow", description="Default: yellow.")

    @model_validator(mode="after")
    def _says_something(self) -> "AddNote":
        check_note_text(self.id, self.text)
        return self


class Remove(_Model):
    op: Literal["remove"]
    id: StepRef


class SetSettings(_Model):
    op: Literal["set_settings"]
    id: StepRef
    settings: dict[str, Any] = Field(
        description=(
            "A tool step's settings by name, as workflow_describe_tool lists them. "
            "Each replaces that setting whole; null removes it; the others stay."
        )
    )


class SetLayer(_Model):
    op: Literal["set_layer"]
    id: StepRef
    layer: int | None = Field(
        ge=1,
        description=(
            "The project layer (layer_project_id from project_get_layers), or null "
            "to leave the step open for the user to choose."
        ),
    )
    label: str | None = Field(
        default=None,
        min_length=1,
        max_length=100,
        description=(
            "The step's name; default: the step's name on the same layer, else "
            "the layer's name. Required when layer is null: name what is missing."
        ),
    )
    filter: StepFilter | None = Field(
        default=None,
        description=(
            "Only with a layer: the step's whole new filter, replacing the one "
            "workflow_get shows (give its area again by nuts_id to keep it). Left "
            "out, the step keeps its filter on the same layer and has none on "
            "another."
        ),
    )
    remove_filter: bool = Field(
        default=False, description="Removes the step's filter on the same layer."
    )

    @model_validator(mode="after")
    def _open_steps_are_named_and_unfiltered(self) -> "SetLayer":
        if self.remove_filter and self.filter is not None:
            raise ValueError("remove_filter takes no filter")
        if self.layer is None:
            if self.label is None:
                raise ValueError(
                    "a step left open needs a label naming what is missing"
                )
            if self.filter is not None:
                raise ValueError(
                    "a step left open takes no filter; choosing its layer in the "
                    "editor replaces it"
                )
        return self


class SetExport(_Model):
    op: Literal["set_export"]
    id: StepRef
    name: str | None = Field(
        default=None,
        min_length=1,
        max_length=255,
        description="The name the result is saved as.",
    )
    add_to_project: bool | None = Field(
        default=None, description="Whether the saved result is added to the project."
    )
    overwrite_previous: bool | None = Field(
        default=None,
        description="Whether a run replaces the layer an earlier run saved.",
    )

    @model_validator(mode="after")
    def _changes_something(self) -> "SetExport":
        if (
            self.name is None
            and self.add_to_project is None
            and self.overwrite_previous is None
        ):
            raise ValueError(
                "set_export changes nothing: give name, add_to_project or "
                "overwrite_previous (rename changes the step's name)"
            )
        return self


class Rename(_Model):
    op: Literal["rename"]
    id: StepRef
    label: str = Field(min_length=1, max_length=100, description="The step's new name.")


class SetNoteText(_Model):
    op: Literal["set_note_text"]
    id: StepRef
    text: str = Field(
        min_length=1,
        description=_NOTE_TEXT_DESCRIPTION,
        json_schema_extra={"maxLength": MAX_NOTE_CHARS},
    )
    color: NoteColor | None = Field(default=None, description="Default: unchanged.")

    @model_validator(mode="after")
    def _says_something(self) -> "SetNoteText":
        check_note_text(self.id, self.text)
        return self


class Connect(_Model):
    op: Literal["connect"]
    source: StepRef = Field(alias="from")
    target: StepRef = Field(alias="to")
    input: str | None = Field(
        default=None,
        pattern=INPUT_PATTERN,
        description=(
            "The tool's layer input it feeds (layer_inputs of workflow_tools); "
            "none into an export or an If step."
        ),
    )
    branch: Literal["true", "false"] | None = Field(
        default=None,
        description="From an If step only: the branch the connection leaves from.",
    )


class Disconnect(_Model):
    op: Literal["disconnect"]
    source: StepRef = Field(alias="from")
    target: StepRef = Field(alias="to")
    input: str | None = Field(
        default=None,
        pattern=INPUT_PATTERN,
        description="Only the connection into this input; default: every one.",
    )


Operation = Annotated[
    AddStep
    | AddNote
    | Remove
    | SetSettings
    | SetLayer
    | SetExport
    | Rename
    | SetNoteText
    | Connect
    | Disconnect,
    Field(discriminator="op"),
]


class UpdateInput(_Model):
    workflow_id: UUID = Field(
        description="The workflow's id, from workflow_get or project_get_workflows."
    )
    operations: list[Operation] = Field(
        min_length=1,
        max_length=MAX_OPERATIONS,
        description=(
            "Applied in order, all or none. id, from and to name a step or note "
            "by the id workflow_get gives, in a workflow you created in this "
            "conversation also by its id in your draft, or one added earlier in "
            "this call by the id you gave it."
        ),
    )


@dataclass(frozen=True)
class EditContext:
    """What ``plan`` looks up: the project's readable layers and the names of
    its locked ones (by layer_project_id), the regions' boundaries (by
    nuts_id), the tools' titles, each tool's layer inputs (tool id -> their
    names, ``tool_info.layer_inputs``), the tools of the user's toolbox, the
    call's salt, and for a workflow created from a draft in the conversation
    its draft's step and note ids -> their node ids
    (``ConversationRuns.step_ids``)."""

    layers: Mapping[int, ProjectLayer]
    locked: Mapping[int, str]
    regions: Mapping[str, Region]
    titles: Mapping[str, str]
    layer_inputs: Mapping[str, frozenset[str]]
    toolbox: frozenset[str]
    salt: str
    draft_ids: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Planned:
    """goatlib's operations for the model's, one each."""

    operations: list[dict[str, Any]]
    #: For each of ``operations``, the model's operation it comes from.
    origin: list[tuple[int, str]]
    #: The id the model gave each step or note it added -> its node id.
    new_ids: dict[str, str] = field(default_factory=dict)

    def explain(self, error: OperationError) -> str:
        """goatlib's refusal in the model's terms: its operation's index and
        name, its field names, and a new step by the id the model gave it."""
        message = str(error)
        if error.index is None or not 0 <= error.index < len(self.origin):
            return message
        prefix = f"operation {error.index}" + (f" ({error.op})" if error.op else "")
        reason = message.removeprefix(prefix + ": ")
        for goat, model in _MODEL_TERMS:
            reason = reason.replace(goat, model)
        for given, node in self.new_ids.items():
            reason = reason.replace(node, given)
        index, op = self.origin[error.index]
        return f"operation {index} ({op}): {reason}"


def _items(value: Any) -> list[dict[str, Any]]:
    return (
        [item for item in value if isinstance(item, dict)]
        if isinstance(value, list)
        else []
    )


def _data(node: Mapping[str, Any]) -> dict[str, Any]:
    data = node.get("data")
    return data if isinstance(data, dict) else {}


class _Planner:
    def __init__(self, config: Mapping[str, Any], context: EditContext) -> None:
        self.context = context
        nodes = _items(config.get("nodes"))
        self.kinds = {str(node.get("id")): str(node.get("type")) for node in nodes}
        self.tools = {
            str(node.get("id")): tool
            for node in nodes
            if isinstance(tool := _data(node).get("processId"), str)
        }
        #: A dataset step's project layer, while it is chosen and resolved,
        #: and its name: set_layer on the same layer keeps both its name and
        #: its filter unless it is given new ones.
        self.layers = {
            str(node.get("id")): (
                data.get("projectLayerId")
                if data.get("layerId") and data.get("unresolved") is not True
                else None,
                data.get("label"),
            )
            for node in nodes
            if (data := _data(node)).get("type") == "dataset"
        }
        #: The notes the workflow may have after the edit: a draft's limit, or
        #: as many as it has, when a person made more.
        self.notes_allowed = max(
            MAX_NOTES, sum(node.get("type") == "textAnnotation" for node in nodes)
        )
        self.heights = {
            str(node.get("id")): height
            for node in nodes
            if isinstance(height := _data(node).get("height"), int | float)
            and not isinstance(height, bool)
        }
        self.new_ids: dict[str, str] = {}

    def _drafts(self) -> dict[str, str]:
        """The draft's ids whose node the workflow still has, each with its
        node id."""
        return {
            given: node
            for given, node in self.context.draft_ids.items()
            if node in self.kinds
        }

    def ref(self, given: str) -> str:
        """The node ``given`` names: a step or note added earlier in the call
        by the id the model gave it, a node by its id, or one by its draft's
        id. Refuses an id that names none, with the ids that do."""
        if given in self.new_ids:
            return self.new_ids[given]
        if given in self.kinds:
            return given
        drafts = self._drafts()
        if given in drafts:
            return drafts[given]
        named = {node: model for model, node in self.new_ids.items()}
        known = ", ".join(named.get(node, node) for node in self.kinds) or "none"
        message = (
            f"there is no step or note with the id {given!r}. The ids are: {known}."
        )
        if drafts:
            message += f" The ids of its draft name them too: {', '.join(drafts)}."
        raise EditError(message)

    def _is(self, node: str, kind: str, op: str, given: str) -> None:
        """Refuses ``op`` on a node of another kind."""
        found = self.kinds.get(node)
        if found is not None and found != kind:
            raise EditError(
                f"{given!r} is {_KINDS.get(found, 'a ' + found + ' step')}; {op} "
                f"changes {_KINDS[kind]}."
            )

    def _new_id(self, given: str, node: str) -> None:
        if (
            given in self.kinds
            or given in self.new_ids
            or given in self._drafts()
            or node in self.kinds
        ):
            raise EditError(
                f"{given!r} already names a step or note; give the new one an id "
                "of its own."
            )

    def _refuse_layer_settings(
        self, tool: str | None, settings: Mapping[str, Any]
    ) -> None:
        handles = self.context.layer_inputs.get(tool or "", frozenset())
        named = [key for key in settings if key in handles]
        if named:
            raise EditError(
                f"the settings set the layer input(s) {', '.join(named)} of {tool}. "
                "Leave them out of settings and connect a step to that input instead."
            )

    def _refuse_locked(self, layer: int | None) -> None:
        if layer is not None and layer in self.context.locked:
            raise EditError(
                f"{self.context.locked[layer]!r} is in the project, but the user has "
                "no access to its data. Choose another layer or leave the step open "
                "(layer null)."
            )

    def add_step(self, op: AddStep) -> dict[str, Any]:
        step = op.step
        node = node_id(step, self.context.salt)
        self._new_id(step.id, node)
        if isinstance(step, DatasetStep):
            self._refuse_locked(step.layer)
        if isinstance(step, ToolStep):
            if step.tool not in self.context.toolbox:
                raise EditError(
                    f"{step.tool!r} is not in the user's toolbox. Use only tools that "
                    "workflow_tools lists."
                )
            self._refuse_layer_settings(step.tool, step.settings)
            self.tools[node] = step.tool
        data = step_data(
            step,
            layers=self.context.layers,
            regions=self.context.regions,
            titles=self.context.titles,
            salt=self.context.salt,
        )
        if isinstance(step, DatasetStep):
            self.layers[node] = (step.layer, data.get("label"))
        self.kinds[node] = step.kind
        self.new_ids[step.id] = node
        return {"op": "add_node", "node": {"id": node, "type": step.kind, "data": data}}

    def add_note(self, op: AddNote) -> dict[str, Any]:
        notes = sum(kind == "textAnnotation" for kind in self.kinds.values())
        if notes >= self.notes_allowed:
            raise EditError(
                f"the workflow would have more than {MAX_NOTES} notes; change the "
                "text of a note instead (set_note_text)."
            )
        note = DraftNote(id=op.id, text=op.text, color=op.color)
        node = note_node_id(note, self.context.salt)
        self._new_id(op.id, node)
        height = note_height(op.text)
        self.kinds[node] = "textAnnotation"
        self.heights[node] = height
        self.new_ids[op.id] = node
        return {
            "op": "add_node",
            "node": {
                "id": node,
                "type": "textAnnotation",
                "data": {
                    "type": "textAnnotation",
                    "text": note_html(op.text),
                    "backgroundColor": NOTE_COLORS[op.color],
                    "width": NOTE_WIDTH,
                    "height": height,
                },
            },
        }

    def remove(self, op: Remove) -> dict[str, Any]:
        node = self.ref(op.id)
        self.kinds.pop(node, None)
        return {"op": "remove_node", "node_id": node}

    def set_settings(self, op: SetSettings) -> dict[str, Any]:
        node = self.ref(op.id)
        self._refuse_layer_settings(self.tools.get(node), op.settings)
        return {"op": "set_settings", "node_id": node, "settings": dict(op.settings)}

    def set_layer(self, op: SetLayer, index: int) -> dict[str, Any]:
        node = self.ref(op.id)
        self._is(node, "dataset", "set_layer", op.id)
        layer, label = self.layers.get(node, (None, None))
        if op.layer is None:
            assert op.label is not None  # SetLayer's own rule
            # As the draft converter writes a step left open: the editor then
            # takes the layer's own filter in when the user chooses it.
            changes: dict[str, Any] = {
                "layerId": None,
                "filterInitialized": None,
                "label": op.label,
            }
        else:
            self._refuse_locked(op.layer)
            step = DatasetStep(
                id=f"op{index}",
                kind="dataset",
                label=op.label,
                layer=op.layer,
                filter=op.filter,
            )
            try:
                data = step_data(
                    step,
                    layers=self.context.layers,
                    regions=self.context.regions,
                    titles=self.context.titles,
                    salt=self.context.salt,
                )
            except DraftError as exc:
                raise EditError(str(exc).removeprefix(f"step {step.id!r}: ")) from exc
            if op.layer == layer:
                # The same layer: only what is given changes, so a name or a
                # filter left out stays.
                changes = {}
                if op.label is not None:
                    changes["label"] = op.label
                if op.filter is not None or op.remove_filter:
                    changes["filter"] = data.get("filter")
                    changes["filterInitialized"] = True
            else:
                del data["type"]
                changes = data
        self.layers[node] = (op.layer, changes.get("label", label))
        return {"op": "set_data", "node_id": node, "data": changes}

    def set_export(self, op: SetExport) -> dict[str, Any]:
        node = self.ref(op.id)
        self._is(node, "export", "set_export", op.id)
        given = {
            "datasetName": op.name,
            "addToProject": op.add_to_project,
            "overwritePrevious": op.overwrite_previous,
        }
        changes = {key: value for key, value in given.items() if value is not None}
        return {"op": "set_data", "node_id": node, "data": changes}

    def rename(self, op: Rename) -> dict[str, Any]:
        node = self.ref(op.id)
        if node in self.layers:
            self.layers[node] = (self.layers[node][0], op.label)
        return {"op": "rename_node", "node_id": node, "label": op.label}

    def set_note_text(self, op: SetNoteText) -> dict[str, Any]:
        node = self.ref(op.id)
        operation: dict[str, Any] = {
            "op": "set_note_text",
            "node_id": node,
            "text": note_html(op.text),
        }
        # A note grows to show the whole text and otherwise keeps its size,
        # which the user may have chosen.
        needed = note_height(op.text)
        if needed > self.heights.get(node, NOTE_HEIGHT):
            operation["height"] = needed
            self.heights[node] = needed
        if op.color is not None:
            operation["color"] = NOTE_COLORS[op.color]
        return operation

    def connect(self, op: Connect) -> dict[str, Any]:
        operation: dict[str, Any] = {
            "op": "connect",
            "source": self.ref(op.source),
            "target": self.ref(op.target),
        }
        if op.input is not None:
            operation["target_handle"] = op.input
        if op.branch is not None:
            operation["source_handle"] = op.branch
        return operation

    def disconnect(self, op: Disconnect) -> dict[str, Any]:
        operation: dict[str, Any] = {
            "op": "disconnect",
            "source": self.ref(op.source),
            "target": self.ref(op.target),
        }
        if op.input is not None:
            operation["target_handle"] = op.input
        return operation

    def one(self, op: Operation, index: int) -> dict[str, Any]:
        if isinstance(op, AddStep):
            return self.add_step(op)
        if isinstance(op, AddNote):
            return self.add_note(op)
        if isinstance(op, Remove):
            return self.remove(op)
        if isinstance(op, SetSettings):
            return self.set_settings(op)
        if isinstance(op, SetLayer):
            return self.set_layer(op, index)
        if isinstance(op, SetExport):
            return self.set_export(op)
        if isinstance(op, Rename):
            return self.rename(op)
        if isinstance(op, SetNoteText):
            return self.set_note_text(op)
        if isinstance(op, Connect):
            return self.connect(op)
        return self.disconnect(op)


def plan(
    config: Mapping[str, Any], operations: Sequence[Operation], context: EditContext
) -> Planned:
    """goatlib's operations for the model's ``operations`` on the stored
    ``config``. Raises ``EditError`` for an operation that names a step or
    note the workflow does not have, a layer, a region or a tool it may not
    use, or a new id already in use; goatlib refuses the rest when it
    applies them (``Planned.explain``)."""
    planner = _Planner(config, context)
    out: list[dict[str, Any]] = []
    origin: list[tuple[int, str]] = []
    for index, operation in enumerate(operations):
        try:
            out.append(planner.one(operation, index))
        except (EditError, DraftError) as exc:
            raise EditError(f"operation {index} ({operation.op}): {exc}") from exc
        origin.append((index, operation.op))
    return Planned(out, origin, dict(planner.new_ids))


def changed_filters(
    before: Mapping[str, Any], after: Mapping[str, Any]
) -> list[tuple[str, int, list[str]]]:
    """The dataset steps whose filter the edit set or changed and that read
    a project layer: (node id, layer_project_id, the fields its conditions
    name), each step once with the filter it ends with. The fields are
    checked against the layer's, as ``workflow_create`` checks a draft's
    (``issues.filter_field_issues``)."""
    old = {str(node.get("id")): _data(node) for node in _items(before.get("nodes"))}
    found: list[tuple[str, int, list[str]]] = []
    for node in _items(after.get("nodes")):
        data, key = _data(node), str(node.get("id"))
        layer = data.get("projectLayerId")
        filter_ = data.get("filter")
        if (
            data.get("type") != "dataset"
            or not isinstance(layer, int)
            or isinstance(layer, bool)
            or not isinstance(filter_, dict)
            or filter_ == old.get(key, {}).get("filter")
        ):
            continue
        fields = [
            str(expression.get("attribute"))
            for expression in _items(filter_.get("expressions"))
            if expression.get("type") == "logical" and expression.get("attribute")
        ]
        if fields:
            found.append((key, layer, fields))
    return found


# -- the workflow as the model reads it ---------------------------------------------


class StepInput(BaseModel):
    model_config = ConfigDict(populate_by_name=True, serialize_by_alias=True)

    source: str = Field(alias="from")
    #: The tool's layer input; left out into an export or an If step.
    input: str | None = None
    #: The If step's branch the connection leaves from.
    branch: str | None = None


#: Under Restricted, what a view leaves out of a condition: the literals of
#: filters and conditions are values picked from the data
#: (``ProjectLayers.restricted``, ``runs._says_nothing``).
_LITERAL = "value"


def _without_values(rows: list[dict[str, Any]] | None) -> list[dict[str, Any]] | None:
    if rows is None:
        return None
    return [{key: item for key, item in row.items() if key != _LITERAL} for row in rows]


class FilterView(BaseModel):
    """A dataset step's filter in the draft's terms (``StepFilter``)."""

    #: The area's name, as the editor shows it; set_layer takes a nuts_id.
    area: str | None = None
    where: list[dict[str, Any]] | None = None
    #: Conditions the draft's operators do not express.
    other: int | None = None
    #: Under Restricted: the conditions' values are left out.
    values_withheld: bool | None = None

    def restricted(self) -> "FilterView":
        return self.model_copy(
            update={
                "where": _without_values(self.where),
                "values_withheld": True if self.where else None,
            }
        )


class StepView(BaseModel):
    id: str
    #: dataset, tool, export or if.
    kind: str
    name: str
    tool: str | None = None
    #: A tool step's settings, shortened as a run's summary shows them
    #: (``runs.step_settings``), with variables as their references.
    settings: dict[str, Setting] | None = None
    #: The settings shown in a shortened form (a list or an object as text, a
    #: text cut, a time of day): set_settings replaces them whole.
    shortened: list[str] | None = None
    #: A dataset step's project layer (layer_project_id) and its name.
    layer: int | None = None
    layer_name: str | None = None
    #: A dataset step whose layer is still to be chosen.
    open: bool | None = None
    filter: FilterView | None = None
    #: An export step's saved name and flags.
    saved_as: str | None = None
    add_to_project: bool | None = None
    overwrite_previous: bool | None = None
    #: An If step's mode, its condition's rows (simple) or its expression
    #: (custom), read only.
    mode: str | None = None
    condition: list[dict[str, Any]] | None = None
    expression: str | None = None
    #: Under Restricted: the values of the condition are left out.
    values_withheld: bool | None = None
    inputs: list[StepInput]

    def restricted(self) -> "StepView":
        withheld = bool(self.condition) or self.expression is not None
        return self.model_copy(
            update={
                "filter": self.filter.restricted() if self.filter else None,
                "condition": _without_values(self.condition),
                "expression": None,
                "values_withheld": True if withheld else None,
            }
        )


class NoteView(BaseModel):
    id: str
    text: str
    color: str | None = None


class VariableView(BaseModel):
    name: str
    type: str | None = None
    default: Setting | None = None
    #: Under Restricted: a text default can be a filter's or SQL's literal.
    default_withheld: bool | None = None

    def restricted(self) -> "VariableView":
        if not isinstance(self.default, str):
            return self.model_copy()
        return self.model_copy(update={"default": None, "default_withheld": True})


@dataclass(frozen=True)
class WorkflowView:
    steps: list[StepView]
    notes: list[NoteView]
    variables: list[VariableView]


def _text(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _clip(text: str, chars: int = NAME_CHARS) -> str:
    return text if len(text) <= chars else text[: chars - 1] + "…"


def _literal(value: Any) -> Any:
    """A condition's value as the view shows it: a text cut at
    ``NAME_CHARS``, a list at ``_LISTED_VALUES`` entries."""
    if isinstance(value, str):
        return _clip(value)
    if isinstance(value, list):
        return [_literal(item) for item in value[:_LISTED_VALUES]]
    return value


def step_name(node: Mapping[str, Any], titles: Mapping[str, str] | None = None) -> str:
    """A step's name, cut at ``NAME_CHARS``: its label; for a tool step
    without one, or whose label is the tool's id (the editor's label of a new
    step), the tool's title; then an export's saved name, the tool's id, its
    kind. The view, the changed steps and the check's messages
    (``tools.workflows.named_steps``) all name a step by it."""
    data = _data(node)
    label = _text(data.get("label"))
    tool = _text(data.get("processId"))
    if tool is not None and label in (None, tool):
        label = (titles or {}).get(tool, label)
    name = (
        label
        or _text(data.get("datasetName"))
        or tool
        or ("note" if node.get("type") == "textAnnotation" else None)
        or str(node.get("type") or data.get("type") or "step")
    )
    return _clip(" ".join(name.split()))


def _inputs(
    node_id_: str, edges: Sequence[Mapping[str, Any]], kinds: Mapping[str, str]
) -> list[StepInput]:
    kind = kinds.get(node_id_)
    found: list[StepInput] = []
    for edge in edges:
        if edge.get("target") != node_id_ or not isinstance(edge.get("source"), str):
            continue
        handle = _text(edge.get("targetHandle"))
        if kind == "tool":
            handle = handle or "input_layer_id"
        elif handle == "input":
            handle = None
        branch = (
            _text(edge.get("sourceHandle"))
            if kinds.get(edge["source"]) == "if"
            else None
        )
        found.append(
            StepInput.model_validate(
                {"from": edge["source"], "input": handle, "branch": branch}
            )
        )
    return found


#: The editor's filter expressions as the draft's operators.
_OPERATORS = {expression: op for op, expression in EXPRESSIONS.items()}


def _area_name(value: Any) -> str:
    """The name an area filter's geometry carries (``draft.dataset_filter``)."""
    try:
        geometry = json.loads(value) if isinstance(value, str) else None
    except ValueError:
        geometry = None
    properties = geometry.get("properties") if isinstance(geometry, dict) else None
    label = properties.get("label") if isinstance(properties, dict) else None
    return _text(label) or "an area"


def _filter_view(data: Mapping[str, Any]) -> FilterView | None:
    filter_ = data.get("filter")
    expressions = (
        _items(filter_.get("expressions")) if isinstance(filter_, dict) else []
    )
    if not expressions:
        return None
    view = FilterView()
    where: list[dict[str, Any]] = []
    other = 0
    for expression in expressions:
        op = _OPERATORS.get(str(expression.get("expression")))
        if expression.get("type") == "spatial" and view.area is None:
            view.area = _area_name(expression.get("value"))
        elif expression.get("type") == "logical" and op is not None:
            where.append(
                {
                    "field": expression.get("attribute"),
                    "op": op,
                    "value": _literal(expression.get("value")),
                }
            )
        else:
            other += 1
    view.where = where or None
    view.other = other or None
    return view


def _condition(data: Mapping[str, Any]) -> list[dict[str, Any]] | None:
    """An If step's simple condition, row by row: a statistic as its method,
    field, operator and value; a logical row as the dataset filter's."""
    condition = data.get("condition")
    rows: list[dict[str, Any]] = []
    for row in _items(
        condition.get("expressions") if isinstance(condition, dict) else None
    ):
        if row.get("kind") == "statistic":
            found = {
                "method": row.get("method"),
                "field": row.get("field") or None,
                "op": row.get("operator"),
                "value": _literal(row.get("value")),
            }
        else:
            expression = str(row.get("expression"))
            found = {
                "field": row.get("attribute"),
                "op": _OPERATORS.get(expression, expression),
                "value": _literal(row.get("value")),
            }
        rows.append({key: item for key, item in found.items() if item is not None})
    return rows or None


def _shortened(
    data: Mapping[str, Any], shown: Mapping[str, Setting] | None
) -> list[str] | None:
    """The shown settings whose value differs from the stored one."""
    config = data.get("config")
    if not shown or not isinstance(config, dict):
        return None
    found = [
        name
        for name, value in shown.items()
        if value
        != (config[name].strip() if isinstance(config[name], str) else config[name])
    ]
    return found or None


def _step(
    node: Mapping[str, Any],
    edges: Sequence[Mapping[str, Any]],
    kinds: Mapping[str, str],
    titles: Mapping[str, str],
) -> StepView:
    data = _data(node)
    node_key = str(node.get("id"))
    kind = str(node.get("type"))
    view = StepView(
        id=node_key,
        kind=kind,
        name=step_name(node, titles),
        inputs=_inputs(node_key, edges, kinds),
    )
    if kind == "tool":
        view.tool = _text(data.get("processId"))
        # Variables stay references: an edit of the setting replaces the
        # reference, and the variables list their values.
        view.settings = step_settings(data, {})
        view.shortened = _shortened(data, view.settings)
    elif kind == "if":
        view.mode = _text(data.get("mode"))
        view.condition = _condition(data) if view.mode != "custom" else None
        expression = _text(data.get("customExpression"))
        if view.mode == "custom" and expression is not None:
            view.expression = _clip(expression, _EXPRESSION_CHARS)
    elif kind == "dataset":
        if not data.get("layerId") or data.get("unresolved") is True:
            view.open = True
        else:
            project_layer = data.get("projectLayerId")
            if isinstance(project_layer, int) and not isinstance(project_layer, bool):
                view.layer = project_layer
            view.layer_name = _text(data.get("layerName"))
            view.filter = _filter_view(data)
    elif kind == "export":
        view.saved_as = _text(data.get("datasetName"))
        for key, name in (
            ("addToProject", "add_to_project"),
            ("overwritePrevious", "overwrite_previous"),
        ):
            if isinstance(data.get(key), bool):
                setattr(view, name, data[key])
    return view


class _NoteText(HTMLParser):
    """The text of the editor's note HTML (TipTap): paragraphs apart by a
    blank line, ``<br>`` a line break, each list item a line with "- "."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.pieces: list[str | int] = []
        self.items = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "br":
            self.pieces.append("\n")
        elif tag == "li":
            self.items += 1
            self.pieces.extend((1, "- "))
        elif tag in ("ul", "ol") or (tag == "p" and not self.items):
            self.pieces.append(2)

    def handle_endtag(self, tag: str) -> None:
        if tag == "li":
            self.items = max(0, self.items - 1)
        elif tag in ("ul", "ol") or (tag == "p" and not self.items):
            self.pieces.append(2)

    def handle_data(self, data: str) -> None:
        self.pieces.append(data)

    def text(self) -> str:
        out: list[str] = []
        pending = 0
        for piece in self.pieces:
            if isinstance(piece, int):
                pending = max(pending, piece)
                continue
            if out and pending:
                out.append("\n" * pending)
            pending = 0
            out.append(piece)
        return "".join(out).strip()


def note_text(markup: str) -> str:
    """A note's HTML as plain text, the way ``note_html`` reads it back."""
    parser = _NoteText()
    parser.feed(markup)
    parser.close()
    text = parser.text()
    if len(text) > _NOTE_TEXT_CHARS:
        text = text[: _NOTE_TEXT_CHARS - 1] + "…"
    return text


def _color(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    return next(
        (name for name, hex_ in NOTE_COLORS.items() if hex_.lower() == value.lower()),
        None,
    )


def _variables(config: Mapping[str, Any]) -> list[VariableView]:
    found: list[VariableView] = []
    for variable in _items(config.get("variables")):
        name = _text(variable.get("name"))
        if name is None:
            continue
        default = variable.get("defaultValue")
        found.append(
            VariableView(
                name=name,
                type=_text(variable.get("type")),
                default=default
                if isinstance(default, str | int | float)
                and not isinstance(default, bool)
                else None,
            )
        )
    return found


def workflow_view(
    config: Mapping[str, Any], titles: Mapping[str, str] | None = None
) -> WorkflowView:
    """The stored ``config`` as the model reads it: each step in config order
    with its id, kind, name, what it is set to and its inputs; the notes'
    text; the variables. ``titles`` names tool steps without a label."""
    nodes = [node for node in _items(config.get("nodes")) if node.get("id") is not None]
    edges = _items(config.get("edges"))
    kinds = {str(node["id"]): str(node.get("type")) for node in nodes}
    steps: list[StepView] = []
    notes: list[NoteView] = []
    for node in nodes:
        if node.get("type") == "textAnnotation":
            data = _data(node)
            markup = data.get("text")
            notes.append(
                NoteView(
                    id=str(node["id"]),
                    text=note_text(markup) if isinstance(markup, str) else "",
                    color=_color(data.get("backgroundColor")),
                )
            )
        else:
            steps.append(_step(node, edges, kinds, titles or {}))
    return WorkflowView(steps=steps, notes=notes, variables=_variables(config))


# -- what an edit changed -------------------------------------------------------------


class ChangedStep(BaseModel):
    id: str
    #: dataset, tool, export, if or note.
    kind: str
    name: str
    change: Literal["added", "changed", "removed"]
    #: The id the model gave a step or note it added.
    given_id: str | None = None


def _feeds(edges: Sequence[Mapping[str, Any]]) -> dict[str, set[tuple[Any, ...]]]:
    """What feeds each node: (source, sourceHandle, targetHandle) per edge."""
    found: dict[str, set[tuple[Any, ...]]] = {}
    for edge in edges:
        target = edge.get("target")
        if isinstance(target, str):
            found.setdefault(target, set()).add(
                (
                    edge.get("source"),
                    edge.get("sourceHandle") or None,
                    edge.get("targetHandle") or None,
                )
            )
    return found


def _changed(node: Mapping[str, Any], change: str, given: str | None) -> ChangedStep:
    kind = str(node.get("type"))
    return ChangedStep(
        id=str(node.get("id")),
        kind="note" if kind == "textAnnotation" else kind,
        name=step_name(node),
        change=change,  # type: ignore[arg-type]
        given_id=given,
    )


def changed_steps(
    before: Mapping[str, Any], after: Mapping[str, Any], new_ids: Mapping[str, str]
) -> list[ChangedStep]:
    """The steps and notes an edit added, changed (the node, or what feeds
    it) or removed, in the order of ``after``, the removed ones last."""
    old = {str(node.get("id")): node for node in _items(before.get("nodes"))}
    new = {str(node.get("id")): node for node in _items(after.get("nodes"))}
    fed_before = _feeds(_items(before.get("edges")))
    fed_after = _feeds(_items(after.get("edges")))
    given = {node: model for model, node in new_ids.items()}
    found: list[ChangedStep] = []
    for key, node in new.items():
        if key not in old:
            found.append(_changed(node, "added", given.get(key)))
        elif node != old[key] or fed_before.get(key) != fed_after.get(key):
            found.append(_changed(node, "changed", None))
    found.extend(
        _changed(node, "removed", None) for key, node in old.items() if key not in new
    )
    return found


# -- the view after a new step was placed --------------------------------------------


#: goatlib's bound on a position (``goatlib.workflows.ops``): a stored node
#: outside it has no place in the view, as goatlib's placement reads it.
_POSITION_LIMIT = 1_000_000


def _number(value: Any) -> TypeGuard[int | float]:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return False
    return not isinstance(value, float) or math.isfinite(value)


def _coordinate(value: Any) -> TypeGuard[int | float]:
    return _number(value) and -_POSITION_LIMIT <= value <= _POSITION_LIMIT


def _box(node: Mapping[str, Any]) -> Box | None:
    position = node.get("position")
    if not isinstance(position, dict):
        return None
    x, y = position.get("x"), position.get("y")
    if not (_coordinate(x) and _coordinate(y)):
        return None
    if node.get("type") != "textAnnotation":
        return Box(round(x), round(y))
    data = _data(node)
    width, height = data.get("width"), data.get("height")
    return Box(
        round(x),
        round(y),
        round(width) if _number(width) and 0 < width <= 10_000 else NOTE_WIDTH,
        round(height) if _number(height) and 0 < height <= 10_000 else NOTE_HEIGHT,
    )


def _shows(view: Any, boxes: Sequence[Box]) -> bool:
    """Whether the stored viewport shows every box on a canvas of
    ``CANVAS_WIDTH`` by ``CANVAS_HEIGHT``, the size the draft's viewport is
    fitted to."""
    if not isinstance(view, dict):
        return False
    x, y, zoom = view.get("x"), view.get("y"), view.get("zoom")
    if not (_number(x) and _number(y) and _number(zoom)) or zoom <= 0:
        return False
    return all(
        box.x * zoom + x >= 0
        and box.y * zoom + y >= 0
        and box.right * zoom + x <= CANVAS_WIDTH
        and box.bottom * zoom + y <= CANVAS_HEIGHT
        for box in boxes
    )


def refit(config: dict[str, Any], added: Collection[str]) -> dict[str, Any]:
    """``config`` with a viewport that shows every step and note, when the
    stored one does not show a node of ``added``; else ``config`` itself.
    The editor opens a workflow at its stored view, and core does not count
    a viewport change as an edit."""
    boxes = {
        str(node.get("id")): box
        for node in _items(config.get("nodes"))
        if (box := _box(node)) is not None
    }
    placed = [boxes[key] for key in added if key in boxes]
    if not placed or _shows(config.get("viewport"), placed):
        return config
    return {**config, "viewport": viewport(boxes.values())}
