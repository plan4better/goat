"""workflow.run and workflow.last_run (spec 2026-10-23 §3, §4, §5): the
assistant runs a workflow of the open project through processes, as the Run
button does, waits for it inside the tool call and reads what it did. While it
waits, no model call is made; the run's progress goes out as a ``workflow-run``
data part, one per job, replaced as it changes and sent again after
``HEARTBEAT_SECONDS`` without a change, so a long step does not leave the
stream silent."""

import asyncio
import logging
import re
from collections.abc import Collection, Mapping
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from pydantic_ai.exceptions import ToolFailed

from assistant.tools.filters import field_kind
from assistant.tools.http import (
    SIGN_IN_EXPIRED,
    ServiceError,
    service_failed,
    sign_in_expired,
)
from assistant.tools.runtime import ToolEnv, ToolSpec
from assistant.tools.workflow_tools import WORKFLOW_SURFACES, description
from assistant.tools.workflows import open_project, unchosen_steps
from assistant.workflows.draft import TOOL_ID_PATTERN
from assistant.workflows.edits import step_name
from assistant.workflows.runs import (
    RUN_PART,
    RUN_VALUE,
    RunSummary,
    SavedField,
    first_added,
    is_active,
    latest_job,
    overwrites,
    refused_part,
    refused_summary,
    run_part,
    run_permission,
    run_steps,
    started_part,
    summarize,
    unnamed_active,
)

logger = logging.getLogger(__name__)

#: Seconds between two reads of a running job's status.
POLL_SECONDS = 3.0
#: A run's part is sent again after this long without a change.
HEARTBEAT_SECONDS = 45.0
#: What the wait leaves of the answer's time, to read the results and answer.
ANSWER_RESERVE_SECONDS = 180.0
#: How long cancelling a run may take when the answer is stopped.
CANCEL_SECONDS = 10.0

NOT_IN_PROJECT = (
    "There is no such workflow in the open project; project_get_workflows lists them."
)
NO_FOLDER = "The open project's folder could not be read, so no run was started."
JOBS_UNAVAILABLE = (
    "The list of the user's runs could not be read, so no run was started. Try "
    "again in a moment."
)
LIST_UNAVAILABLE = (
    "The list of the user's runs could not be read. Try again in a moment."
)
ASK_FIRST = (
    "Not started. {reason} Ask with ask_user whether to run it now (options Run, "
    "value {value}, and Not now) and end your answer."
)
#: Why a run needs the user's pick (ASK_FIRST's reason).
NOT_CREATED_HERE = "This workflow was not created in this conversation."
CREATED_HERE_BUT = (
    "This workflow was created in this conversation, but {effects}: say so in "
    "the card."
)
REPLACES_USERS_RUN = (
    "its latest run was started by the user, and a run replaces those results"
)
OVERWRITES = "an export of it overwrites the layer an earlier run saved"
UNNAMED_RUNNING = (
    "A run in the user's list of runs does not name its workflow, so it cannot "
    "be told whether this workflow is already running; no run was started. Try "
    "again in a moment."
)
UNNAMED_LATEST = (
    "A run in the user's list of runs does not name its workflow, so it cannot "
    "be told whether this workflow is running or which run is its latest. Try "
    "again in a moment."
)
NO_TIME = (
    "Not started: this answer has too little time left to wait for a run. Tell "
    "the user and ask them to ask again, so that a new answer runs it."
)
NO_RUN = "This workflow has no run in the last three days."
REPEATED_RUN = (
    "You ran this workflow earlier in this answer; this is that run's summary "
    "again. Nothing was started."
)


class RunInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    workflow_id: UUID = Field(
        description=(
            "The workflow's id: from the workflow you created or from "
            "project_get_workflows."
        )
    )


async def _config(env: ToolEnv, project_id: UUID, workflow_id: str) -> dict[str, Any]:
    """The workflow's stored config; refused for a workflow outside the open
    project (core answers 401 for missing rights too) and for an expired
    sign-in."""
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
    config = row.get("config") if isinstance(row, dict) else None
    return config if isinstance(config, dict) else {}


def _open_steps(config: Mapping[str, Any]) -> str | None:
    """Why a run of ``config`` is not started: dataset steps without a
    layer, which processes refuses a run of (``unchosen_steps``), named. The
    user chooses their layers in the editor. None when every step has one."""
    names = [f'"{step_name(node)}"' for node in unchosen_steps(config)]
    if not names:
        return None
    if len(names) == 1:
        return f"Not started: step {names[0]} has no layer; the user chooses it first."
    listed = f"{', '.join(names[:-1])} and {names[-1]}"
    return f"Not started: steps {listed} have no layer; the user chooses them first."


