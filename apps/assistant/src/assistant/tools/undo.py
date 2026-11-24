"""``undo_changes``: the dock's Undo (``assistant.undo.undo_run``) on a typed
request ("undo that").

The user means the last answer before the current one that changed
something (``_last_change``): answers without a change that landed, those
whose only change is an undo of this tool and those that read Undone are
passed over. When that answer's Undo can still act (``undoable``), the tool
makes the call the Undo route makes, under the user's own sign-in, so core
decides whether the user may still change the project, and that answer
reads Undone afterwards as after the button. When it cannot (a dataset
added, a layer removed, a workflow run, the view moved), nothing is written
and the result says what that answer did. One answer per request; the
current answer's own writes are never taken back. What was changed since
the answer's changes is not written: the result names it with the value of
a card option (``undo_anyway:<run>``) that, picked by the user
(``assistant.asks.consented``), writes over it in that answer's run. The
result carries no undo record: an Undo is not undone.
"""

import logging
from collections.abc import Iterable, Sequence
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from pydantic_ai.exceptions import ToolFailed

from assistant.asks import consented
from assistant.surfaces import Surface
from assistant.tools.runtime import ToolEnv, ToolSpec
from assistant.undo import (
    UNAVAILABLE,
    NothingToUndo,
    UndoOutcome,
    UndoRefused,
    UndoUnderWay,
    layers_removed,
    undo_run,
    undoable,
    undone,
    undone_parts,
)

logger = logging.getLogger(__name__)

#: The pages whose answers carry undo records: the map page's style, map
#: and workflow changes, the Workflows page's workflow edits.
UNDO_SURFACES: frozenset[Surface] = frozenset({"project.map", "project.workflows"})

#: The prefix of the card value that takes an answer's changes back over
#: what was changed since (``assistant.asks.CONSENT_PREFIXES``).
UNDO_ANYWAY = "undo_anyway:"

TOOK_BACK = "Took back what the earlier answer changed: {parts}."
NOT_TAKEN_BACK = (
    "Not taken back, because it was changed after the earlier answer changed "
    "it: {parts}."
)
NOTHING_LEFT = "Nothing of the earlier answer's changes was left to take back."
TOOK_BACK_PLAIN = "Took back what the earlier answer changed."
NOTHING = "No earlier answer of this conversation has changes left to take back."
CANNOT = (
    "The last answer's change cannot be taken back with undo: it {did}. "
    "Nothing was taken back."
)
ALSO = "It also {did}, which undo does not take back."
TAKEN_ALREADY = "These changes were taken back already."
#: ``confirm.changed`` when the names of what was changed since are not known.
CHANGED_SINCE = "something the earlier answer changed was changed since"
REMOVED = "Removed layers do not come back."
UNDER_WAY = "These changes are being taken back right now by another undo."
PARTIAL = (
    "A part of the style could not be put back because it no longer fits the data."
)
#: What did not come back, by ``UndoOutcome.not_restored``'s words.
NOT_RESTORED = {
    "layer_removed": REMOVED,
    "style": "A style could not be put back.",
    "group_in_use": "A group the answer added stays, because something is in it now.",
    "map_refused": "A change of the map could not be taken back: core refused it.",
}
CHANGED_NOTE = (
    "Nothing more is taken back without the user's pick. Ask with ask_user: "
    "one single-select question that says what was changed since "
    "(confirm.changed), with one option whose value is confirm.value, which "
    "takes it back anyway, and one option without a value that keeps it as "
    "it is. After the pick, call undo_changes again with confirm set to that "
    "value."
)
NOT_PICKED = (
    "This undo did not run: confirm counts only as the user's pick of its "
    "value in your card of this request."
)
NOT_THIS_ANSWER = (
    "This undo did not run: {value} names no answer whose changes can be "
    "taken back now."
)
NOT_HERE = "Changes cannot be taken back here."
#: What a write that leaves no undo record did, in words, by tool; a
#: ``map_update`` without a record moved the view (``_did``). Every write tool
#: but ``undo_changes`` is named here.
DID = {
    "map_update": "moved the map's view",
    "style_update": "changed a style",
    "workflow_update": "changed a workflow",
    "project_add_catalog_layer": "added a dataset from the catalog to the project",
    "project_add_dataset": "added a dataset to the project",
    "workflow_create": "created a workflow",
    "workflow_create_from_template": "created a workflow",
    "workflow_run": "ran a workflow",
}
REMOVED_A_LAYER = "removed a layer"
REPEATED_UNDO = (
    "You called undo_changes earlier in this answer; this is that result "
    "again, and nothing more was taken back."
)


class UndoChangesInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    confirm: str | None = Field(
        default=None,
        max_length=100,
        description=(
            "Leave it out, unless the user picked the option of your card "
            "that carried the value of an earlier result's confirm.value "
            "(undo_anyway:...): then send that value, and the changes go back "
            "over what was changed since."
        ),
    )


class UndoConfirm(BaseModel):
    """What the user is asked before the Undo writes over later changes."""

    #: The value of the card option that takes the changes back anyway.
    value: str
    #: What was changed since the answer's changes, by name.
    changed: str


Status = Literal["undone", "nothing", "changed", "under_way", "failed"]


class ChangesUndone(BaseModel):
    """``workflows``, ``styles``, ``map`` and ``not_restored`` have the shapes
    of the Undo route's 200 answer (``assistant.undo.undone_parts``)."""

    status: Status
    #: The run whose changes went back, or are asked about.
    run_id: str | None = None
    workflows: list[dict[str, Any]] = []
    styles: list[dict[str, Any]] = []
    map: dict[str, Any] | None = None
    not_restored: list[str] = []
    #: What went back, and what did not, by layer and workflow name.
    summary: str
    #: ``changed``: what to ask the user.
    confirm: UndoConfirm | None = None
    note: str | None = None


def _listed(parts: Sequence[str]) -> str:
    """``A``, ``A and B``, ``A, B and C``."""
    *others, last = parts
    return f"{', '.join(others)} and {last}" if others else last


class _Names:
    """Layer and workflow names, as core holds them after the Undo."""

    def __init__(self) -> None:
        self.layers: dict[int, str] = {}
        self.workflows: dict[str, str] = {}

    def layer(self, link: int) -> str:
        name = self.layers.get(link)
        return f'the layer "{name}"' if name else f"the layer {link}"

    def workflow(self, workflow_id: str) -> str:
        name = self.workflows.get(workflow_id)
        return f'the workflow "{name}"' if name else "a workflow"


async def _rows(env: ToolEnv, path: str) -> list[dict[str, Any]]:
    """A list core answers, empty when it cannot be read: a name is for the
    summary only, and nothing may fail once the Undo ran."""
    try:
        found = await env.call("core", "GET", path)
    except Exception:
        logger.info("undo_changes could not read %s", path, exc_info=True)
        return []
    return (
        [row for row in found if isinstance(row, dict)]
        if isinstance(found, list)
        else []
    )


async def _names(
    env: ToolEnv, outcome: UndoOutcome, records: Sequence[tuple[UUID, dict[str, Any]]]
) -> _Names:
    """The names the summary needs, read from the projects of what went
    back or is asked about."""
    names = _Names()
    layered = {item.project_id for item in outcome.styles}
    layered |= {item.project_id for item in outcome.changed_styles}
    layered |= {item.project_id for item in outcome.maps}
    if outcome.changed_map:
        layered |= {
            str(record["project_id"])
            for _, record in records
            if record.get("kind") == "map" and record.get("project_id")
        }
    for project_id in sorted(layered):
        for row in await _rows(env, f"/api/v2/project/{project_id}/layer"):
            if isinstance(row.get("id"), int) and row.get("name"):
                names.layers[row["id"]] = str(row["name"])
    flowed = {item.project_id for item in outcome.restored}
    flowed |= {item.project_id for item in outcome.changed}
    for project_id in sorted(flowed):
        for row in await _rows(env, f"/api/v2/project/{project_id}/workflow"):
            if row.get("id") is not None and row.get("name"):
                names.workflows[str(row["id"])] = str(row["name"])
    return names


