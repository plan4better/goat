"""workflow.get and workflow.update: the assistant reads a workflow of the
open project and changes it. On the Map and Workflows pages, never over MCP.

An edit is a list of operations (``assistant.workflows.edits``) that goatlib
applies to the stored config, off the event loop. The result is checked as
``workflow_create`` checks a draft (processes' check, and the assistant's
check of the filters an edit sets), and so is the stored config, both at
once: an edit that adds an issue that stops a run, one the user cannot
resolve by choosing a layer, is refused before anything is saved; one the
workflow already had does not stop it. The edit is saved through core's PUT
on the revision it was read at (``base_revision``), so a change made
elsewhere in between is a conflict, never overwritten. The call's audit row
keeps the config before the edit and both revisions
(``WorkflowUpdated.undo``), which the dock's Undo writes back.

A workflow's filters and If conditions hold literals picked from the data,
so ``workflow_get`` is subject to the data policy (``StoredWorkflow.restricted``).
``workflow_update`` answers with ids, names and the check's issues only.
"""

import asyncio
import re
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID, uuid4

from goatlib.workflows.checks import shape_issues
from goatlib.workflows.ops import OperationError, apply
from pydantic import BaseModel, ConfigDict, Field
from pydantic_ai.exceptions import ToolFailed

from assistant.tools.http import SIGN_IN_EXPIRED, ServiceError, sign_in_expired
from assistant.tools.project import GET_WORKFLOWS
from assistant.tools.runtime import InputInvalid, ToolEnv, ToolSpec
from assistant.tools.workflow_runs import LAST_RUN, NOT_IN_PROJECT, RUN
from assistant.tools.workflow_tools import WORKFLOW_SURFACES
from assistant.tools.workflows import (
    MAX_LISTED_ISSUES,
    Descriptions,
    checked_issues,
    config_graph,
    describe_tools,
    layer_fields,
    named_steps,
    open_project,
    project_layers,
    read_regions,
    read_toolbox,
    split_blocking,
    tool_titles,
)
from assistant.workflows import tool_info
from assistant.workflows.draft import (
    MAX_STEPS,
    TOOL_ID_PATTERN,
    Converted,
    DatasetStep,
    ProjectLayer,
    ToolStep,
)
from assistant.workflows.edits import (
    AddStep,
    ChangedStep,
    EditContext,
    EditError,
    NoteView,
    Operation,
    SetLayer,
    StepView,
    UpdateInput,
    VariableView,
    changed_filters,
    changed_steps,
    plan,
    refit,
    step_name,
    workflow_view,
)
from assistant.workflows.issues import (
    BLOCKING_LEVELS,
    FILTER_FIELD_CODE,
    DraftIssue,
    field_list,
)

VIEWER_EDITS = "You can view this project but not change its workflows."
CHANGED_ELSEWHERE = (
    "Not saved: the workflow was changed elsewhere while you edited it. Read it "
    "again with workflow_get and send your operations for what it holds now."
)
EDIT_UNCHECKED = (
    "Not saved: the changed workflow could not be checked right now. Try again in "
    "a moment."
)
TOOLBOX_UNREAD = (
    "Not saved: the user's toolbox could not be read right now, so a new tool "
    "step cannot be checked. Try again in a moment."
)
NO_REVISION = (
    "The workflow came without its revision, so it cannot be saved safely; nothing "
    "was changed. Try again in a moment."
)
DAMAGED = "Not changed: the workflow's stored configuration is damaged ({reasons})."
DAMAGED_NOTE = (
    "The workflow's stored configuration is damaged, so its steps cannot be read "
    "and workflow_update refuses to change it. Tell the user."
)
CHECK_UNAVAILABLE = "The editor's check could not run right now."
CHECK_REFUSED = "The editor's check refused the stored workflow: {reason}"
NOTHING_CHANGED = "The operations change nothing, so nothing was saved."
SAVED_REVISION_UNKNOWN = (
    "Saved, but core did not say which revision the workflow has now, so the "
    "user cannot undo this edit from the dock. Read the workflow again with "
    "workflow_get before you change it again, and tell the user."
)
SAVED = "Saved. issues lists what is left for the user (an open layer) and warnings."
EXISTING = (
    " {count} issue(s) that stop a run were there before this edit (existing): "
    "tell the user the workflow does not run yet."
)
REPEATED_EDIT = (
    "You made this edit earlier in this answer; this is its result again. Nothing "
    "was changed again."
)
GET_NOTE = (
    "A tool step's settings are shortened (shortened names the ones not shown "
    "whole) and leave out ids, filters and the names results are saved under; "
    "set_settings replaces a setting whole. Change the workflow with "
    "workflow_update, naming steps and notes by these ids."
)


class GetInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    workflow_id: UUID = Field(
        description="The workflow's id, from project_get_workflows or a workflow you created."
    )


class IssueView(BaseModel):
    #: The step's id, for an issue of one step.
    id: str | None = None
    step: str | None = None
    code: str
    level: str
    message: str
    #: Whether it stops a run; an open layer and a warning do not.
    blocking: bool
    #: After an edit: a blocking issue the workflow had before it, which did
    #: not stop the edit.
    existing: bool | None = None


class StoredWorkflow(BaseModel):
    workflow_id: str
    name: str
    revision: int
    steps: list[StepView]
    notes: list[NoteView]
    variables: list[VariableView] | None = None
    #: Whether processes' check ran; issues is empty when it did not.
    checked: bool
    #: Why the check did not run.
    unchecked: str | None = None
    issues: list[IssueView]
    #: Why the stored configuration cannot be read as a workflow.
    damaged: str | None = None
    note: str

    def restricted(self) -> "StoredWorkflow":
        """Without the literals of filters and If conditions, nor the text
        defaults of variables, which can be such literals: values picked
        from the data (``ProjectLayers.restricted``)."""
        return self.model_copy(
            update={
                "steps": [step.restricted() for step in self.steps],
                "variables": (
                    [variable.restricted() for variable in self.variables]
                    if self.variables is not None
                    else None
                ),
            }
        )


class WorkflowUpdated(BaseModel):
    workflow_id: str
    revision_before: int
    revision_after: int
    changed_steps: list[ChangedStep]
    issues: list[IssueView]
    note: str
    #: For the audit row only (``undo``), never serialized.
    project_id: str = Field(exclude=True)
    before: dict[str, Any] | None = Field(default=None, exclude=True)

    def undo(self) -> dict[str, Any] | None:
        """What the dock's Undo needs: the config before the edit and the
        revisions around it. None when the edit changed nothing that core
        counts as a change."""
        if self.before is None or self.revision_after == self.revision_before:
            return None
        return {
            "kind": "workflow",
            "workflow_id": self.workflow_id,
            "project_id": self.project_id,
            "revision_before": self.revision_before,
            "revision_after": self.revision_after,
            "before": {"config": self.before},
        }


async def _read(env: ToolEnv, project_id: UUID, workflow_id: str) -> dict[str, Any]:
    """The workflow's row as core stores it; refused for a workflow outside
    the open project (core answers 401 for missing rights too)."""
    try:
        row = await env.call(
            "core", "GET", f"/api/v2/project/{project_id}/workflow/{workflow_id}"
        )
    except ServiceError as exc:
        if sign_in_expired(exc):
            raise ToolFailed(SIGN_IN_EXPIRED) from exc
        if exc.status in (401, 403, 404):
            raise ToolFailed(NOT_IN_PROJECT) from exc
        raise
    return row if isinstance(row, dict) else {}


def _revision(row: Mapping[str, Any]) -> int | None:
    value = row.get("revision")
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _tools(config: Mapping[str, Any]) -> set[str]:
    """The tools the config's steps use, of the ids a tool can have; at most
    as many as a draft can hold are described."""
    nodes = config.get("nodes")
    found: set[str] = set()
    for node in nodes if isinstance(nodes, list) else []:
        data = node.get("data") if isinstance(node, dict) else None
        tool = data.get("processId") if isinstance(data, dict) else None
        if isinstance(tool, str) and re.fullmatch(TOOL_ID_PATTERN, tool):
            found.add(tool)
    return set(sorted(found)[:MAX_STEPS])


@dataclass(frozen=True)
class Checked:
    """A config's issues as the editor's check sees them (errors and
    warnings), the blocking ones among them as ``workflow_create`` judges a
    draft's, and the steps' names by node id."""

    issues: list[DraftIssue]
    blocking: list[DraftIssue]
    names: dict[str, str]


