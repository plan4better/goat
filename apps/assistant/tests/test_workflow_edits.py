"""workflow_get and workflow_update: the assistant reads a stored workflow of
the open project and edits it with operations, checked by processes and
saved on the revision it read, with the content before the edit in the
call's audit row for Undo."""

import asyncio
import copy
import json
import re
import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import pytest
from goatlib.workflows.ops import apply
from pydantic_ai.exceptions import ToolFailed

from assistant.context import parse_context
from assistant.db import Database
from assistant.repo import Repository
from assistant.tools import workflow_edits
from assistant.tools.runtime import InputInvalid, execute
from assistant.tools.testing import Recorder, fake_clients, signed_in, tool_env
from assistant.tools.workflow_edits import (
    CHANGED_ELSEWHERE,
    EDIT_UNCHECKED,
    GET,
    SAVED_REVISION_UNKNOWN,
    TOOLBOX_UNREAD,
    UPDATE,
    VIEWER_EDITS,
)
from assistant.tools.workflow_runs import NOT_IN_PROJECT
from assistant.tools.workflow_tools import clear_description_cache
from assistant.tools.workflows import CREATE
from assistant.workflows.runs import ConversationRuns
from tests.test_workflow_create import DRAFT
from tests.test_workflow_create import _services as create_services

PROCESSES: dict[str, Any] = json.loads(
    (Path(__file__).parent / "fixtures" / "process_descriptions.json").read_text(
        encoding="utf-8"
    )
)
DESCRIPTIONS: dict[str, Any] = PROCESSES["descriptions"]
PROJECT = "00000000-0000-0000-0000-0000000005e4"
PAGE = parse_context({"surface": "project.workflows", "project_id": PROJECT})
WF = "0b6f0000-0000-0000-0000-00000000f10f"
WF_PATH = f"/api/v2/project/{PROJECT}/workflow/{WF}"
LAYERS = [
    {
        "id": 31,
        "layer_id": "e2000000-0000-0000-0000-000000000031",
        "name": "Schulen",
        "type": "feature",
        "feature_layer_geometry_type": "point",
    },
    {
        "id": 33,
        "layer_id": "e2000000-0000-0000-0000-000000000033",
        "name": "Einwohner Raster",
        "type": "feature",
        "feature_layer_geometry_type": "polygon",
    },
    {
        "id": 36,
        "layer_id": "e2000000-0000-0000-0000-000000000036",
        "name": "Intern",
        "locked": True,
    },
]
CONFIG: dict[str, Any] = {
    "nodes": [
        {
            "id": "text-n1",
            "type": "textAnnotation",
            "position": {"x": 0, "y": -240},
            "data": {
                "type": "textAnnotation",
                "text": "<p>Walk from the schools.</p>",
                "backgroundColor": "#F2CE58",
                "width": 320,
                "height": 200,
            },
        },
        {
            "id": "dataset-a",
            "type": "dataset",
            "position": {"x": 0, "y": 0},
            "data": {
                "type": "dataset",
                "label": "Schulen",
                "projectLayerId": 31,
                "layerId": "e2000000-0000-0000-0000-000000000031",
                "layerName": "Schulen",
                "filterInitialized": True,
            },
        },
        {
            "id": "tool-walk",
            "type": "tool",
            "position": {"x": 360, "y": 0},
            "data": {
                "type": "tool",
                "processId": "catchment_area_v2",
                "label": "15 Minuten zu Fuß",
                "config": {"routing_mode": "walking", "max_cost": 15, "steps": 3},
                "status": "completed",
            },
        },
        {
            "id": "export-save",
            "type": "export",
            "position": {"x": 720, "y": 0},
            "data": {
                "type": "export",
                "label": "Save",
                "datasetName": "Einzugsgebiete",
                "addToProject": True,
                "overwritePrevious": False,
            },
        },
    ],
    "edges": [
        {
            "id": "e1",
            "source": "dataset-a",
            "target": "tool-walk",
            "targetHandle": "starting_points",
        },
        {
            "id": "e2",
            "source": "tool-walk",
            "sourceHandle": "output",
            "target": "export-save",
            "targetHandle": "input",
        },
    ],
    "viewport": {"x": 40, "y": 300, "zoom": 0.7},
    "variables": [],
}
ROW: dict[str, Any] = {
    "id": WF,
    "project_id": PROJECT,
    "name": "Schulwege",
    "description": None,
    "is_default": False,
    "config": CONFIG,
    "revision": 4,
}
SET_TEN = {"op": "set_settings", "id": "tool-walk", "settings": {"max_cost": 10}}


@pytest.fixture(autouse=True)
def _fresh_cache() -> Iterator[None]:
    clear_description_cache()
    yield
    clear_description_cache()


def _check(rows: dict[str, list[dict[str, Any]]] | None = None) -> Any:
    """processes' check: the issues of ``rows`` (node id -> its issues) for
    the nodes the checked config has; a key "" holds whole-workflow ones."""

    def respond(request: httpx.Request) -> httpx.Response:
        nodes = {node["id"] for node in json.loads(request.content)["nodes"]}
        found = [
            {
                "code": issue.get("code", "setting_invalid"),
                "level": issue.get("level", "error"),
                "node_ids": [node] if node else [],
                "field": issue.get("field"),
                "message": issue["message"],
                "params": {},
                "source": "check",
            }
            for node, issues in (rows or {}).items()
            if not node or node in nodes
            for issue in issues
        ]
        return httpx.Response(200, json={"issues": found})

    return respond