def _layer_changes(
    records: Iterable[tuple[UUID, dict[str, Any]]],
) -> dict[int, list[str]]:
    """What the answer's map records changed of each layer, in words, in the
    order display, style, name, filter."""
    found: dict[int, set[str]] = {}
    for _, record in records:
        if record.get("kind") != "map" or not isinstance(record.get("changes"), list):
            continue
        for change in record["changes"]:
            link = change.get("layer_project_id") if isinstance(change, dict) else None
            if not isinstance(link, int):
                continue
            kind = change.get("object")
            written = change.get("written")
            if kind == "layer_state":
                fields = set(written) if isinstance(written, dict) else set()
                word = "style" if fields == {"active_style_id"} else "display"
            else:
                word = {"layer_name": "name", "filter": "filter"}.get(str(kind), "")
            if word:
                found.setdefault(link, set()).add(word)
    order = ("display", "style", "name", "filter")
    return {link: [w for w in order if w in words] for link, words in found.items()}


def _went_back(
    outcome: UndoOutcome, names: _Names, changes: dict[int, list[str]]
) -> list[str]:
    parts = [names.workflow(item.workflow_id) for item in outcome.restored]
    for style in outcome.styles:
        layer = names.layer(style.layer_project_id)
        parts.append(
            f"the style made for {layer}" if style.removed else f"the style of {layer}"
        )
    for went in outcome.maps:
        for link in went.layers:
            words = changes.get(link)
            layer = names.layer(link)
            parts.append(f"the {_listed(words)} of {layer}" if words else layer)
        parts += [
            text
            for flag, text in (
                (went.tree, "the order of the layers"),
                (went.groups, "the groups"),
                (went.basemap, "the basemap"),
                (went.scene, "the 3D scene"),
            )
            if flag
        ]
    return list(dict.fromkeys(parts))


_CHANGED_MAP = {
    "layer_state": "the display of {layer}",
    "layer_name": "the name of {layer}",
    "filter": "the filter of {layer}",
    "tree": "the order of the layers",
    "group_name": "the groups",
    "group_state": "the groups",
    "basemap": "the basemap",
    "scene": "the 3D scene",
}


def _asked(outcome: UndoOutcome, names: _Names) -> list[str]:
    parts = [names.workflow(item.workflow_id) for item in outcome.changed]
    parts += [
        f"the style of {names.layer(item.layer_project_id)}"
        for item in outcome.changed_styles
    ]
    for item in outcome.changed_map:
        layer = (
            names.layer(item.layer_project_id)
            if item.layer_project_id is not None
            else ""
        )
        parts.append(
            _CHANGED_MAP.get(item.object, "a part of the map").format(layer=layer)
        )
    return list(dict.fromkeys(parts))


def _said(outcome: UndoOutcome) -> list[str]:
    """The sentences on what does not come back."""
    sentences = [
        NOT_RESTORED[word] for word in outcome.not_restored if word in NOT_RESTORED
    ]
    if any(style.partial for style in outcome.styles):
        sentences.append(PARTIAL)
    return sentences


Calls = list[dict[str, Any]]
Records = list[tuple[UUID, dict[str, Any]]]


def _records(calls: Calls) -> Records:
    return [(call["id"], call["undo"]) for call in calls if call["undo"] is not None]