async def _latest(
    env: ToolEnv, workflow_id: str, failure: str, unclear: str
) -> dict[str, Any] | None:
    """The workflow's latest run. Refused with ``unclear`` when the list holds
    an active run that names no workflow and none of this workflow's is
    active: that run may be this workflow's (fail closed)."""
    try:
        jobs = await env.call(
            "processes",
            "GET",
            "/jobs",
            params={"processID": "workflow_runner", "limit": 100},
        )
    except ToolFailed as exc:
        raise ToolFailed(failure) from exc
    latest = latest_job(jobs, workflow_id)
    if (latest is None or not is_active(latest)) and unnamed_active(jobs):
        raise ToolFailed(unclear)
    return latest


async def _description(env: ToolEnv, tool_id: str) -> dict[str, Any] | None:
    try:
        return await description(env, tool_id)
    except ToolFailed:
        return None


async def _descriptions(
    env: ToolEnv, config: Mapping[str, Any]
) -> dict[str, Mapping[str, Any]]:
    """The process description of each tool the workflow's steps use, read
    side by side and cached (``workflow_tools.description``), for the
    settings a step left at the tool's default. A tool whose description
    cannot be read now has none: its steps then list only the settings the
    run was sent."""
    tool_ids = list(
        dict.fromkeys(
            data["processId"]
            for _, data in run_steps(config)
            if data.get("type") == "tool"
            and isinstance(data.get("processId"), str)
            and re.match(TOOL_ID_PATTERN, data["processId"])
        )
    )
    found = await asyncio.gather(*(_description(env, tool) for tool in tool_ids))
    return {tool: doc for tool, doc in zip(tool_ids, found, strict=True) if doc}


async def _fields(
    env: ToolEnv, layer_id: str | None, added: Collection[str]
) -> list[SavedField] | None:
    """A saved layer's fields, the ones the run added first (``first_added``:
    ``added`` holds the result names its steps write)."""
    if layer_id is None:
        return None
    try:
        doc = await env.call("geoapi", "GET", f"/collections/{layer_id}/queryables")
    except ToolFailed:
        # Best effort, after the run: a removed layer or a failing service
        # leaves the fields out instead of failing the call, whose retry
        # would start the workflow again.
        return None
    properties = doc.get("properties") if isinstance(doc, dict) else None
    kinds = {
        name: field_kind(schema)
        for name, schema in (properties if isinstance(properties, dict) else {}).items()
        if isinstance(schema, dict) and "$ref" not in schema
    }
    return [
        SavedField(name=name, type=kinds[name])
        for name in first_added(list(kinds), added)
    ]


async def _with_fields(
    env: ToolEnv, summary: RunSummary, layer_ids: Mapping[int, str]
) -> RunSummary:
    if summary.status != "succeeded" or not summary.saved:
        return summary
    found = await asyncio.gather(
        *(
            _fields(env, layer_ids.get(saved.layer_project_id), summary.added)
            for saved in summary.saved
        )
    )
    return summary.model_copy(
        update={
            "saved": [
                saved.model_copy(update={"fields": fields})
                for saved, fields in zip(summary.saved, found, strict=True)
            ]
        }
    )


def _time_left(env: ToolEnv) -> bool:
    """Whether the answer has time for one more poll and its answer after."""
    remaining = env.clock.remaining() if env.clock is not None else None
    return remaining is not None and remaining > ANSWER_RESERVE_SECONDS + POLL_SECONDS


async def _cancel(env: ToolEnv, job_id: str) -> None:
    try:
        async with asyncio.timeout(CANCEL_SECONDS):
            await env.call("processes", "DELETE", f"/jobs/{job_id}")
    except Exception:
        logger.warning("Cancelling workflow run %s failed", job_id)