def _saved(revision: int = 5) -> Callable[[httpx.Request], httpx.Response]:
    def respond(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        return httpx.Response(
            200, json={**ROW, "config": body["config"], "revision": revision}
        )

    return respond


def _services(
    *,
    row: Any = ROW,
    put: Any = None,
    check: Any = None,
    queryables: Any = None,
) -> tuple[Recorder, Recorder, Recorder]:
    core = Recorder(
        {
            ("GET", WF_PATH): row,
            ("PUT", WF_PATH): put if put is not None else _saved(),
            ("GET", f"/api/v2/project/{PROJECT}/layer"): LAYERS,
        }
    )
    processes = Recorder(
        {
            ("GET", "/processes"): {"processes": PROCESSES["list"]["en"], "links": []},
            **{
                ("GET", f"/processes/{tool}"): answer
                for tool, answer in DESCRIPTIONS.items()
            },
            ("POST", "/workflows/check"): check if check is not None else _check(),
        }
    )
    geoapi = Recorder(
        {
            ("GET", "/collections/e2000000-0000-0000-0000-000000000033/queryables"): (
                queryables
                if queryables is not None
                else {
                    "properties": {
                        "einwohner": {"type": "integer"},
                        "geom": {"$ref": "geometry"},
                    }
                }
            )
        }
    )
    return core, processes, geoapi


def _env(core: Recorder, processes: Recorder, geoapi: Recorder, **extra: Any) -> Any:
    return tool_env(
        fake_clients(core=core, processes=processes, geoapi=geoapi), page=PAGE, **extra
    )


async def _update(
    operations: list[dict[str, Any]], **services: Any
) -> tuple[dict[str, Any], Recorder, Recorder]:
    core, processes, geoapi = _services(**services)
    result = await execute(
        UPDATE,
        _env(core, processes, geoapi),
        {"workflow_id": WF, "operations": operations},
    )
    return result, core, processes


def _puts(core: Recorder) -> list[dict[str, Any]]:
    return [
        json.loads(request.content)
        for request in core.requests
        if request.method == "PUT"
    ]


# -- workflow_get -----------------------------------------------------------------------


async def test_get_reads_the_steps_the_notes_the_issues_and_the_revision() -> None:
    core, processes, geoapi = _services(
        check=_check(
            {
                "tool-walk": [
                    {
                        "code": "setting_invalid",
                        "field": "max_cost",
                        "message": "Travel time must be at most 90.",
                    }
                ],
                "": [
                    {
                        "code": "no_export",
                        "level": "warning",
                        "message": "The result is not saved.",
                    }
                ],
            }
        )
    )
    result = await execute(GET, _env(core, processes, geoapi), {"workflow_id": WF})
    assert result["workflow_id"] == WF and result["revision"] == 4
    assert result["name"] == "Schulwege"
    assert [step["id"] for step in result["steps"]] == [
        "dataset-a",
        "tool-walk",
        "export-save",
    ]
    assert result["steps"][1]["settings"] == {
        "routing_mode": "walking",
        "max_cost": 15,
        "steps": 3,
    }
    assert result["steps"][1]["inputs"] == [
        {"from": "dataset-a", "input": "starting_points"}
    ]
    assert result["notes"] == [
        {"id": "text-n1", "text": "Walk from the schools.", "color": "yellow"}
    ]
    assert result["checked"] is True
    assert result["issues"] == [
        {
            "id": "tool-walk",
            "step": "15 Minuten zu Fuß",
            "code": "setting_invalid",
            "level": "error",
            "message": "15 Minuten zu Fuß: Travel time must be at most 90.",
            "blocking": True,
        },
        {
            "code": "no_export",
            "level": "warning",
            "message": "The result is not saved.",
            "blocking": False,
        },
    ]
    [check] = [r for r in processes.requests if r.url.path == "/workflows/check"]
    assert json.loads(check.content)["project_id"] == PROJECT
    assert [r.method for r in core.requests] == ["GET"]


async def test_get_outside_the_open_project_is_refused() -> None:
    core, processes, geoapi = _services(
        row=httpx.Response(404, json={"detail": "Workflow not found"})
    )
    with pytest.raises(ToolFailed, match=re.escape(NOT_IN_PROJECT)):
        await execute(GET, _env(core, processes, geoapi), {"workflow_id": WF})


async def test_get_of_a_damaged_workflow_says_so_without_a_check() -> None:
    core, processes, geoapi = _services(
        row={**ROW, "config": {"nodes": "broken", "edges": []}}
    )
    result = await execute(GET, _env(core, processes, geoapi), {"workflow_id": WF})
    assert "damaged" in result and "workflow_update" in result["note"]
    assert result["steps"] == [] and result["checked"] is False
    assert "/workflows/check" not in processes.paths()


# -- workflow_update: saving --------------------------------------------------------------


async def test_an_edit_saves_the_applied_config_on_the_revision_it_read() -> None:
    result, core, _ = await _update([SET_TEN])
    [put] = _puts(core)
    assert put["base_revision"] == 4
    assert put["config"] == apply(
        CONFIG,
        [{"op": "set_settings", "node_id": "tool-walk", "settings": {"max_cost": 10}}],
    )
    assert set(put) == {"config", "base_revision"}
    assert result == {
        "workflow_id": WF,
        "revision_before": 4,
        "revision_after": 5,
        "changed_steps": [
            {
                "id": "tool-walk",
                "kind": "tool",
                "name": "15 Minuten zu Fuß",
                "change": "changed",
            }
        ],
        "issues": [],
        "note": result["note"],
    }
    # The edit is read, checked and saved; nothing else is written.
    assert [(r.method, r.url.path) for r in core.requests] == [
        ("GET", WF_PATH),
        ("PUT", WF_PATH),
    ]


async def test_blocking_issues_go_back_and_nothing_is_saved() -> None:
    # Only the edited config has the issue: the edit adds it.
    check = _by_config(lambda nodes: TOO_FAR if _max_cost(nodes) == 900 else {})
    core, processes, geoapi = _services(check=check)
    with pytest.raises(ToolFailed) as failed:
        await execute(
            UPDATE,
            _env(core, processes, geoapi),
            {
                "workflow_id": WF,
                "operations": [
                    {
                        "op": "set_settings",
                        "id": "tool-walk",
                        "settings": {"max_cost": 900},
                    }
                ],
            },
        )
    assert failed.value.message.startswith(
        "Not saved: 1 issue(s) this edit adds must be fixed first."
    )
    assert "15 Minuten zu Fuß: Travel time must be at most 90." in failed.value.message
    assert _puts(core) == []


async def test_a_step_left_open_is_saved_and_its_issue_listed() -> None:
    check = _check(
        {
            "dataset-a": [
                {
                    "code": "layer_not_chosen",
                    "message": "No layer is chosen.",
                }
            ]
        }
    )
    result, core, _ = await _update(
        [{"op": "set_layer", "id": "dataset-a", "layer": None, "label": "Kitas"}],
        check=check,
    )
    [put] = _puts(core)
    data = next(n for n in put["config"]["nodes"] if n["id"] == "dataset-a")["data"]
    assert data == {"type": "dataset", "label": "Kitas"}
    assert result["issues"] == [
        {
            "id": "dataset-a",
            "step": "Kitas",
            "code": "layer_not_chosen",
            "level": "error",
            "message": "Kitas: No layer is chosen.",
            "blocking": False,
        }
    ]


async def test_a_dataset_swap_writes_the_layers_name_and_project_layer() -> None:
    _, core, _ = await _update([{"op": "set_layer", "id": "dataset-a", "layer": 33}])
    [put] = _puts(core)
    data = next(n for n in put["config"]["nodes"] if n["id"] == "dataset-a")["data"]
    assert data == {
        "type": "dataset",
        "label": "Einwohner Raster",
        "projectLayerId": 33,
        "layerId": "e2000000-0000-0000-0000-000000000033",
        "layerName": "Einwohner Raster",
        "filterInitialized": True,
        "geometryType": "polygon",
        "layerType": "feature",
        # goatlib marks a swapped step as resolved.
        "unresolved": False,
    }


async def test_a_conflict_asks_to_read_the_workflow_again() -> None:
    conflict = httpx.Response(
        409,
        json={
            "detail": "changed_elsewhere",
            "revision": 5,
            "updated_at": "2026-10-25T09:12:03+00:00",
            "updated_by": None,
        },
    )
    with pytest.raises(ToolFailed, match="^" + re.escape(CHANGED_ELSEWHERE) + "$"):
        await _update([SET_TEN], put=conflict)
    # Another 409 (a database constraint) is not a conflict of revisions.
    other = httpx.Response(409, json={"message": "x", "detail": "duplicate key"})
    with pytest.raises(ToolFailed) as failed:
        await _update([SET_TEN], put=other)
    assert failed.value.message != CHANGED_ELSEWHERE


@pytest.mark.parametrize("status", [401, 403])
async def test_a_viewer_is_refused(status: int) -> None:
    core, processes, geoapi = _services(
        put=httpx.Response(status, json={"detail": "not allowed"})
    )
    # A valid sign-in: core's 401 is then its authorization's answer.
    env = _env(core, processes, geoapi, login=signed_in(3600))
    with pytest.raises(ToolFailed, match="^" + re.escape(VIEWER_EDITS) + "$"):
        await execute(UPDATE, env, {"workflow_id": WF, "operations": [SET_TEN]})


async def test_a_damaged_workflow_is_refused_before_anything_is_checked() -> None:
    damaged = {**ROW, "config": {"nodes": [{"id": "x"}], "edges": []}}
    core, processes, geoapi = _services(row=damaged)
    with pytest.raises(ToolFailed) as failed:
        await execute(
            UPDATE,
            _env(core, processes, geoapi),
            {"workflow_id": WF, "operations": [SET_TEN]},
        )
    assert failed.value.message.startswith(
        "Not changed: the workflow's stored configuration is damaged"
    )
    assert processes.requests == [] and _puts(core) == []


async def test_without_a_check_nothing_is_saved() -> None:
    with pytest.raises(ToolFailed, match="^" + re.escape(EDIT_UNCHECKED) + "$"):
        await _update([SET_TEN], check=httpx.Response(503, json={"detail": "down"}))


async def test_an_operation_goatlib_refuses_goes_back_to_the_model() -> None:
    with pytest.raises(InputInvalid) as invalid:
        await _update(
            [
                SET_TEN,
                {
                    "op": "connect",
                    "from": "export-save",
                    "to": "tool-walk",
                    "input": "x",
                },
            ]
        )
    assert invalid.value.message.startswith("operation 1 (connect): 'export-save'")


async def test_too_many_operations_are_refused() -> None:
    with pytest.raises(InputInvalid, match="at most 30"):
        await _update([SET_TEN] * 31)


async def test_the_operations_are_applied_off_the_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    threads: list[int] = []

    def applying(config: Any, operations: Any) -> Any:
        threads.append(threading.get_ident())
        return apply(config, operations)

    monkeypatch.setattr(workflow_edits, "apply", applying)
    await _update([SET_TEN])
    assert threads and threads[0] != threading.get_ident()


async def test_a_new_step_outside_the_view_brings_it_into_view() -> None:
    result, core, _ = await _update(
        [
            {
                "op": "add_step",
                "step": {"id": "buf", "kind": "tool", "tool": "buffer"},
            },
            {
                "op": "connect",
                "from": "tool-walk",
                "to": "buf",
                "input": "input_layer_id",
            },
        ]
    )
    [put] = _puts(core)
    assert put["config"]["viewport"] != CONFIG["viewport"]
    [added] = [step for step in result["changed_steps"] if step["change"] == "added"]
    assert added["given_id"] == "buf" and added["name"] == "Buffer"
    assert added["id"] in {node["id"] for node in put["config"]["nodes"]}


async def test_a_tool_outside_the_toolbox_is_refused() -> None:
    with pytest.raises(InputInvalid, match="'buffer' is not in the user's toolbox"):
        core, processes, geoapi = _services()
        processes.routes[("GET", "/processes")] = {
            "processes": [
                row for row in PROCESSES["list"]["en"] if row["id"] != "buffer"
            ],
            "links": [],
        }
        await execute(
            UPDATE,
            _env(core, processes, geoapi),
            {
                "workflow_id": WF,
                "operations": [
                    {
                        "op": "add_step",
                        "step": {"id": "b", "kind": "tool", "tool": "buffer"},
                    }
                ],
            },
        )


async def test_a_filter_on_a_field_the_layer_lacks_is_not_saved() -> None:
    with pytest.raises(ToolFailed) as failed:
        await _update(
            [
                {
                    "op": "set_layer",
                    "id": "dataset-a",
                    "layer": 33,
                    "filter": {"where": [{"field": "einwohnr", "op": ">", "value": 5}]},
                }
            ]
        )
    assert "the filter's field 'einwohnr' is not in the layer" in failed.value.message
    assert "Its fields: einwohner" in failed.value.message


async def test_an_edit_that_changes_nothing_saves_nothing() -> None:
    result, core, processes = await _update(
        [{"op": "set_settings", "id": "tool-walk", "settings": {"max_cost": 15}}]
    )
    assert _puts(core) == [] and "/workflows/check" not in processes.paths()
    assert (result["revision_before"], result["revision_after"]) == (4, 4)
    assert result["changed_steps"] == []


# -- the undo record --------------------------------------------------------------------


async def _audit_rows(db: Database) -> list[dict[str, Any]]:
    async with db.pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT tool, status, created, undo FROM {db.t('tool_call')} "
            "ORDER BY created_at"
        )
    return [dict(row) for row in rows]