def _did(call: dict[str, Any]) -> str | None:
    """What a call without an undo record changed, in words; None for a
    read, a call that failed, ``undo_changes``, a workflow run that started
    nothing and a change of a style, a workflow or the map that landed
    nothing. A ``map_update`` without a
    record moved the view, unless it held a removal back for the user's
    pick, which it does before anything else (its operations are read from
    the audit's arguments)."""
    tool = call.get("tool")
    if tool not in DID or call["undo"] is not None:
        return None
    if call.get("status") != "ok" and not call.get("created"):
        return None
    if tool == "workflow_run" and not call.get("created"):
        # Refused by processes, or a wait on a run already going: a run the
        # tool started records its job as created (``RunSummary.created``).
        return None
    if tool in ("style_update", "workflow_update"):
        return None
    if tool == "map_update":
        operations = call["args"].get("operations")
        ops = {
            op.get("op")
            for op in (operations if isinstance(operations, list) else [])
            if isinstance(op, dict)
        }
        return DID[tool] if "set_view" in ops and "remove_layer" not in ops else None
    return DID[tool]


def _done(calls: Calls) -> list[str]:
    """What an answer changed that no Undo takes back, in words, each once."""
    said = [did for call in calls if (did := _did(call)) is not None]
    if layers_removed(_records(calls)):
        said.append(REMOVED_A_LAYER)
    return list(dict.fromkeys(said))


def _last_change(
    answers: Sequence[tuple[UUID, Calls]],
) -> tuple[UUID, Calls] | None:
    """The last answer that changed something, newest first: one with an
    undo record not all undone, or a change no Undo takes back. An answer
    that reads Undone is passed over, and so is one without such a change
    (reads, failed calls, ``undo_changes`` alone)."""
    for run_id, calls in reversed(answers):
        records = _records(calls)
        if records and undone(records):
            continue
        if records or _done(calls):
            return run_id, calls
    return None


def _forced(
    env: ToolEnv, answers: Sequence[tuple[UUID, Calls]], value: str
) -> tuple[UUID, Calls]:
    """The answer a picked ``undo_anyway:<run>`` names: a run of this
    conversation before the current one whose Undo can still act, picked by
    the user under the consent rule."""
    refused = ToolFailed(NOT_THIS_ANSWER.format(value=value))
    if not value.startswith(UNDO_ANYWAY):
        raise refused
    try:
        named = UUID(value.removeprefix(UNDO_ANYWAY))
    except ValueError as exc:
        raise refused from exc
    found = next((item for item in answers if item[0] == named), None)
    if found is None or not undoable(_records(found[1])):
        raise refused
    if value != f"{UNDO_ANYWAY}{named}":
        raise refused
    # The user's pick in a card of this request, read from the stored
    # conversation: never the model's word.
    if not consented(env.asks, value):
        raise ToolFailed(NOT_PICKED)
    return found


def _summary(
    outcome: UndoOutcome, names: "_Names", calls: Calls
) -> tuple[str, list[str]]:
    """The summary of what went back and what did not, and what is asked
    about."""
    records = _records(calls)
    went = _went_back(outcome, names, _layer_changes(records))
    asked = _asked(outcome, names)
    sentences = [TOOK_BACK.format(parts=_listed(went))] if went else []
    if asked:
        sentences.append(NOT_TAKEN_BACK.format(parts=_listed(asked)))
    elif not went:
        sentences.append(NOTHING_LEFT)
    sentences += _said(outcome)
    others = [did for did in _done(calls) if did != REMOVED_A_LAYER]
    if others:
        sentences.append(ALSO.format(did=_listed(others)))
    return " ".join(sentences), asked


