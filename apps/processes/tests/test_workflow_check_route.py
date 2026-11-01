"""`POST /workflows/check`, and the issues that refuse a workflow run.

The check answers with a workflow's issues, also for a damaged one, to
anyone who can read the project. A run with a damaged or error issue is
refused with 422 and the full list, and never reaches Windmill. What the
caller may not use is part of that list: `layer_not_readable` at each step
that names it and, for a run only, `destination_not_writable`. An accepted
run removes the previous run's temporary results right before it is
submitted; a refused one leaves them. `check_workflow` is replaced where the
route's own behaviour is under test; the tests marked "real check" run it
for the codes the route relies on.
"""

from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from goatlib.tools import cleanup_temp
from goatlib.workflows.checks import Issue

import processes.routers.workflows as workflows_router
from processes.deps.auth import get_user_id
from processes.main import app
from processes.services import access
from processes.services.workflow_checks import recorded_feature_count

USER = "8f19467a-6287-4563-8905-588c3a736f39"
PROJECT = "3e870eb8-9633-44e9-8a43-36a7290f1ced"
FOLDER = "1c684d0f-f831-48a8-803f-98d7f00bbd23"
LAYER = "90e3bcb2-d7ec-4abf-955d-50633ab4a101"
OTHER = "47338d5a-0520-414a-b989-c3fe8af7c788"
BUNDLE = "5b0e3c9a-7f1d-4c2e-9a8b-3d4e5f6a7b8c"
WORKFLOW = "7a193b81-0000-4000-8000-000000000001"

ROADS: dict[str, Any] = {
    "id": "roads",
    "type": "dataset",
    "data": {"type": "dataset", "label": "Roads", "layerId": LAYER},
}
SCHOOLS: dict[str, Any] = {
    "id": "schools",
    "type": "dataset",
    "data": {"type": "dataset", "label": "Schools", "layerId": OTHER},
}
BUFFER: dict[str, Any] = {
    "id": "buffer",
    "type": "tool",
    "data": {"type": "tool", "processId": "buffer", "config": {"distances": [100]}},
}
# A buffer whose own (unconnected) input names the schools layer.
BUFFER_ON_SCHOOLS: dict[str, Any] = {
    "id": "buffer",
    "type": "tool",
    "data": {
        "type": "tool",
        "processId": "buffer",
        "config": {"input_layer_id": OTHER, "distances": [100]},
    },
}
ROADS_TO_BUFFER = [
    {
        "id": "e1",
        "source": "roads",
        "target": "buffer",
        "targetHandle": "input_layer_id",
    }
]
DAMAGED_NODES = [{"type": "tool", "data": {"type": "tool"}}]  # a step without an id

NOT_CONNECTED = Issue(
    code="input_not_connected",
    level="error",
    message="Buffer: the input layer is not connected.",
    node_ids=("buffer",),
    field="input_layer_id",
    params={"step": "Buffer", "label": "Input layer"},
)
LONELY = Issue(
    code="step_not_connected",
    level="warning",
    message="Schools: the step is not connected.",
    node_ids=("schools",),
    params={"step": "Schools"},
)


class FakeCheck:
    """`check_workflow` answering with fixed issues; records each call."""

    def __init__(self) -> None:
        self.issues: list[Issue] = []
        self.calls: list[dict[str, Any]] = []

    async def __call__(
        self,
        nodes: list[dict[str, Any]],
        edges: list[dict[str, Any]],
        variables: list[dict[str, Any]],
        *,
        language: str,
        unreadable_layer_ids: frozenset[str],
        layer_fields: Any,
        layer_feature_count: Any = None,
    ) -> list[Issue]:
        self.calls.append(
            {
                "nodes": nodes,
                "variables": variables,
                "language": language,
                "unreadable_layer_ids": unreadable_layer_ids,
                "layer_feature_count": layer_feature_count,
            }
        )
        return list(self.issues)


@pytest.fixture
def client() -> Iterator[TestClient]:
    app.dependency_overrides[get_user_id] = lambda: UUID(USER)
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_user_id, None)