async def test_the_edit_is_recorded_for_undo(repo: Repository, db: Database) -> None:
    before = copy.deepcopy(CONFIG)
    core, processes, geoapi = _services()
    env = _env(core, processes, geoapi, repo=repo)
    result = await execute(
        UPDATE, env, {"workflow_id": WF, "operations": [SET_TEN]}, tool_call_id="c1"
    )
    # The content before the edit stays out of what the model reads.
    assert "before" not in result and "config" not in json.dumps(result)
    [row] = await _audit_rows(db)
    assert row["tool"] == "workflow_update" and row["status"] == "ok"
    assert row["created"] is None
    assert row["undo"] == {
        "kind": "workflow",
        "workflow_id": WF,
        "project_id": PROJECT,
        "revision_before": 4,
        "revision_after": 5,
        "before": {"config": before},
    }


async def test_a_refused_or_empty_edit_records_no_undo(
    repo: Repository, db: Database
) -> None:
    conflict = httpx.Response(409, json={"detail": "changed_elsewhere", "revision": 5})
    core, processes, geoapi = _services(put=conflict)
    with pytest.raises(ToolFailed):
        await execute(
            UPDATE,
            _env(core, processes, geoapi, repo=repo),
            {"workflow_id": WF, "operations": [SET_TEN]},
        )
    core, processes, geoapi = _services()
    await execute(
        UPDATE,
        _env(core, processes, geoapi, repo=repo),
        {
            "workflow_id": WF,
            "operations": [
                {"op": "set_settings", "id": "tool-walk", "settings": {"max_cost": 15}}
            ],
        },
    )
    rows = await _audit_rows(db)
    assert [(row["status"], row["undo"]) for row in rows] == [
        ("error", None),
        ("ok", None),
    ]