async def _check(
    env: ToolEnv,
    project_id: UUID,
    config: Mapping[str, Any],
    descriptions: Descriptions | None,
) -> Checked | None:
    """``config`` checked by processes; None when the check could not run
    now. A config processes refuses goes back as ``InputInvalid``."""
    if descriptions is None:
        return None
    named, names = named_steps(config, tool_titles(descriptions))
    ids = {key: key for key in names}
    found = await checked_issues(
        env,
        project_id,
        Converted(config=named, node_ids=ids, step_of=ids, labels=names),
    )
    if found is None:
        return None
    issues = [
        issue
        for issue in found
        if issue.level in BLOCKING_LEVELS or issue.level == "warning"
    ]
    blocking, _ = split_blocking(config_graph(config), descriptions, issues)
    return Checked(issues=issues, blocking=blocking, names=names)


def _views(checked: Checked, existing: Sequence[DraftIssue] = ()) -> list[IssueView]:
    stops = {id(issue) for issue in checked.blocking}
    kept = {id(issue) for issue in existing}
    views: list[IssueView] = []
    for issue in checked.issues:
        step = issue.steps[0] if len(issue.steps) == 1 else None
        views.append(
            IssueView(
                id=step,
                step=checked.names.get(step) if step else None,
                code=issue.code,
                level=issue.level,
                message=issue.message,
                blocking=id(issue) in stops,
                existing=True if id(issue) in kept else None,
            )
        )
    return views


async def _get(env: ToolEnv, args: GetInput) -> StoredWorkflow:
    project_id = open_project(env)
    workflow_id = str(args.workflow_id)
    row = await _read(env, project_id, workflow_id)
    config = row.get("config")
    name = str(row.get("name") or "")
    revision = _revision(row) or 0
    damaged = shape_issues(config)
    if damaged or not isinstance(config, dict):
        return StoredWorkflow(
            workflow_id=workflow_id,
            name=name,
            revision=revision,
            steps=[],
            notes=[],
            checked=False,
            issues=[],
            damaged=" ".join(issue.message for issue in damaged),
            note=DAMAGED_NOTE,
        )
    descriptions = await describe_tools(env, _tools(config))
    view = workflow_view(config, tool_titles(descriptions))
    unchecked: str | None = CHECK_UNAVAILABLE
    try:
        checked = await _check(env, project_id, config, descriptions)
    except InputInvalid as exc:
        checked, unchecked = None, CHECK_REFUSED.format(reason=exc.message)
    return StoredWorkflow(
        workflow_id=workflow_id,
        name=name,
        revision=revision,
        steps=view.steps,
        notes=view.notes,
        variables=view.variables or None,
        checked=checked is not None,
        unchecked=None if checked is not None else unchecked,
        issues=_views(checked) if checked is not None else [],
        note=GET_NOTE,
    )


GET: ToolSpec[GetInput, StoredWorkflow] = ToolSpec(
    name="workflow.get",
    description=(
        "Read a workflow of the open project as workflow_update changes it: each "
        "step with its id, kind, name, tool, settings and inputs (the steps that "
        "feed it), each note's id and text, the variables, the issues of the "
        "editor's check and the revision. Read a workflow before you change it."
    ),
    input_model=GetInput,
    output_model=StoredWorkflow,
    run=_get,
    surfaces=WORKFLOW_SURFACES,
    returns_data=True,
)


def _added_tools(operations: Iterable[Operation]) -> set[str]:
    return {
        op.step.tool
        for op in operations
        if isinstance(op, AddStep) and isinstance(op.step, ToolStep)
    }


def _layers_needed(operations: Iterable[Operation]) -> bool:
    return any(
        (isinstance(op, AddStep) and isinstance(op.step, DatasetStep))
        or (isinstance(op, SetLayer) and op.layer is not None)
        for op in operations
    )


def _areas(operations: Iterable[Operation]) -> set[str]:
    found: set[str] = set()
    for op in operations:
        step_filter = (
            op.step.filter
            if isinstance(op, AddStep) and isinstance(op.step, DatasetStep)
            else op.filter
            if isinstance(op, SetLayer)
            else None
        )
        if step_filter is not None and step_filter.area is not None:
            found.add(step_filter.area)
    return found


async def _no_layers() -> tuple[dict[int, ProjectLayer], dict[int, str]]:
    return {}, {}


async def _no_toolbox() -> frozenset[str]:
    return frozenset()


def _layer_inputs(descriptions: Descriptions) -> dict[str, frozenset[str]]:
    return {
        tool: frozenset(info.name for info in tool_info.layer_inputs(described))
        for tool, described in descriptions.items()
        if described is not None
    }