async def _undo_changes(env: ToolEnv, args: UndoChangesInput) -> ChangesUndone:
    repo = env.repo
    if repo is None or env.run_id is None:
        raise ToolFailed(NOT_HERE)
    answers = await repo.calls_before(env.run_id)
    if args.confirm is not None:
        run_id, calls = _forced(env, answers, args.confirm)
    else:
        last = _last_change(answers)
        if last is None:
            return ChangesUndone(status="nothing", summary=NOTHING)
        run_id, calls = last
        if not undoable(_records(calls)):
            return ChangesUndone(
                status="nothing", summary=CANNOT.format(did=_listed(_done(calls)))
            )
    bearer = await env.bearer()
    # Nothing raises from here on: the Undo may have written already.
    try:
        outcome = await undo_run(
            repo, env.services, bearer, run_id, force=args.confirm is not None
        )
    except NothingToUndo as exc:
        if exc.undone:
            # The button took them back in between.
            return ChangesUndone(
                status="nothing", run_id=str(run_id), summary=TAKEN_ALREADY
            )
        return ChangesUndone(status="nothing", summary=NOTHING)
    except UndoUnderWay:
        return ChangesUndone(status="under_way", run_id=str(run_id), summary=UNDER_WAY)
    except UndoRefused as exc:
        return ChangesUndone(status="failed", run_id=str(run_id), summary=exc.message)
    except Exception:
        logger.exception("undo_changes failed")
        return ChangesUndone(status="failed", run_id=str(run_id), summary=UNAVAILABLE)
    changed = bool(outcome.changed or outcome.changed_styles or outcome.changed_map)
    value = f"{UNDO_ANYWAY}{run_id}"
    try:
        result = ChangesUndone(
            status="changed" if changed else "undone",
            run_id=str(run_id),
            summary=TOOK_BACK_PLAIN,
            **undone_parts(outcome),
        )
        names = await _names(env, outcome, _records(calls))
        result.summary, asked = _summary(outcome, names, calls)
        if changed:
            result.confirm = UndoConfirm(value=value, changed=_listed(asked))
            result.note = CHANGED_NOTE
    except Exception:
        # The words are for the model only; what went back is still said.
        logger.exception("undo_changes could not build its summary")
        try:
            result = ChangesUndone(
                status="changed" if changed else "undone",
                run_id=str(run_id),
                summary=TOOK_BACK_PLAIN,
                **undone_parts(outcome),
            )
        except Exception:
            result = ChangesUndone(
                status="changed" if changed else "undone",
                run_id=str(run_id),
                summary=TOOK_BACK_PLAIN,
            )
        if changed:
            result.confirm = UndoConfirm(value=value, changed=CHANGED_SINCE)
            result.note = CHANGED_NOTE
    if changed:
        # Only this answer's own call that asked lets its card offer the
        # value (``ToolEnv.confirm_values``).
        env.confirm_values.add(value)
    return result


UNDO_CHANGES: ToolSpec[UndoChangesInput, ChangesUndone] = ToolSpec(
    name="undo.changes",
    description=(
        "Take back what the last answer that changed something changed (its "
        "style changes, map changes and workflow edits), as the dock's undo "
        "button under that answer does; one answer per request, a second call "
        "in the same answer takes back nothing more, and an added dataset, a "
        "removed layer, a workflow run or the view do not come back. Call it "
        "when the user asks in words to undo, revert or take back what the "
        "last answer changed, never to set a new value the user names, which "
        "is an edit."
    ),
    input_model=UndoChangesInput,
    output_model=ChangesUndone,
    run=_undo_changes,
    surfaces=UNDO_SURFACES,
    risk="write",
    scope="goat:write",
    # A later answer takes back the next older answer; a second call in the
    # same answer gets the first one's result.
    repeatable=REPEATED_UNDO,
    # What the Undo writes back is what the style, map and workflow tools
    # change, whatever they named.
    invalidates=frozenset(
        {
            "project_get_layers",
            "style_get",
            "style_update",
            "map_update",
            "project_count_features",
            "project_field_statistics",
            "project_group_statistics",
            "project_area_statistics",
            "project_sample_features",
            "workflow_get",
            "project_get_workflows",
            "workflow_run",
            "workflow_last_run",
            "workflow_update",
        }
    ),
    same=frozenset(),
)

UNDO_TOOLS: tuple[ToolSpec[Any, Any], ...] = (UNDO_CHANGES,)
"""The tool that takes an answer's changes back."""