async def _wait(
    env: ToolEnv,
    *,
    project_id: UUID,
    workflow_id: str,
    config: Mapping[str, Any],
    job_id: str,
    started_here: bool,
    card_id: str | None,
) -> RunSummary:
    if env.clock is not None:
        env.clock.extend()
    loop = asyncio.get_running_loop()
    sent: dict[str, Any] | None = None
    sent_at = 0.0
    summary: RunSummary | None = None
    layer_ids: dict[int, str] = {}
    failing = False
    descriptions: dict[str, Mapping[str, Any]] = {}
    try:
        descriptions = await _descriptions(env, config)
        while True:
            try:
                job = await env.call("processes", "GET", f"/jobs/{job_id}")
            except ToolFailed as exc:
                # A failed read does not fail the call (its retry would start
                # the run again): the summary says the run is still going. A
                # failing service is read again while there is time; any other
                # failure (a refused sign-in, no such job) would only repeat.
                if not failing:
                    logger.warning("Reading workflow run %s failed", job_id)
                failing = True
                if not service_failed(exc) or not _time_left(env):
                    break
                await asyncio.sleep(POLL_SECONDS)
                continue
            failing = False
            summary, layer_ids = summarize(
                job if isinstance(job, dict) else {},
                config,
                workflow_id=workflow_id,
                descriptions=descriptions,
            )
            part = run_part(
                summary,
                project_id=str(project_id),
                started_here=started_here,
                card_id=card_id,
            )
            if env.emit_data is not None and (
                part != sent or loop.time() - sent_at >= HEARTBEAT_SECONDS
            ):
                await env.emit_data(RUN_PART, part, part_id=f"{RUN_PART}:{job_id}")
                sent, sent_at = part, loop.time()
            if summary.status != "running" or not _time_left(env):
                break
            await asyncio.sleep(POLL_SECONDS)
    except asyncio.CancelledError:
        # A shutdown of the service ends the answer, not the run (spec §5).
        if (
            started_here
            and not env.stopping()
            and (summary is None or summary.status == "running")
        ):
            # Its own task, so a second cancellation of this one cannot stop it.
            await asyncio.shield(asyncio.ensure_future(_cancel(env, job_id)))
        raise
    if summary is None:
        # No status was read: the run as it starts, every step pending.
        summary, _ = summarize(
            {"jobID": job_id, "status": "running"},
            config,
            workflow_id=workflow_id,
            descriptions=descriptions,
        )
    return await _with_fields(env, summary, layer_ids)


def _why_ask(
    env: ToolEnv, workflow_id: str, config: Mapping[str, Any], latest_id: str | None
) -> str:
    """Which condition of a run without asking failed (run_permission), for
    the card to say what a run does."""
    if workflow_id not in env.runs.created:
        return NOT_CREATED_HERE
    effects: list[str] = []
    if latest_id is not None and latest_id not in env.runs.started:
        effects.append(REPLACES_USERS_RUN)
    if overwrites(config):
        effects.append(OVERWRITES)
    return CREATED_HERE_BUT.format(effects=", and ".join(effects))


async def _run(env: ToolEnv, args: RunInput) -> RunSummary:
    project_id = open_project(env)
    workflow_id = str(args.workflow_id)
    config = await _config(env, project_id, workflow_id)
    # Before processes is asked: it refuses such a run anyway.
    if (open_steps := _open_steps(config)) is not None:
        raise ToolFailed(open_steps)
    latest = await _latest(env, workflow_id, JOBS_UNAVAILABLE, UNNAMED_RUNNING)
    latest_id = str(latest["jobID"]) if latest is not None else None
    allowed, card_id = run_permission(
        env.runs, env.asks, workflow_id, config, latest_id
    )
    if latest is not None and is_active(latest):
        # Nothing is started, so no permission is needed; an outstanding pick
        # asked for a run, which the wait on the one going answers.
        if card_id is not None:
            env.runs.used_cards.add(card_id)
        return await _wait(
            env,
            project_id=project_id,
            workflow_id=workflow_id,
            config=config,
            job_id=str(latest["jobID"]),
            started_here=False,
            card_id=card_id,
        )
    if not allowed:
        raise ToolFailed(
            ASK_FIRST.format(
                reason=_why_ask(env, workflow_id, config, latest_id),
                value=RUN_VALUE.format(workflow_id=workflow_id),
            )
        )
    if env.clock is not None:
        # The wait moves the answer's deadline; a run the deadline would end
        # before its first status read is not started.
        env.clock.extend()
        remaining = env.clock.remaining()
        if remaining is not None and remaining < ANSWER_RESERVE_SECONDS + POLL_SECONDS:
            raise ToolFailed(NO_TIME)
    project = await env.call("core", "GET", f"/api/v2/project/{project_id}")
    folder_id = project.get("folder_id") if isinstance(project, dict) else None
    if not folder_id:
        raise ToolFailed(NO_FOLDER)
    try:
        started = await env.call(
            "processes",
            "POST",
            f"/workflows/{workflow_id}/execute",
            json_body={
                "project_id": str(project_id),
                "folder_id": str(folder_id),
                "nodes": config.get("nodes") or [],
                "edges": config.get("edges") or [],
                "variables": config.get("variables") or [],
            },
            headers={"Accept-Language": env.locale},
        )
    except ServiceError as exc:
        if exc.status != 422:
            raise
        # Nothing ran, but the pick allowed this run: its part records that.
        if card_id is not None:
            env.runs.used_cards.add(card_id)
        if env.emit_data is not None:
            await env.emit_data(
                RUN_PART,
                refused_part(
                    workflow_id=workflow_id,
                    project_id=str(project_id),
                    total=len(run_steps(config)),
                    card_id=card_id,
                ),
                part_id=f"{RUN_PART}:refused:{workflow_id}",
            )
        return refused_summary(workflow_id, exc.issues or [{"message": exc.detail}])
    job_id = str(started["job_id"])
    env.runs.started.add(job_id)
    if card_id is not None:
        env.runs.used_cards.add(card_id)
    if env.emit_data is not None:
        try:
            await env.emit_data(
                RUN_PART,
                started_part(
                    workflow_id=workflow_id,
                    project_id=str(project_id),
                    job_id=job_id,
                    total=len(run_steps(config)),
                    card_id=card_id,
                ),
                part_id=f"{RUN_PART}:{job_id}",
            )
        except asyncio.CancelledError:
            # The job runs from the POST on, and sending the part can wait
            # (the run's event lock, its insert): a Stop before the wait
            # begins cancels the job too, as one during the wait does.
            if not env.stopping():
                await asyncio.shield(asyncio.ensure_future(_cancel(env, job_id)))
            raise
    return await _wait(
        env,
        project_id=project_id,
        workflow_id=workflow_id,
        config=config,
        job_id=job_id,
        started_here=True,
        card_id=card_id,
    )