async def _filter_issues(
    env: ToolEnv,
    before: Mapping[str, Any],
    after: Mapping[str, Any],
    layers: Mapping[int, ProjectLayer],
) -> list[DraftIssue]:
    """The conditions of the filters the edit set on fields their layer does
    not have, by node id, each step with the filter it ends with; a layer
    whose fields cannot be read now is not judged."""
    changed = [
        (node, layers[layer], names)
        for node, layer, names in changed_filters(before, after)
        if layer in layers
    ]
    found = await asyncio.gather(*(layer_fields(env, layer) for _, layer, _ in changed))
    nodes = {
        str(node.get("id")): node
        for node in after.get("nodes") or []
        if isinstance(node, dict)
    }
    issues: list[DraftIssue] = []
    for (node, _, names), known in zip(changed, found, strict=True):
        if known is None:
            continue
        label = step_name(nodes.get(node, {}))
        issues.extend(
            DraftIssue(
                code=FILTER_FIELD_CODE,
                level="error",
                steps=[node],
                field=name,
                message=(
                    f"{label}: the filter's field {name!r} is not in the layer. "
                    f"{field_list(list(known))}"
                ),
            )
            for name in dict.fromkeys(names)
            if name not in known
        )
    return issues


async def _stored_check(
    env: ToolEnv,
    project_id: UUID,
    config: Mapping[str, Any],
    descriptions: Descriptions | None,
) -> Checked | None:
    """The stored config's check, None when it cannot be had: then no issue
    counts as the workflow's own, and every blocking issue refuses the
    edit."""
    try:
        return await _check(env, project_id, config, descriptions)
    except ToolFailed:
        return None
    except InputInvalid:
        return None


def _identity(issue: DraftIssue) -> tuple[str, frozenset[str], str | None]:
    """An issue by what it is about, never its message: a message starts
    with the step's name, which a rename changes; node ids stay."""
    return issue.code, frozenset(issue.steps), issue.field


def _added(
    edited: Checked, stored: Checked | None
) -> tuple[list[DraftIssue], list[DraftIssue]]:
    """``(added, existing)``: the edited config's blocking issues the stored
    config's blocking ones do not account for, and the rest. Counted, so a
    second issue alike is added; an issue that was open before and blocks
    now (the edit chose its layer) is added too."""
    before = (
        Counter(_identity(issue) for issue in stored.blocking) if stored else Counter()
    )
    added: list[DraftIssue] = []
    existing: list[DraftIssue] = []
    for issue in edited.blocking:
        key = _identity(issue)
        if before[key] > 0:
            before[key] -= 1
            existing.append(issue)
        else:
            added.append(issue)
    return added, existing


async def _save(
    env: ToolEnv,
    project_id: UUID,
    workflow_id: str,
    config: Mapping[str, Any],
    revision: int,
) -> int:
    """The revision the save gave the workflow: from core's answer, else read
    back; never guessed."""
    try:
        row = await env.call(
            "core",
            "PUT",
            f"/api/v2/project/{project_id}/workflow/{workflow_id}",
            json_body={"config": config, "base_revision": revision},
        )
    except ServiceError as exc:
        # Core's database errors answer 409 too: only its revision check
        # names changed_elsewhere.
        if exc.status == 409 and exc.detail == "changed_elsewhere":
            raise ToolFailed(CHANGED_ELSEWHERE) from exc
        if sign_in_expired(exc):
            raise ToolFailed(SIGN_IN_EXPIRED) from exc
        if exc.status in (401, 403):
            raise ToolFailed(VIEWER_EDITS) from exc
        if exc.status == 404:
            raise ToolFailed(NOT_IN_PROJECT) from exc
        raise
    saved = _revision(row) if isinstance(row, dict) else None
    if saved is None:
        try:
            saved = _revision(await _read(env, project_id, workflow_id))
        except ToolFailed:
            saved = None
    if saved is None:
        raise ToolFailed(SAVED_REVISION_UNKNOWN)
    return saved


