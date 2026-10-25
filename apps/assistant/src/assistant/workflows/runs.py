"""Workflow runs as the assistant reads them (spec 2026-10-23 §3.2, §4).

A run's summary comes from processes' job status of a ``workflow_runner`` job,
read against the workflow's stored config: the steps are the config's tool and
export steps, their state the job's per-step results, statuses and errors.
A tool step's settings are those the run was sent, the nodes and variables
processes keeps in the job's inputs, with the stored config for what the job
lacks; its defaults are the settings it left out, at the tool's default as
the tool's process description gives it, so the answer can state the method
as it ran. ``ConversationRuns`` is what a conversation did with workflows,
the ones it created and the runs it started, read from its stored parts the
way ``assistant.asks.AskHistory`` reads its cards.
"""

import re
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from goatlib.workflows.visibility import is_shown
from pydantic import BaseModel, Field

from assistant.asks import AskHistory, chosen_cards
from assistant.workflows import tool_info
from assistant.workflows.tool_info import JOINED_PREFIX

#: The data part a run's progress travels in, one part id per job.
RUN_PART = "workflow-run"
RUNNER = "workflow_runner"
#: The value of the Run option in the card that asks before a run.
RUN_VALUE = "run:{workflow_id}"
CREATE_TOOLS = frozenset({"workflow_create", "workflow_create_from_template"})
MAX_SAVED_FIELDS = 30
MAX_ISSUES = 10
_TEXT_CHARS = 500
#: Settings a tool step lists at most, and the characters of a text one.
MAX_STEP_SETTINGS = 15
_SETTING_CHARS = 80
#: A tool setting that only steers the editor's form.
_FORM_SETTINGS = frozenset({"show_advanced"})
#: A workflow variable in a setting, as the runner replaces it.
_VARIABLE = re.compile(r"\{\{@([a-zA-Z_][a-zA-Z0-9_]*)\}\}")

Setting = str | int | float | bool

RunStatus = Literal["running", "succeeded", "failed", "cancelled", "refused"]
#: ``unknown``: the run reported nothing for the step. processes attaches the
#: steps' results to a successful run only and their statuses while it runs,
#: so a failed or cancelled run names its failing step alone.
StepStatus = Literal["done", "skipped", "failed", "running", "pending", "unknown"]

_JOB_STATUS: dict[str, RunStatus] = {
    "accepted": "running",
    "running": "running",
    "successful": "succeeded",
    "failed": "failed",
    "dismissed": "cancelled",
}
_NODE_STATUS: dict[str, StepStatus] = {
    "completed": "done",
    "running": "running",
    "failed": "failed",
}
_ENDED: frozenset[str] = frozenset({"done", "skipped", "failed"})

SUCCEEDED = (
    "The run finished. Read each saved layer with the project tools "
    "(project_group_statistics for results per group, such as per district and "
    "band) before you answer: every number in your answer comes from those results."
)
SUCCEEDED_UNSAVED = (
    "The run finished but saved no layer, so its results are only on the "
    "Workflows canvas. Say so; each step's rows tell what it produced."
)
FAILED = (
    "The run failed. Name the failing step and its error in plain words and say "
    "what to change in the Workflows editor. Steps marked unknown may have "
    "finished: a failed run reports its failing step only. You cannot change the "
    "workflow; on request, build a corrected new one."
)
RUNNING = (
    "The run is still going. Tell the user, end your answer, and read it later "
    "with workflow_last_run."
)
CANCELLED = "The run was cancelled before it finished."
REFUSED = (
    "The run was refused before it started, for these issues. Explain them and "
    "what to change in the Workflows editor; nothing ran."
)


class RunStep(BaseModel):
    name: str
    #: The tool's id; left out for an export step.
    tool: str | None = None
    status: StepStatus
    #: The features the step produced.
    rows: int | None = None
    error: str | None = None
    #: A tool step's settings in the workflow, as the run used them
    #: (``step_settings``); left out for an export step and a tool without any.
    settings: dict[str, Setting] | None = None
    #: The settings the step left out, at the tool's default
    #: (``step_defaults``); left out when there are none or the tool's
    #: description could not be read.
    defaults: dict[str, Setting] | None = None