@pytest.fixture(autouse=True)
def temp_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Workflow temp results under a test directory, never /app/data."""
    monkeypatch.setattr(cleanup_temp, "TEMP_DATA_ROOT", tmp_path)
    return tmp_path


@pytest.fixture
def previous_results(temp_root: Path) -> Path:
    """The caller's last run of this workflow left a step's result."""
    workflow_dir = (
        temp_root / f"user_{USER.replace('-', '')}" / f"w_{WORKFLOW.replace('-', '')}"
    )
    (workflow_dir / "n_buffer").mkdir(parents=True)
    (workflow_dir / "n_buffer" / "metadata.json").write_text("{}")
    return workflow_dir


@pytest.fixture
def check(monkeypatch: pytest.MonkeyPatch) -> FakeCheck:
    fake = FakeCheck()
    monkeypatch.setattr(workflows_router, "check_workflow", fake)
    return fake


@pytest.fixture
def no_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    """The real check without DuckLake: no layer's fields are known."""

    async def unknown(layer_id: str) -> list[str] | None:
        return None

    monkeypatch.setattr(workflows_router, "ducklake_layer_fields", unknown)


@pytest.fixture
def submitted(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    jobs: list[dict[str, Any]] = []

    async def submit(script_path: str, args: dict[str, Any], **_: Any) -> str:
        jobs.append(args)
        return "job-1"

    monkeypatch.setattr(workflows_router.windmill_client, "run_script_async", submit)
    return jobs


def refuse(
    monkeypatch: pytest.MonkeyPatch, refused: set[str]
) -> list[list[dict[str, str]]]:
    """The access check refusing every reference whose id is in `refused`,
    answered in the shape the database answers with; returns what was asked."""
    asked: list[list[dict[str, str]]] = []

    async def answer(
        user_id: Any, entries: list[dict[str, str]]
    ) -> list[dict[str, str]]:
        asked.append(entries)
        return [
            {"kind": e["kind"], "raw_id": e["id"], "action": e["action"]}
            for e in entries
            if e["id"] in refused
        ]

    monkeypatch.setattr(access, "denied_references", answer)
    return asked


def _check(
    client: TestClient, nodes: list[Any], edges: list[Any] | None = None, **kw: Any
) -> Any:
    return client.post(
        "/workflows/check",
        json={"project_id": PROJECT, "nodes": nodes, "edges": edges or []},
        **kw,
    )


def _run(client: TestClient, nodes: list[Any], edges: list[Any] | None = None) -> Any:
    return client.post(
        f"/workflows/{WORKFLOW}/execute",
        json={
            "project_id": PROJECT,
            "folder_id": FOLDER,
            "nodes": nodes,
            "edges": edges or [],
        },
    )


def _codes(issues: list[dict[str, Any]]) -> list[tuple[str, list[str]]]:
    return [(issue["code"], issue["node_ids"]) for issue in issues]


# --- POST /workflows/check ---------------------------------------------------


def test_the_check_answers_with_the_issues_in_the_callers_language(
    client: TestClient, check: FakeCheck
) -> None:
    check.issues = [NOT_CONNECTED, LONELY]

    response = _check(
        client,
        [ROADS, SCHOOLS, BUFFER],
        headers={"Accept-Language": "de-DE,de;q=0.9,en;q=0.8"},
    )

    assert response.status_code == 200, response.text
    assert response.json() == {"issues": [NOT_CONNECTED.to_dict(), LONELY.to_dict()]}
    (call,) = check.calls
    assert call["language"] == "de"
    assert call["unreadable_layer_ids"] == frozenset()
    assert call["variables"] == []


def test_the_check_and_a_run_know_the_feature_counts_core_keeps(
    client: TestClient, check: FakeCheck, submitted: list[dict[str, Any]]
) -> None:
    """The heatmap's destination limit is judged on the counts catalog
    copies recorded, by the check and by a run alike."""
    _check(client, [ROADS, BUFFER], ROADS_TO_BUFFER)
    _run(client, [ROADS, BUFFER], ROADS_TO_BUFFER)

    assert [call["layer_feature_count"] for call in check.calls] == [
        recorded_feature_count,
        recorded_feature_count,
    ]


def test_a_damaged_workflow_is_checked_with_200(
    client: TestClient, check: FakeCheck
) -> None:
    response = _check(client, DAMAGED_NODES)

    assert response.status_code == 200, response.text
    issues = response.json()["issues"]
    assert ("node_without_id", "damaged") in [(i["code"], i["level"]) for i in issues]
    assert {i["level"] for i in issues} == {"damaged"}
    assert check.calls == []


@pytest.mark.parametrize("nodes", [[ROADS], DAMAGED_NODES])
def test_a_project_the_caller_cannot_read_is_not_found(
    client: TestClient,
    check: FakeCheck,
    monkeypatch: pytest.MonkeyPatch,
    nodes: list[Any],
) -> None:
    """404, like a project that does not exist, damaged workflow or not."""
    refuse(monkeypatch, {PROJECT})

    response = _check(client, nodes)

    assert response.status_code == 404, response.text
    assert check.calls == []


def test_a_viewer_can_check_and_sees_no_destination_issue(
    client: TestClient, check: FakeCheck, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Reading the project is enough to check a workflow; where a run's results
    would go is the run's concern, so a viewer never sees it as an issue."""

    async def answer(
        user_id: Any, entries: list[dict[str, str]]
    ) -> list[dict[str, str]]:
        return [
            {"kind": e["kind"], "raw_id": e["id"], "action": e["action"]}
            for e in entries
            if e["action"] == "write"
        ]

    monkeypatch.setattr(access, "denied_references", answer)
    check.issues = [NOT_CONNECTED]

    response = _check(client, [ROADS, SCHOOLS, BUFFER])

    assert response.status_code == 200, response.text
    codes = [issue["code"] for issue in response.json()["issues"]]
    assert codes == ["input_not_connected"]


def test_the_check_names_the_steps_whose_data_the_caller_cannot_read(
    client: TestClient, check: FakeCheck, monkeypatch: pytest.MonkeyPatch
) -> None:
    asked = refuse(monkeypatch, {OTHER})

    response = _check(
        client,
        [ROADS, SCHOOLS, BUFFER_ON_SCHOOLS],
        headers={"Accept-Language": "de"},
    )

    assert response.status_code == 200, response.text
    assert check.calls[0]["unreadable_layer_ids"] == frozenset({OTHER})
    issues = response.json()["issues"]
    assert [(i["code"], i["level"], i["node_ids"], i["params"]) for i in issues] == [
        ("layer_not_readable", "error", ["schools"], {"step": "Schools"}),
        # No label: the tool's title in the caller's language.
        ("layer_not_readable", "error", ["buffer"], {"step": "Puffer"}),
    ]
    # One round trip: the project is read, the destination is not asked.
    (entries,) = asked
    assert {(e["kind"], e["action"]) for e in entries} == {
        ("project", "read"),
        ("layer", "read"),
    }


def test_a_network_the_caller_cannot_read_reaches_the_check(
    client: TestClient, check: FakeCheck, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A tool step is named by a refused network (bundle) in its settings, so
    bundle ids are among `unreadable_layer_ids` and the step gets the issue."""
    refuse(monkeypatch, {BUNDLE})
    oev = {
        "id": "oev",
        "type": "tool",
        "data": {
            "type": "tool",
            "processId": "oev_gueteklassen",
            "config": {"pt_network_bundle_id": BUNDLE},
        },
    }

    response = _check(client, [oev])

    assert response.status_code == 200, response.text
    assert check.calls[0]["unreadable_layer_ids"] == frozenset({BUNDLE})
    assert _codes(response.json()["issues"]) == [("layer_not_readable", ["oev"])]


def test_a_step_the_check_already_reported_is_not_reported_twice(
    client: TestClient, check: FakeCheck, monkeypatch: pytest.MonkeyPatch
) -> None:
    refuse(monkeypatch, {OTHER})
    check.issues = [
        Issue(
            code="layer_not_readable",
            level="error",
            message="Schools: you cannot read the data this step uses.",
            node_ids=("schools",),
            params={"step": "Schools"},
        )
    ]

    response = _check(client, [ROADS, SCHOOLS, BUFFER_ON_SCHOOLS])

    assert _codes(response.json()["issues"]) == [
        ("layer_not_readable", ["schools"]),
        ("layer_not_readable", ["buffer"]),
    ]


def test_an_unknown_tool_is_an_issue_not_a_refused_check(
    client: TestClient, no_fields: None
) -> None:
    """Real check: a tool that no longer exists is `tool_removed`."""
    removed = {
        "id": "old",
        "type": "tool",
        "data": {"type": "tool", "processId": "catchment_area", "config": {}},
    }
    edges = [
        {
            "id": "e1",
            "source": "roads",
            "target": "old",
            "targetHandle": "input_layer_id",
        }
    ]

    response = _check(client, [ROADS, removed], edges)

    assert response.status_code == 200, response.text
    assert ("tool_removed", ["old"]) in _codes(response.json()["issues"])


# --- POST /workflows/{id}/execute --------------------------------------------


def test_a_run_with_errors_is_refused_with_all_its_issues(
    client: TestClient, check: FakeCheck, submitted: list[dict[str, Any]]
) -> None:
    check.issues = [NOT_CONNECTED, LONELY]

    response = _run(client, [ROADS, SCHOOLS, BUFFER])

    assert response.status_code == 422, response.text
    assert response.json()["detail"] == {
        "message": "The workflow has issues.",
        "issues": [NOT_CONNECTED.to_dict(), LONELY.to_dict()],
    }
    assert submitted == []


def test_a_run_with_only_warnings_starts(
    client: TestClient, check: FakeCheck, submitted: list[dict[str, Any]]
) -> None:
    check.issues = [LONELY]

    response = _run(client, [ROADS, SCHOOLS, BUFFER], ROADS_TO_BUFFER)

    assert response.status_code == 201, response.text
    assert response.json()["job_id"] == "job-1"
    (args,) = submitted
    assert args["user_id"] == USER
    assert args["nodes"] == [ROADS, SCHOOLS, BUFFER]
    assert args["edges"] == ROADS_TO_BUFFER


def test_a_refused_run_leaves_the_previous_results(
    client: TestClient,
    check: FakeCheck,
    submitted: list[dict[str, Any]],
    previous_results: Path,
) -> None:
    check.issues = [NOT_CONNECTED]

    response = _run(client, [ROADS, SCHOOLS, BUFFER])

    assert response.status_code == 422, response.text
    assert (previous_results / "n_buffer" / "metadata.json").exists()
    assert submitted == []


def test_an_accepted_run_removes_the_previous_results_before_it_starts(
    client: TestClient,
    check: FakeCheck,
    previous_results: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    still_there: list[bool] = []

    async def submit(script_path: str, args: dict[str, Any], **_: Any) -> str:
        still_there.append(previous_results.exists())
        return "job-1"

    monkeypatch.setattr(workflows_router.windmill_client, "run_script_async", submit)

    response = _run(client, [ROADS, BUFFER], ROADS_TO_BUFFER)

    assert response.status_code == 201, response.text
    assert still_there == [False]


def test_a_damaged_run_is_refused_before_anything_is_asked(
    client: TestClient,
    check: FakeCheck,
    submitted: list[dict[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    asked = refuse(monkeypatch, set())

    response = _run(client, DAMAGED_NODES)

    assert response.status_code == 422, response.text
    issues = response.json()["detail"]["issues"]
    assert ("node_without_id", "damaged") in [(i["code"], i["level"]) for i in issues]
    assert asked == []
    assert check.calls == []
    assert submitted == []


def test_a_refused_run_names_the_steps_it_cannot_use(
    client: TestClient,
    check: FakeCheck,
    submitted: list[dict[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Node ids and labels are the caller's own, so the answer reveals
    nothing about the data, not even whether it exists."""
    refuse(monkeypatch, {OTHER})

    response = _run(client, [ROADS, SCHOOLS, BUFFER_ON_SCHOOLS])

    assert response.status_code == 422, response.text
    assert _codes(response.json()["detail"]["issues"]) == [
        ("layer_not_readable", ["schools"]),
        ("layer_not_readable", ["buffer"]),
    ]
    assert submitted == []


def test_a_destination_the_caller_cannot_write_refuses_the_run(
    client: TestClient,
    check: FakeCheck,
    submitted: list[dict[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    refuse(monkeypatch, {PROJECT, FOLDER})

    response = _run(client, [ROADS, BUFFER], ROADS_TO_BUFFER)

    assert response.status_code == 422, response.text
    (issue,) = response.json()["detail"]["issues"]
    assert (issue["code"], issue["level"], issue["node_ids"]) == (
        "destination_not_writable",
        "error",
        [],
    )
    assert submitted == []


def test_a_refusal_no_step_stands_for_still_refuses_the_run(
    client: TestClient,
    check: FakeCheck,
    submitted: list[dict[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An empty copy reads its template, which no step shows: the run is
    refused as a plain 404 and never submitted."""
    refuse(monkeypatch, {OTHER})
    empty_copy = {
        "id": "copy",
        "type": "tool",
        "data": {
            "type": "tool",
            "processId": "layer_copy",
            "config": {
                "source_layer_id": LAYER,
                "copy_content": False,
                "template_id": OTHER,
            },
        },
    }

    response = _run(client, [empty_copy])

    assert response.status_code == 404, response.text
    assert submitted == []


def test_a_run_never_submits_an_unregistered_tool(
    client: TestClient, check: FakeCheck, submitted: list[dict[str, Any]]
) -> None:
    """Even when the check reports nothing for it: the runner would start
    `f/goat/tools/<processId>`."""
    unknown = {
        "id": "x",
        "type": "tool",
        "data": {"type": "tool", "processId": "../buffer", "config": {}},
    }

    response = _run(client, [unknown])

    assert response.status_code == 422, response.text
    assert submitted == []


def test_a_run_whose_access_cannot_be_checked_answers_503(
    client: TestClient,
    check: FakeCheck,
    submitted: list[dict[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def broken(user_id: Any, entries: Any) -> Any:
        raise ConnectionError("database unreachable")

    monkeypatch.setattr(access, "denied_references", broken)

    response = _run(client, [ROADS, BUFFER], ROADS_TO_BUFFER)

    assert response.status_code == 503, response.text
    assert submitted == []


def test_a_tool_step_without_a_tool_refuses_the_run(
    client: TestClient, no_fields: None, submitted: list[dict[str, Any]]
) -> None:
    """Real check: `tool_missing` blocks the run."""
    empty = {
        "id": "empty",
        "type": "tool",
        "data": {"type": "tool", "processId": "", "config": {}},
    }
    edges = [
        {
            "id": "e1",
            "source": "roads",
            "target": "empty",
            "targetHandle": "input_layer_id",
        }
    ]

    response = _run(client, [ROADS, empty], edges)

    assert response.status_code == 422, response.text
    assert ("tool_missing", ["empty"]) in _codes(response.json()["detail"]["issues"])
    assert submitted == []


def test_a_run_with_a_step_id_that_leaves_the_temp_folder_is_refused(
    client: TestClient, check: FakeCheck, submitted: list[dict[str, Any]]
) -> None:
    """Refused for the id alone: the check (faked) finds nothing else."""
    escaping = {**BUFFER, "id": "../../user_other/w_x/n_y"}
    edges = [{**ROADS_TO_BUFFER[0], "target": escaping["id"]}]

    response = _run(client, [ROADS, escaping], edges)

    assert response.status_code == 422, response.text
    assert submitted == []
    assert check.calls == []


def test_a_run_of_a_workflow_id_that_is_not_a_uuid_is_refused(
    client: TestClient, check: FakeCheck, submitted: list[dict[str, Any]]
) -> None:
    """A workflow id becomes a folder name too. (A literal `..` never reaches
    the route: clients and proxies resolve it in the path first.)"""
    response = client.post(
        "/workflows/not-a-uuid/execute",
        json={
            "project_id": PROJECT,
            "folder_id": FOLDER,
            "nodes": [ROADS, BUFFER],
            "edges": ROADS_TO_BUFFER,
        },
    )

    assert response.status_code == 422, response.text
    assert submitted == []
    assert check.calls == []


def test_a_finalize_with_a_step_id_that_leaves_the_temp_folder_is_refused(
    client: TestClient, submitted: list[dict[str, Any]]
) -> None:
    response = client.post(
        f"/workflows/{WORKFLOW}/finalize",
        json={"workflow_id": WORKFLOW, "node_id": "../x", "project_id": PROJECT},
    )

    assert response.status_code == 422, response.text
    assert submitted == []


def test_a_tool_step_keeps_its_tools_title_in_an_access_issue(
    client: TestClient, check: FakeCheck, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The editor labels a new tool step with its tool's id.
    refuse(monkeypatch, {OTHER})
    labelled = {
        **BUFFER_ON_SCHOOLS,
        "data": {**BUFFER_ON_SCHOOLS["data"], "label": "buffer"},
    }

    response = _check(client, [labelled])

    assert response.status_code == 200, response.text
    (issue,) = response.json()["issues"]
    assert issue["params"] == {"step": "Buffer"}