async def _update(env: ToolEnv, args: UpdateInput) -> WorkflowUpdated:
    project_id = open_project(env)
    workflow_id = str(args.workflow_id)
    row = await _read(env, project_id, workflow_id)
    revision = _revision(row)
    if revision is None:
        raise ToolFailed(NO_REVISION)
    config = row.get("config")
    damaged = shape_issues(config)
    if damaged or not isinstance(config, dict):
        reasons = " ".join(issue.message for issue in damaged)
        raise ToolFailed(DAMAGED.format(reasons=reasons))
    operations = args.operations
    added_tools = _added_tools(operations)
    (layers, locked), regions, descriptions, toolbox = await asyncio.gather(
        project_layers(env, project_id) if _layers_needed(operations) else _no_layers(),
        read_regions(env, _areas(operations)),
        describe_tools(env, _tools(config) | added_tools),
        read_toolbox(env) if added_tools else _no_toolbox(),
    )
    if toolbox is None:
        raise ToolFailed(TOOLBOX_UNREAD)
    if descriptions is None:
        raise ToolFailed(EDIT_UNCHECKED)
    try:
        planned = plan(
            config,
            operations,
            EditContext(
                layers=layers,
                locked=locked,
                regions=regions,
                titles=tool_titles(descriptions),
                layer_inputs=_layer_inputs(descriptions),
                toolbox=toolbox,
                # A fresh salt: two workflows edited alike share no node id.
                salt=uuid4().hex,
            ),
        )
    except EditError as exc:
        raise InputInvalid(str(exc)) from exc
    try:
        # Placement grows with the steps squared: off the event loop.
        changed = await asyncio.to_thread(apply, config, planned.operations)
    except OperationError as exc:
        if exc.index is None:
            raise ToolFailed(str(exc)) from exc
        raise InputInvalid(planned.explain(exc)) from exc
    changed = refit(changed, set(planned.new_ids.values()))
    if changed == config:
        return WorkflowUpdated(
            workflow_id=workflow_id,
            revision_before=revision,
            revision_after=revision,
            changed_steps=[],
            issues=[],
            note=NOTHING_CHANGED,
            project_id=str(project_id),
        )
    filters, stored, edited = await asyncio.gather(
        _filter_issues(env, config, changed, layers),
        _stored_check(env, project_id, config, descriptions),
        _check(env, project_id, changed, descriptions),
    )
    if edited is None:
        raise ToolFailed(EDIT_UNCHECKED)
    added, existing = _added(edited, stored)
    # The filters the edit set are new by construction.
    added += filters
    if added:
        listed = " ".join(issue.message for issue in added[:MAX_LISTED_ISSUES])
        raise ToolFailed(
            f"Not saved: {len(added)} issue(s) this edit adds must be fixed first. "
            f"{listed} Change the operations and call workflow_update again."
        )
    saved = await _save(env, project_id, workflow_id, changed, revision)
    note = SAVED + (EXISTING.format(count=len(existing)) if existing else "")
    return WorkflowUpdated(
        workflow_id=workflow_id,
        revision_before=revision,
        revision_after=saved,
        changed_steps=changed_steps(config, changed, planned.new_ids),
        issues=_views(edited, existing),
        note=note,
        project_id=str(project_id),
        before=config,
    )


UPDATE: ToolSpec[UpdateInput, WorkflowUpdated] = ToolSpec(
    name="workflow.update",
    description=(
        "Change a workflow of the open project: operations applied in order and "
        "saved as one edit, all or none. The changed workflow is checked as "
        "workflow_create checks a draft: an edit that adds an issue that stops a "
        "run (one the user cannot resolve by choosing a layer) is not saved, and "
        "the issues come back; issues the workflow had before do not stop it. "
        "Answers with the revisions before and after, the changed steps (an "
        "added one with its new id) and the issues left. The user can take the "
        "edit back with Undo in the dock. A rename shows on the canvas only on "
        "If steps; tool, dataset and export steps show it in their settings and "
        "in issue texts."
    ),
    input_model=UpdateInput,
    output_model=WorkflowUpdated,
    run=_update,
    surfaces=WORKFLOW_SURFACES,
    returns_data=False,
    risk="write",
    scope="goat:write",
    repeatable=REPEATED_EDIT,
    # A run after the edit runs the edited workflow: a repeated call would
    # return the earlier run's summary and start nothing.
    invalidates=frozenset(
        {GET.wire_name, GET_WORKFLOWS.wire_name, RUN.wire_name, LAST_RUN.wire_name}
    ),
)

WORKFLOW_EDIT_TOOLS: tuple[ToolSpec[Any, Any], ...] = (GET, UPDATE)