# -- in an answer -----------------------------------------------------------------------


def _stateful_core() -> Recorder:
    """Core keeping the workflow: a PUT on the stored revision saves it and
    raises the revision, as core does."""
    stored = copy.deepcopy(ROW)

    def put(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body["base_revision"] != stored["revision"]:
            return httpx.Response(409, json={"detail": "changed_elsewhere"})
        stored.update(config=body["config"], revision=stored["revision"] + 1)
        return httpx.Response(200, json=stored)

    core, _, _ = _services(put=put)
    core.routes[("GET", WF_PATH)] = lambda request: httpx.Response(200, json=stored)
    return core


async def test_a_read_after_an_edit_in_the_same_answer_reads_the_edit() -> None:
    """workflow_get runs once per arguments in an answer, except after an
    edit: the edit makes the first read stale. The same edit again in the
    answer returns its first result and saves nothing."""
    from pydantic_ai.messages import ToolReturnPart

    from assistant.agent import RunDeps, build_agent
    from assistant.tools.testing import ScriptedModel

    core = _stateful_core()
    _, processes, geoapi = _services()
    get = ("workflow_get", {"workflow_id": WF})
    edit = ("workflow_update", {"workflow_id": WF, "operations": [SET_TEN]})
    script = ScriptedModel([get, get, edit, get, edit])

    async def emit(event: Any) -> None:
        return None

    deps = RunDeps(message_id="m1", emit=emit, env=_env(core, processes, geoapi))
    await build_agent(script.model).run("walk 10 minutes", deps=deps)
    first, again, edited, fresh, repeated = [
        part.content
        for message in script.requests[-1]
        for part in getattr(message, "parts", [])
        if isinstance(part, ToolReturnPart)
    ]
    assert first["revision"] == 4 and again["revision"] == 4
    assert "repeated_call" in again
    assert edited["revision_after"] == 5
    assert fresh["revision"] == 5 and "repeated_call" not in fresh
    assert fresh["steps"][1]["settings"]["max_cost"] == 10
    assert repeated["repeated_call"] == UPDATE.repeatable
    assert len(_puts(core)) == 1


#: A second workflow of the project, which the edits leave as it is.
OTHER_WF = "0b6f0000-0000-0000-0000-00000000f11f"


@dataclass
class _Ran:
    #: Each workflow_run's workflow and result, in order.
    runs: list[tuple[str, dict[str, Any]]]
    #: The runs started, by workflow: the bodies processes was sent.
    starts: dict[str, list[dict[str, Any]]]


async def _runs_and_edits(
    calls: list[tuple[str, dict[str, Any]]], *, conflict: bool = False
) -> _Ran:
    """One answer whose model makes ``calls`` on two workflows it created, the
    edited one (``WF``, its saves raising the revision as core does; with
    ``conflict`` refused as changed elsewhere) and ``OTHER_WF``."""
    from pydantic_ai.messages import ToolReturnPart

    from assistant.agent import RunDeps, build_agent
    from assistant.tools.testing import ScriptedModel

    if conflict:
        core, _, _ = _services(
            put=httpx.Response(409, json={"detail": "changed_elsewhere"})
        )
    else:
        core = _stateful_core()
    core.routes.update(
        {
            ("GET", f"/api/v2/project/{PROJECT}"): {
                "id": PROJECT,
                "folder_id": "0f000000-0000-0000-0000-000000000001",
            },
            ("GET", f"/api/v2/project/{PROJECT}/workflow/{OTHER_WF}"): {
                **ROW,
                "id": OTHER_WF,
                "name": "Andere",
            },
        }
    )
    _, processes, geoapi = _services()
    jobs = iter(f"j{n}" for n in range(1, 10))

    def start(request: httpx.Request) -> httpx.Response:
        workflow = request.url.path.split("/")[2]
        return httpx.Response(
            200,
            json={"job_id": next(jobs), "workflow_id": workflow, "status": "submitted"},
        )

    def finished(job_id: str) -> dict[str, Any]:
        return {
            "jobID": job_id,
            "processID": "workflow_runner",
            "status": "successful",
            "created": "2026-10-23T08:41:30Z",
            "result": {
                "status": "success",
                "node_results": {
                    "tool-walk": {"status": "success", "feature_count": 3}
                },
            },
        }

    processes.routes.update(
        {
            ("GET", "/jobs"): {"jobs": []},
            ("POST", f"/workflows/{WF}/execute"): start,
            ("POST", f"/workflows/{OTHER_WF}/execute"): start,
            **{("GET", f"/jobs/j{n}"): finished(f"j{n}") for n in range(1, 10)},
        }
    )
    script = ScriptedModel(calls)

    async def emit(event: Any) -> None:
        return None

    deps = RunDeps(message_id="m1", emit=emit, env=_env(core, processes, geoapi))
    assert deps.env is not None
    deps.env.runs.created.update({WF, OTHER_WF})
    await build_agent(script.model).run("run them", deps=deps)
    workflows = iter(
        args["workflow_id"] for name, args in calls if name == "workflow_run"
    )
    runs = [
        (next(workflows), part.content)
        for message in script.requests[-1]
        for part in getattr(message, "parts", [])
        if isinstance(part, ToolReturnPart) and part.tool_name == "workflow_run"
    ]
    starts: dict[str, list[dict[str, Any]]] = {}
    for request in processes.requests:
        if request.method == "POST" and request.url.path.endswith("/execute"):
            workflow = request.url.path.split("/")[2]
            starts.setdefault(workflow, []).append(json.loads(request.content))
    return _Ran(runs=runs, starts=starts)


def _run(workflow: str) -> tuple[str, dict[str, Any]]:
    return ("workflow_run", {"workflow_id": workflow})


EDIT = ("workflow_update", {"workflow_id": WF, "operations": [SET_TEN]})


def _minutes_run(body: dict[str, Any]) -> Any:
    """The walking time of a run's catchment step, as processes was sent it."""
    walk = next(node for node in body["nodes"] if node["id"] == "tool-walk")
    return walk["data"]["config"]["max_cost"]


@pytest.fixture
def _quick_runs(monkeypatch: pytest.MonkeyPatch) -> None:
    from assistant.tools import workflow_runs

    monkeypatch.setattr(workflow_runs, "POLL_SECONDS", 0.0)


@pytest.mark.usefixtures("_quick_runs")
async def test_a_run_after_an_edit_in_the_same_answer_starts_the_edited_workflow() -> (
    None
):
    """A repeated run in an answer returns the earlier run's summary and
    starts nothing; after an edit of the workflow its run starts again, on
    the edited workflow."""
    from assistant.tools.workflow_runs import REPEATED_RUN

    ran = await _runs_and_edits([_run(WF), _run(WF), EDIT, _run(WF)])
    (_, first), (_, repeated), (_, edited) = ran.runs
    assert first["status"] == "succeeded" and "repeated_call" not in first
    assert repeated["repeated_call"] == REPEATED_RUN
    assert edited["status"] == "succeeded" and "repeated_call" not in edited
    assert [_minutes_run(body) for body in ran.starts[WF]] == [15, 10]


@pytest.mark.usefixtures("_quick_runs")
async def test_an_edit_lets_only_the_edited_workflow_run_again() -> None:
    """The run of a workflow the edit did not touch is the same run: it
    starts once, also when it is called again after the edit."""
    from assistant.tools.workflow_runs import REPEATED_RUN

    ran = await _runs_and_edits(
        [_run(WF), _run(OTHER_WF), EDIT, _run(OTHER_WF), _run(WF)]
    )
    assert len(ran.starts[OTHER_WF]) == 1
    assert [_minutes_run(body) for body in ran.starts[WF]] == [15, 10]
    repeated = [result for workflow, result in ran.runs if "repeated_call" in result]
    assert [result["repeated_call"] for result in repeated] == [REPEATED_RUN]


@pytest.mark.usefixtures("_quick_runs")
async def test_an_edit_that_was_not_saved_lets_no_run_start_again() -> None:
    from assistant.tools.workflow_runs import REPEATED_RUN

    ran = await _runs_and_edits([_run(WF), EDIT, _run(WF)], conflict=True)
    assert len(ran.starts[WF]) == 1
    (_, first), (_, again) = ran.runs
    assert "repeated_call" not in first
    assert again["repeated_call"] == REPEATED_RUN


# -- fix round 1: only the blocking issues an edit adds refuse it -----------------------


def _by_config(
    rule: Callable[[dict[str, Any]], dict[str, list[dict[str, Any]]]],
) -> Any:
    """processes' check answering ``rule(nodes by id)``: node id (or "" for
    the whole workflow) -> its issues, so the stored and the edited config
    can get different ones. A rule returning None answers 503."""

    def respond(request: httpx.Request) -> httpx.Response:
        nodes = {node["id"]: node for node in json.loads(request.content)["nodes"]}
        rows = rule(nodes)
        if rows is None:
            return httpx.Response(503, json={"detail": "down"})
        return _check(rows)(request)

    return respond


def _max_cost(nodes: dict[str, Any]) -> Any:
    return nodes["tool-walk"]["data"]["config"].get("max_cost")


UNREADABLE = {
    "dataset-a": [
        {"code": "layer_not_readable", "message": "The layer cannot be read."}
    ]
}
TOO_FAR = {
    "tool-walk": [
        {
            "code": "setting_invalid",
            "field": "max_cost",
            "message": "Travel time must be at most 90.",
        }
    ]
}


async def test_an_issue_the_workflow_had_does_not_stop_an_edit_elsewhere() -> None:
    result, core, _ = await _update([SET_TEN], check=_by_config(lambda _: UNREADABLE))
    [put] = _puts(core)
    assert put["base_revision"] == 4
    assert result["issues"] == [
        {
            "id": "dataset-a",
            "step": "Schulen",
            "code": "layer_not_readable",
            "level": "error",
            "message": "Schulen: The layer cannot be read.",
            "blocking": True,
            "existing": True,
        }
    ]
    assert "1 issue(s) that stop a run were there before this edit" in result["note"]


async def test_an_edit_that_adds_a_blocking_issue_is_refused_naming_only_it() -> None:
    def rule(nodes: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
        return {**UNREADABLE, **(TOO_FAR if _max_cost(nodes) == 900 else {})}

    core, processes, geoapi = _services(check=_by_config(rule))
    with pytest.raises(ToolFailed) as failed:
        await execute(
            UPDATE,
            _env(core, processes, geoapi),
            {
                "workflow_id": WF,
                "operations": [
                    {
                        "op": "set_settings",
                        "id": "tool-walk",
                        "settings": {"max_cost": 900},
                    }
                ],
            },
        )
    assert failed.value.message.startswith(
        "Not saved: 1 issue(s) this edit adds must be fixed first."
    )
    assert "Travel time must be at most 90." in failed.value.message
    assert "cannot be read" not in failed.value.message
    assert _puts(core) == []


async def test_an_edit_that_fixes_the_issue_saves_without_it() -> None:
    result, core, _ = await _update(
        [SET_TEN],
        check=_by_config(lambda nodes: TOO_FAR if _max_cost(nodes) == 15 else {}),
    )
    assert len(_puts(core)) == 1 and result["issues"] == []


async def test_an_issue_is_the_same_after_its_step_is_renamed() -> None:
    result, core, _ = await _update(
        [{"op": "rename", "id": "tool-walk", "label": "Zehn Minuten"}],
        check=_by_config(lambda _: TOO_FAR),
    )
    assert len(_puts(core)) == 1
    [issue] = result["issues"]
    assert issue["message"] == "Zehn Minuten: Travel time must be at most 90."
    assert issue["existing"] is True


async def test_an_open_issue_the_edit_makes_blocking_is_refused() -> None:
    open_row = copy.deepcopy(ROW)
    dataset = open_row["config"]["nodes"][1]
    dataset["data"] = {"type": "dataset", "label": "Schulen"}
    whole_step = {
        "tool-walk": [{"code": "setting_invalid", "message": "The step is invalid."}]
    }
    core, processes, geoapi = _services(
        row=open_row, check=_by_config(lambda _: whole_step)
    )
    with pytest.raises(ToolFailed, match="this edit adds") as failed:
        await execute(
            UPDATE,
            _env(core, processes, geoapi),
            {
                "workflow_id": WF,
                "operations": [{"op": "set_layer", "id": "dataset-a", "layer": 31}],
            },
        )
    assert "The step is invalid." in failed.value.message
    assert _puts(core) == []


@pytest.mark.parametrize("stored", [None, "refused"])
async def test_without_the_stored_check_only_a_clean_edit_saves(stored: Any) -> None:
    def rule(issues: dict[str, Any]) -> Any:
        def answer(nodes: dict[str, Any]) -> Any:
            if _max_cost(nodes) == 15:
                return stored
            return issues

        return answer

    def check(issues: dict[str, Any]) -> Any:
        inner = _by_config(rule(issues))

        def respond(request: httpx.Request) -> httpx.Response:
            nodes = {n["id"]: n for n in json.loads(request.content)["nodes"]}
            if stored == "refused" and _max_cost(nodes) == 15:
                return httpx.Response(422, json={"detail": "The workflow is damaged."})
            return inner(request)

        return respond

    with pytest.raises(ToolFailed, match="this edit adds"):
        await _update([SET_TEN], check=check(UNREADABLE))
    result, core, _ = await _update([SET_TEN], check=check({}))
    assert len(_puts(core)) == 1 and result["issues"] == []


async def test_the_stored_and_the_edited_config_are_checked_at_once() -> None:
    arrived = 0
    both = asyncio.Event()

    async def respond(request: httpx.Request) -> httpx.Response:
        nonlocal arrived
        arrived += 1
        if arrived == 2:
            both.set()
        try:
            await asyncio.wait_for(both.wait(), timeout=2)
        except TimeoutError:
            return httpx.Response(503, json={"detail": "one check at a time"})
        return _check(UNREADABLE)(request)

    # Checked one after the other, the stored check would time out: its
    # issue would then count as one the edit adds, and refuse it.
    result, core, _ = await _update([SET_TEN], check=respond)
    assert arrived == 2 and len(_puts(core)) == 1
    assert [issue["existing"] for issue in result["issues"]] == [True]


# -- fix round 1: Restricted ---------------------------------------------------------


def _filtered_row(value: str = "Grundschule") -> dict[str, Any]:
    row = copy.deepcopy(ROW)
    row["config"]["nodes"][1]["data"]["filter"] = {
        "op": "and",
        "expressions": [
            {
                "id": "f1",
                "type": "logical",
                "attribute": "art",
                "expression": "is",
                "value": value,
            }
        ],
    }
    return row


async def test_get_withholds_filter_values_under_restricted() -> None:
    core, processes, geoapi = _services(row=_filtered_row())
    standard = await execute(GET, _env(core, processes, geoapi), {"workflow_id": WF})
    assert standard["steps"][0]["filter"]["where"] == [
        {"field": "art", "op": "=", "value": "Grundschule"}
    ]
    restricted = await execute(
        GET,
        _env(core, processes, geoapi, data_policy="restricted"),
        {"workflow_id": WF},
    )
    assert restricted["steps"][0]["filter"] == {
        "where": [{"field": "art", "op": "="}],
        "values_withheld": True,
    }
    assert "Grundschule" not in json.dumps(restricted)


async def test_an_edits_result_carries_no_filter_value() -> None:
    result, core, _ = await _update(
        [
            {
                "op": "set_layer",
                "id": "dataset-a",
                "layer": 33,
                "filter": {"where": [{"field": "einwohner", "op": ">", "value": 4711}]},
            }
        ]
    )
    assert len(_puts(core)) == 1 and "4711" not in json.dumps(result)


# -- fix round 1: minors ----------------------------------------------------------------


async def test_an_unread_toolbox_says_so() -> None:
    core, processes, geoapi = _services()
    processes.routes[("GET", "/processes")] = httpx.Response(503, json={"detail": "x"})
    with pytest.raises(ToolFailed, match="^" + re.escape(TOOLBOX_UNREAD) + "$"):
        await execute(
            UPDATE,
            _env(core, processes, geoapi),
            {
                "workflow_id": WF,
                "operations": [
                    {
                        "op": "add_step",
                        "step": {"id": "b", "kind": "tool", "tool": "buffer"},
                    }
                ],
            },
        )


async def test_get_says_why_the_check_did_not_run() -> None:
    refused = httpx.Response(422, json={"detail": "The workflow is damaged."})
    core, processes, geoapi = _services(check=refused)
    result = await execute(GET, _env(core, processes, geoapi), {"workflow_id": WF})
    assert result["checked"] is False
    assert "The workflow is damaged." in result["unchecked"]
    core, processes, geoapi = _services(check=httpx.Response(503, json={"detail": "x"}))
    result = await execute(GET, _env(core, processes, geoapi), {"workflow_id": WF})
    assert result["checked"] is False and "could not run" in result["unchecked"]


async def test_an_edit_of_a_workflow_outside_the_project_is_refused() -> None:
    gone = httpx.Response(404, json={"detail": "Workflow not found"})
    with pytest.raises(ToolFailed, match=re.escape(NOT_IN_PROJECT)):
        _, core, _ = await _update([SET_TEN], row=gone)


async def test_only_the_filter_a_step_ends_with_is_judged() -> None:
    result, core, _ = await _update(
        [
            {
                "op": "set_layer",
                "id": "dataset-a",
                "layer": 33,
                "filter": {"where": [{"field": "nope", "op": "=", "value": 1}]},
            },
            {
                "op": "set_layer",
                "id": "dataset-a",
                "layer": 33,
                "filter": {"where": [{"field": "einwohner", "op": ">", "value": 5}]},
            },
        ]
    )
    assert len(_puts(core)) == 1


async def test_a_read_after_a_failed_edit_in_the_same_answer_runs_again() -> None:
    from pydantic_ai.messages import ToolReturnPart

    from assistant.agent import RunDeps, build_agent
    from assistant.tools.testing import ScriptedModel

    core, processes, geoapi = _services(
        put=httpx.Response(409, json={"detail": "changed_elsewhere"})
    )
    get = ("workflow_get", {"workflow_id": WF})
    edit = ("workflow_update", {"workflow_id": WF, "operations": [SET_TEN]})
    script = ScriptedModel([get, edit, get])

    async def emit(event: Any) -> None:
        return None

    deps = RunDeps(message_id="m1", emit=emit, env=_env(core, processes, geoapi))
    await build_agent(script.model).run("walk 10 minutes", deps=deps)
    first, fresh = [
        part.content
        for message in script.requests[-1]
        for part in getattr(message, "parts", [])
        if isinstance(part, ToolReturnPart) and part.tool_name == "workflow_get"
    ]
    assert "repeated_call" not in fresh
    reads = [r for r in core.requests if r.method == "GET" and r.url.path == WF_PATH]
    assert len(reads) == 3


async def test_a_save_whose_answer_names_no_revision_reads_it_back() -> None:
    # Never guessed: the revision the undo record and the editor rely on is
    # core's, read back after the save.
    reads = iter([ROW, {**ROW, "revision": 5}])
    put = httpx.Response(
        200, json={key: value for key, value in ROW.items() if key != "revision"}
    )
    core, processes, geoapi = _services(put=put)
    core.routes[("GET", WF_PATH)] = lambda request: httpx.Response(
        200, json=next(reads)
    )
    env = _env(core, processes, geoapi)
    result = await execute(UPDATE, env, {"workflow_id": WF, "operations": [SET_TEN]})
    assert (result["revision_before"], result["revision_after"]) == (4, 5)


async def test_a_save_whose_revision_cannot_be_known_says_so() -> None:
    reads = iter(
        [httpx.Response(200, json=ROW), httpx.Response(500, json={"detail": "down"})]
    )
    put = httpx.Response(
        200, json={key: value for key, value in ROW.items() if key != "revision"}
    )
    core, processes, geoapi = _services(put=put)
    core.routes[("GET", WF_PATH)] = lambda request: next(reads)
    with pytest.raises(ToolFailed) as failed:
        await execute(
            UPDATE,
            _env(core, processes, geoapi),
            {"workflow_id": WF, "operations": [SET_TEN]},
        )
    assert failed.value.message == SAVED_REVISION_UNKNOWN
    assert len(_puts(core)) == 1


# -- a workflow this conversation created, by its draft's ids ----------------------------


async def test_a_workflow_created_here_is_edited_by_its_drafts_ids() -> None:
    """Its node ids are derived with a salt of the create's own: the create's
    result maps the draft's ids to them, and an edit takes either."""
    core, processes, geoapi, catalog = create_services()
    env = tool_env(
        fake_clients(core=core, processes=processes, geoapi=geoapi, catalog=catalog),
        page=PAGE,
    )
    created = await execute(CREATE, env, {"draft": DRAFT}, tool_call_id="c1")
    posted = json.loads(next(r for r in core.requests if r.method == "POST").content)
    ids = created["step_ids"]
    assert list(ids) == [step["id"] for step in DRAFT["steps"]]
    assert list(ids.values()) == [node["id"] for node in posted["config"]["nodes"]]
    row = {**ROW, "id": created["workflow"]["id"], "config": posted["config"]}
    core.routes[("GET", WF_PATH)] = row
    core.routes[("PUT", WF_PATH)] = lambda request: httpx.Response(
        200, json={**row, "config": json.loads(request.content)["config"]}
    )

    async def rename(step: str, label: str) -> dict[str, Any]:
        return await execute(
            UPDATE,
            env,
            {
                "workflow_id": WF,
                "operations": [{"op": "rename", "id": step, "label": label}],
            },
        )

    by_draft = await rename("walk", "On foot")
    by_node = await rename(ids["count"], "Residents")
    renamed = [
        {node["id"]: node["data"].get("label") for node in put["config"]["nodes"]}
        for put in _puts(core)
    ]
    assert renamed[0][ids["walk"]] == "On foot"
    assert renamed[1][ids["count"]] == "Residents"
    assert [step["id"] for step in by_draft["changed_steps"]] == [ids["walk"]]
    assert [step["id"] for step in by_node["changed_steps"]] == [ids["count"]]

    with pytest.raises(InputInvalid) as refused:
        await rename("start", "x")
    assert refused.value.message == (
        "operation 0 (rename): there is no step or note with the id 'start'. "
        f"The ids are: {', '.join(ids.values())}. The ids of its draft name them "
        f"too: {', '.join(ids)}."
    )
    assert len(_puts(core)) == 2


async def test_a_created_workflows_draft_ids_include_its_notes() -> None:
    note = {"id": "about", "text": "Counts the residents near a school."}
    core, processes, geoapi, catalog = create_services()
    env = tool_env(
        fake_clients(core=core, processes=processes, geoapi=geoapi, catalog=catalog),
        page=PAGE,
    )
    created = await execute(CREATE, env, {"draft": {**DRAFT, "notes": [note]}})
    posted = json.loads(next(r for r in core.requests if r.method == "POST").content)
    assert created["step_ids"]["about"] == posted["config"]["nodes"][-1]["id"]
    assert env.runs.step_ids == {created["workflow"]["id"]: created["step_ids"]}


async def test_a_later_answer_edits_by_the_drafts_ids_it_reads_back() -> None:
    """A later answer gets the map from the create's stored result."""
    runs = ConversationRuns.from_stored(
        [
            {
                "role": "assistant",
                "parts": [
                    {
                        "type": "tool",
                        "tool_name": "workflow_create",
                        "state": "output",
                        "output": {
                            "workflow": {"id": WF},
                            "step_ids": {"schools": "dataset-a", "walk": "tool-walk"},
                        },
                    }
                ],
            }
        ]
    )
    assert runs.step_ids == {WF: {"schools": "dataset-a", "walk": "tool-walk"}}
    core, processes, geoapi = _services()
    env = _env(core, processes, geoapi)
    env.runs = runs
    await execute(
        UPDATE,
        env,
        {"workflow_id": WF, "operations": [{**SET_TEN, "id": "walk"}]},
    )
    [put] = _puts(core)
    assert put["config"] == apply(
        CONFIG,
        [{"op": "set_settings", "node_id": "tool-walk", "settings": {"max_cost": 10}}],
    )


async def test_the_draft_ids_of_another_workflow_name_nothing() -> None:
    core, processes, geoapi = _services()
    env = _env(core, processes, geoapi)
    env.runs = ConversationRuns(step_ids={"another": {"walk": "tool-walk"}})
    with pytest.raises(InputInvalid) as refused:
        await execute(
            UPDATE,
            env,
            {"workflow_id": WF, "operations": [{**SET_TEN, "id": "walk"}]},
        )
    assert "there is no step or note with the id 'walk'" in refused.value.message
    assert "draft" not in refused.value.message
    assert _puts(core) == []