async def _last_run(env: ToolEnv, args: RunInput) -> RunSummary:
    project_id = open_project(env)
    workflow_id = str(args.workflow_id)
    config = await _config(env, project_id, workflow_id)
    latest = await _latest(env, workflow_id, LIST_UNAVAILABLE, UNNAMED_LATEST)
    if latest is None:
        raise ToolFailed(NO_RUN)
    job = await env.call("processes", "GET", f"/jobs/{latest['jobID']}")
    summary, layer_ids = summarize(
        job if isinstance(job, dict) else {},
        config,
        workflow_id=workflow_id,
        descriptions=await _descriptions(env, config),
    )
    return await _with_fields(env, summary, layer_ids)


def _finished(result: dict[str, Any]) -> bool:
    """Whether a summary is of a run that ended with results or an error,
    which the answer reports before it asks (``ToolSpec.report_first``)."""
    return result.get("status") in ("succeeded", "failed")


RUN: ToolSpec[RunInput, RunSummary] = ToolSpec(
    name="workflow.run",
    description=(
        "Run a workflow of the open project as the Run button does, wait for it "
        "and answer with its summary: each step's status, rows and error, and the "
        "layers it saved. Each tool step lists the settings the run was sent "
        "(settings) and those it left at the tool's default (defaults): state "
        "the method exactly as they say. A setting neither lists is not used by "
        "that step or not known (workflow_describe_tool gives it). A workflow "
        "you created in this "
        "conversation runs at once; any other only after the user picked Run in "
        "your card (ask_user, option value run:<workflow id>), and the call says "
        "so when that is missing. A run already going is waited for, not started "
        "again. When the wait has to end first, the summary says the run is still "
        "going."
    ),
    input_model=RunInput,
    output_model=RunSummary,
    run=_run,
    surfaces=WORKFLOW_SURFACES,
    returns_data=False,
    risk="write",
    scope="goat:write",
    repeatable=REPEATED_RUN,
    report_first=_finished,
)

LAST_RUN: ToolSpec[RunInput, RunSummary] = ToolSpec(
    name="workflow.last_run",
    description=(
        "The latest run of a workflow of the open project in the last three days, "
        "summarized as workflow_run does, without starting or waiting: a run that "
        "was still going when you last looked, or one the user started."
    ),
    input_model=RunInput,
    output_model=RunSummary,
    run=_last_run,
    surfaces=WORKFLOW_SURFACES,
    returns_data=False,
    report_first=_finished,
)

WORKFLOW_RUN_TOOLS: tuple[ToolSpec[Any, Any], ...] = (RUN, LAST_RUN)