class SavedField(BaseModel):
    name: str
    type: str


class SavedLayer(BaseModel):
    name: str
    layer_project_id: int
    rows: int | None = None
    #: Left out when the layer's fields could not be read (it was removed).
    fields: list[SavedField] | None = None


class RunSummary(BaseModel):
    workflow_id: str
    #: Left out for a run refused before it started.
    job_id: str | None = None
    status: RunStatus
    started: str | None = None
    finished: str | None = None
    steps: list[RunStep]
    saved: list[SavedLayer]
    #: Why a refused run did not start.
    issues: list[str] | None = None
    note: str
    #: The result names the run's steps write (``_result_names``), to list a
    #: saved layer's fields the run added first (``first_added``); never
    #: serialized.
    added: frozenset[str] = Field(default=frozenset(), exclude=True)


def _clip(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return value if len(value) <= _TEXT_CHARS else value[: _TEXT_CHARS - 1] + "…"


def _int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def run_steps(config: Mapping[str, Any]) -> list[tuple[str, Mapping[str, Any]]]:
    """The config's tool and export steps, in its order, with their node ids."""
    nodes = config.get("nodes")
    found: list[tuple[str, Mapping[str, Any]]] = []
    for node in nodes if isinstance(nodes, list) else []:
        if not isinstance(node, Mapping) or not isinstance(node.get("id"), str):
            continue
        data = _mapping(node.get("data"))
        if data.get("type") in ("tool", "export"):
            found.append((node["id"], data))
    return found


def overwrites(config: Mapping[str, Any]) -> bool:
    """Whether an export step replaces the layer an earlier run saved."""
    return any(
        data.get("type") == "export" and bool(data.get("overwritePrevious"))
        for _, data in run_steps(config)
    )


def _name(data: Mapping[str, Any]) -> str:
    for key in ("label", "datasetName", "processId"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return "step"


def _variables(config: Mapping[str, Any]) -> dict[str, Any]:
    """Each workflow variable's value by its name, as the runner reads them."""
    variables = config.get("variables")
    return {
        variable["name"]: variable.get("defaultValue")
        for variable in (variables if isinstance(variables, list) else [])
        if isinstance(variable, Mapping) and isinstance(variable.get("name"), str)
    }


def _sent_nodes(inputs: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    """The data of the nodes a run was sent, by node id: processes keeps them
    with the job, in its inputs."""
    nodes = inputs.get("nodes")
    return {
        node["id"]: _mapping(node.get("data"))
        for node in (nodes if isinstance(nodes, list) else [])
        if isinstance(node, Mapping) and isinstance(node.get("id"), str)
    }


def _resolved(value: Any, variables: Mapping[str, Any]) -> Any:
    """``value`` with its workflow variables replaced: a whole reference by
    the variable's value, one inside a text by its text."""
    if isinstance(value, list):
        return [_resolved(item, variables) for item in value]
    if isinstance(value, Mapping):
        return {key: _resolved(item, variables) for key, item in value.items()}
    if not isinstance(value, str):
        return value
    whole = _VARIABLE.fullmatch(value)
    if whole is not None:
        return variables.get(whole.group(1), value)
    return _VARIABLE.sub(
        lambda match: str(variables.get(match.group(1), match.group(0))), value
    )


def _says_nothing(name: str) -> bool:
    """A setting that does not describe the method: a reference to a layer or
    another record by id, a filter, a geometry, SQL text (its literals can
    hold data values), the name a result layer or bundle is saved under, or
    one of the editor's own. Skipped before ``MAX_STEP_SETTINGS`` counts."""
    return (
        name.startswith("_")
        or name in _FORM_SETTINGS
        or name.endswith(("_id", "_ids", "_layer_name", "_bundle_name"))
        or "filter" in name
        or "geometry" in name
        or "sql" in name
    )


def _entry(item: Any) -> str | None:
    """One entry of a list setting: a plain value; a statistic as
    ``operation(field)``; another object by its name and its ``max_cost`` (an
    opportunity). None for an entry without any of these: its ids, nested
    objects and the rest are left out."""
    if isinstance(item, (str, int, float)):
        return str(item)
    if not isinstance(item, Mapping):
        return None
    operation, field = item.get("operation"), item.get("field")
    if isinstance(operation, str) and operation:
        return (
            f"{operation}({field})" if isinstance(field, str) and field else operation
        )
    name = next(
        (
            item[key].strip()
            for key in ("name", "label")
            if isinstance(item.get(key), str) and item[key].strip()
        ),
        None,
    )
    cost = item.get("max_cost")
    if isinstance(cost, bool) or not isinstance(cost, (int, float)):
        return name
    return f"{name} (max_cost {cost})" if name else f"max_cost {cost}"


def _setting(name: str, value: Any) -> Setting | None:
    """A setting as a step lists it: a text cut at ``_SETTING_CHARS``, a list
    joined by its entries (``_entry``), a time of day (seconds since midnight,
    a setting named ``*_time`` but not ``*_max_time``, which is a duration) as
    HH:MM; None for an empty value or one of another shape."""
    if isinstance(value, Mapping) and isinstance(value.get("operation"), str):
        # One statistic in place of a list, which the aggregate and join tools
        # also take.
        value = [value]
    if isinstance(value, list):
        entries = [entry for entry in map(_entry, value) if entry is not None]
        if not entries:
            return None
        value = ", ".join(entries)
    if isinstance(value, bool) or isinstance(value, float):
        return value
    if isinstance(value, int):
        if name.endswith("_time") and not name.endswith("_max_time") and value >= 0:
            return f"{value // 3600:02d}:{value % 3600 // 60:02d}"
        return value
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    return text if len(text) <= _SETTING_CHARS else text[: _SETTING_CHARS - 1] + "…"


def step_settings(
    data: Mapping[str, Any], variables: Mapping[str, Any]
) -> dict[str, Setting] | None:
    """A tool step's settings in its node ``data``, with the workflow's
    variables resolved, the plain ones that describe the method, in their
    order, at most ``MAX_STEP_SETTINGS``; None for a step without any."""
    config = data.get("config")
    if data.get("type") != "tool" or not isinstance(config, Mapping):
        return None
    found: dict[str, Setting] = {}
    for name, raw in config.items():
        if len(found) >= MAX_STEP_SETTINGS:
            break
        if not isinstance(name, str) or _says_nothing(name):
            continue
        value = _setting(name, _resolved(raw, variables))
        if value is not None:
            found[name] = value
    return found or None


def step_defaults(
    data: Mapping[str, Any],
    variables: Mapping[str, Any],
    description: Mapping[str, Any] | None,
) -> dict[str, Setting] | None:
    """The settings a tool step in node ``data`` left at the tool's default,
    from the tool's process ``description``: each one with a static default
    the tool applies (``tool_info.static_defaults``) that the step's config
    does not set (null counts as not set: the tool's script drops it) and
    that the editor shows for the step's values, its variables resolved.
    Advanced settings count as shown: they apply whether the form folds them
    away or not. In the description's order, the ones that describe the
    method, at most ``MAX_STEP_SETTINGS``; None for a step without any or a
    tool without its description."""
    if data.get("type") != "tool" or not description:
        return None
    raw = data.get("config")
    config = _resolved(raw, variables) if isinstance(raw, Mapping) else {}
    values = {**tool_info.form_values(description, config), "show_advanced": True}
    found: dict[str, Setting] = {}
    for name, default, ui in tool_info.static_defaults(description):
        if len(found) >= MAX_STEP_SETTINGS:
            break
        if (
            config.get(name) is not None
            or _says_nothing(name)
            or not is_shown(ui, values)
        ):
            continue
        value = _setting(name, default)
        if value is not None:
            found[name] = value
    return found or None


def _result_names(value: Any) -> set[str]:
    """The columns a tool step's resolved settings name for its results:
    each ``result_name``, and for a statistic without one the names the tools
    give it: ``count`` for a count, else ``{field}_{operation}`` (join,
    aggregate points) and ``{operation}_{field}`` (aggregate polygons,
    dissolve), both since the step's tool is not consulted; with
    ``calculate_statistics``, ``count`` and a join's ``match_count``. A name
    no saved layer has changes nothing."""
    found: set[str] = set()
    if isinstance(value, list):
        for item in value:
            found |= _result_names(item)
        return found
    if not isinstance(value, Mapping):
        return found
    if value.get("calculate_statistics") is True:
        found |= {"count", "match_count"}
    named = value.get("result_name")
    operation = value.get("operation")
    if isinstance(named, str) and named.strip():
        found.add(named.strip())
    elif isinstance(operation, str) and operation:
        column = value.get("field")
        if operation == "count":
            found.add("count")
        elif isinstance(column, str) and column:
            found |= {f"{column}_{operation}", f"{operation}_{column}"}
    for item in value.values():
        if isinstance(item, (list, Mapping)):
            found |= _result_names(item)
    return found


def first_added(names: Sequence[str], added: Collection[str]) -> list[str]:
    """A saved layer's field ``names`` as a summary lists them: the ones the
    run added first (joined fields, ``JOINED_PREFIX``, and the ``added``
    result names), then the rest, each in their order, at most
    ``MAX_SAVED_FIELDS``. A join adds its fields after the target layer's,
    so a cut in the layer's own order would drop them first."""
    lead = [name for name in names if name.startswith(JOINED_PREFIX) or name in added]
    chosen = set(lead)
    rest = [name for name in names if name not in chosen]
    return (lead + rest)[:MAX_SAVED_FIELDS]


def _step_status(
    node_id: str,
    result: Any,
    status: Any,
    errors: Mapping[str, Any],
    *,
    ended: bool,
) -> StepStatus:
    """``ended``: the run failed or was cancelled, so a step it reports
    nothing for may have run."""
    if node_id in errors:
        return "failed"
    if isinstance(result, Mapping):
        state = result.get("status")
        if state == "skipped":
            return "skipped"
        if state in ("failed", "error"):
            return "failed"
        if state == "success" or _int(result.get("layer_project_id")) is not None:
            return "done"
    if ended and result is None and status is None:
        return "unknown"
    state = status.get("status") if isinstance(status, Mapping) else None
    return _NODE_STATUS.get(str(state), "pending")


def _note(status: RunStatus, saved: Sequence[SavedLayer]) -> str:
    if status == "succeeded":
        return SUCCEEDED if saved else SUCCEEDED_UNSAVED
    return {
        "failed": FAILED,
        "running": RUNNING,
        "cancelled": CANCELLED,
        "refused": REFUSED,
    }[status]


def summarize(
    job: Mapping[str, Any],
    config: Mapping[str, Any],
    *,
    workflow_id: str,
    descriptions: Mapping[str, Mapping[str, Any]] | None = None,
) -> tuple[RunSummary, dict[int, str]]:
    """The run ``job`` (processes' status of a workflow_runner job) of the
    workflow with ``config``, and each saved layer's layer id by its
    layer_project_id, to read its fields (not for the model)."""
    status = _JOB_STATUS.get(str(job.get("status")), "running")
    results = _mapping(_mapping(job.get("result")).get("node_results"))
    node_status = _mapping(job.get("node_status"))
    errors = _mapping(job.get("node_errors"))
    ended = status in ("failed", "cancelled")
    # A step's settings are those the run was sent: the toolbox sends other
    # variable values than the stored ones, and the editor its nodes as they
    # are, saved or not. The stored config stands in for what the job lacks.
    inputs = _mapping(job.get("inputs"))
    sent = _sent_nodes(inputs)
    variables = _variables(
        inputs if isinstance(inputs.get("variables"), list) else config
    )
    steps: list[RunStep] = []
    saved: list[SavedLayer] = []
    layer_ids: dict[int, str] = {}
    added: set[str] = set()
    for node_id, data in run_steps(config):
        result = results.get(node_id)
        own = _mapping(result)
        state = _mapping(node_status.get(node_id))
        node = sent.get(node_id, data)
        tool_id = node.get("processId")
        step = RunStep(
            name=_name(data),
            tool=_clip(data.get("processId")) if data.get("type") == "tool" else None,
            status=_step_status(
                node_id, result, node_status.get(node_id), errors, ended=ended
            ),
            rows=_int(own.get("feature_count")),
            error=_clip(errors.get(node_id)) or _clip(state.get("error")),
            settings=step_settings(node, variables),
            defaults=step_defaults(
                node,
                variables,
                (descriptions or {}).get(tool_id) if isinstance(tool_id, str) else None,
            ),
        )
        steps.append(step)
        if node.get("type") == "tool":
            added |= _result_names(_resolved(node.get("config"), variables))
        layer_project_id = _int(own.get("layer_project_id"))
        if data.get("type") == "export" and layer_project_id is not None:
            saved.append(
                SavedLayer(
                    name=_clip(own.get("layer_name")) or step.name,
                    layer_project_id=layer_project_id,
                    rows=_int(own.get("feature_count")),
                )
            )
            if isinstance(own.get("layer_id"), str):
                layer_ids[layer_project_id] = own["layer_id"]
    summary = RunSummary(
        workflow_id=workflow_id,
        job_id=_clip(job.get("jobID")),
        status=status,
        started=_clip(job.get("started")),
        finished=_clip(job.get("finished")),
        steps=steps,
        saved=saved,
        note=_note(status, saved),
        added=frozenset(added),
    )
    return summary, layer_ids


def refused_summary(
    workflow_id: str, issues: Sequence[Mapping[str, Any]]
) -> RunSummary:
    """A run processes refused before it started (422), with its issues."""
    messages = [
        message
        for issue in issues
        if (message := _clip(issue.get("message"))) is not None
    ]
    return RunSummary(
        workflow_id=workflow_id,
        status="refused",
        steps=[],
        saved=[],
        issues=messages[:MAX_ISSUES],
        note=REFUSED,
    )


def latest_job(jobs: Any, workflow_id: str) -> dict[str, Any] | None:
    """The newest workflow_runner job of ``workflow_id`` in processes' job list
    (``GET /jobs``: the user's jobs of the last three days)."""
    rows = jobs.get("jobs") if isinstance(jobs, Mapping) else None
    found = [
        row
        for row in (rows if isinstance(rows, list) else [])
        if isinstance(row, dict)
        and row.get("processID") == RUNNER
        and isinstance(row.get("jobID"), str)
        and str(_mapping(row.get("inputs")).get("workflow_id")) == workflow_id
    ]
    if not found:
        return None
    return max(found, key=lambda row: str(row.get("created") or ""))


def is_active(job: Mapping[str, Any]) -> bool:
    return job.get("status") in ("accepted", "running")


def unnamed_active(jobs: Any) -> bool:
    """Whether processes' job list holds an active workflow_runner job without
    its inputs (processes leaves them out when it could not read the job's
    details), which may be a run of any workflow."""
    rows = jobs.get("jobs") if isinstance(jobs, Mapping) else None
    return any(
        isinstance(row, dict)
        and row.get("processID") == RUNNER
        and is_active(row)
        and not isinstance(row.get("inputs"), Mapping)
        for row in (rows if isinstance(rows, list) else [])
    )


def run_part(
    summary: RunSummary, *, project_id: str, started_here: bool, card_id: str | None
) -> dict[str, Any]:
    """The ``workflow-run`` data part of a run: what the dock shows and what
    ``ConversationRuns.from_stored`` reads back."""
    return {
        "workflow_id": summary.workflow_id,
        "project_id": project_id,
        "job_id": summary.job_id,
        "status": summary.status,
        "started": started_here,
        "card_id": card_id,
        "done": sum(1 for step in summary.steps if step.status in _ENDED),
        "total": len(summary.steps),
        "step": next((s.name for s in summary.steps if s.status == "running"), None),
        "started_at": summary.started,
        "saved": len(summary.saved),
    }


def started_part(
    *, workflow_id: str, project_id: str, job_id: str, total: int, card_id: str | None
) -> dict[str, Any]:
    """The part of a run this conversation just started, sent before its first
    status: the conversation records the job even if that read fails."""
    return {
        "workflow_id": workflow_id,
        "project_id": project_id,
        "job_id": job_id,
        "status": "running",
        "started": True,
        "card_id": card_id,
        "done": 0,
        "total": total,
        "step": None,
        "started_at": None,
        "saved": 0,
    }


def refused_part(
    *, workflow_id: str, project_id: str, total: int, card_id: str | None
) -> dict[str, Any]:
    """The part of a run processes refused before it started: no job, and the
    pick that allowed it, which ``ConversationRuns.from_stored`` reads as used."""
    return {
        "workflow_id": workflow_id,
        "project_id": project_id,
        "job_id": None,
        "status": "refused",
        "started": False,
        "card_id": card_id,
        "done": 0,
        "total": total,
        "step": None,
        "started_at": None,
        "saved": 0,
    }


@dataclass
class ConversationRuns:
    """What a conversation did with workflows. The tools add to it as they
    create and run, so later calls of the same answer see that too."""

    #: Workflows created in this conversation.
    created: set[str] = field(default_factory=set)
    #: Jobs this conversation started.
    started: set[str] = field(default_factory=set)
    #: Cards whose Run pick allowed a run already.
    used_cards: set[str] = field(default_factory=set)

    @classmethod
    def from_stored(cls, messages: Sequence[Mapping[str, Any]]) -> "ConversationRuns":
        """From ``Repository.list_messages`` rows: a create tool's part that
        returned names a created workflow; a ``workflow-run`` data part names a
        run, also for an answer stopped or interrupted while it waited."""
        runs = cls()
        for message in messages:
            if message.get("role") != "assistant":
                continue
            for part in message.get("parts") or []:
                if not isinstance(part, dict):
                    continue
                if (
                    part.get("type") == "tool"
                    and part.get("tool_name") in CREATE_TOOLS
                    and part.get("state") == "output"
                ):
                    workflow = _mapping(_mapping(part.get("output")).get("workflow"))
                    if isinstance(workflow.get("id"), str):
                        runs.created.add(workflow["id"])
                elif part.get("type") == "data" and part.get("name") == RUN_PART:
                    data = _mapping(part.get("data"))
                    if data.get("started") is True and isinstance(
                        data.get("job_id"), str
                    ):
                        runs.started.add(data["job_id"])
                    if isinstance(data.get("card_id"), str):
                        runs.used_cards.add(data["card_id"])
        return runs


def run_permission(
    runs: ConversationRuns,
    asks: AskHistory,
    workflow_id: str,
    config: Mapping[str, Any],
    latest_job_id: str | None,
) -> tuple[bool, str | None]:
    """Whether a run may start, and the card whose pick it uses up (None when
    there is none). Without asking: created in this conversation, no export
    that overwrites, and whose latest run, if any, this conversation started,
    since a run replaces the previous run's results. Otherwise a pick of Run
    in a card that no run used yet: one pick, one run. A run that needs no
    card still uses up such a pick, so a pick never allows a later run it was
    not given for."""
    outstanding = next(
        (
            card_id
            for card_id in chosen_cards(asks, RUN_VALUE.format(workflow_id=workflow_id))
            if card_id not in runs.used_cards
        ),
        None,
    )
    if (
        workflow_id in runs.created
        and not overwrites(config)
        and (latest_job_id is None or latest_job_id in runs.started)
    ):
        return True, outstanding
    if outstanding is not None:
        return True, outstanding
    return False, None
