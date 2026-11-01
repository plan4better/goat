"""The release-gate scan lists damaged workflows and the runs the checks would
refuse, and fails when there is any; it only reads."""

import json
from pathlib import Path
from typing import Any

import pytest
from goatlib.workflows.checks import Issue

from processes.scripts import scan_workflow_checks as scan

GOOD = {
    "nodes": [{"id": "d1", "type": "dataset", "data": {"type": "dataset"}}],
    "edges": [],
}
DAMAGED = {"nodes": [{"type": "tool"}], "edges": []}


def _row(workflow_id: str, config: Any, name: str = "wf") -> scan.WorkflowRow:
    return scan.WorkflowRow(
        id=workflow_id, project_id="p-" + workflow_id, name=name, config=config
    )


class FakeHistory:
    def __init__(self, jobs: dict[str, dict[str, Any]]) -> None:
        self.jobs = jobs

    def latest_successful_run(self, workflow_id: str) -> dict[str, Any] | None:
        return self.jobs.get(workflow_id)


def _job(job_id: str, nodes: Any, variables: Any = None) -> dict[str, Any]:
    args: dict[str, Any] = {"workflow_id": "ignored", "nodes": nodes, "edges": []}
    if variables is not None:
        args["variables"] = variables
    return {"id": job_id, "args": args, "result": {"status": "success"}}


async def _no_fields(layer_id: str) -> list[str] | None:
    return None


def test_damaged_workflows_lists_codes_and_skips_valid_ones() -> None:
    rows = [_row("w1", GOOD), _row("w2", DAMAGED, "Broken"), _row("w3", None)]

    assert scan.damaged_workflows(rows) == [
        {
            "workflow_id": "w2",
            "project_id": "p-w2",
            "name": "Broken",
            "codes": ["node_without_id"],
        },
        {
            "workflow_id": "w3",
            "project_id": "p-w3",
            "name": "wf",
            "codes": ["config_not_object"],
        },
    ]


def test_runs_come_from_each_workflows_latest_successful_job() -> None:
    rows = [_row("w1", GOOD), _row("w2", GOOD)]
    nodes = [{"id": "t1", "type": "tool", "data": {"type": "tool"}}]
    history = FakeHistory({"w1": _job("job-1", nodes, variables={"bad": 1})})

    runs, without_run = scan.runs_from_history(rows, history)

    assert without_run == 1
    assert len(runs) == 1
    assert runs[0].workflow.id == "w1"
    assert runs[0].job_id == "job-1"
    assert runs[0].nodes == nodes
    assert runs[0].edges == []
    assert runs[0].variables == []


def test_stored_configs_are_checked_with_ids_file() -> None:
    config = {**GOOD, "variables": [{"name": "v", "defaultValue": 1}]}
    runs = scan.runs_from_stored_configs([_row("w1", config), _row("w2", None)])

    assert [run.job_id for run in runs] == [None, None]
    assert runs[0].nodes == GOOD["nodes"]
    assert runs[0].variables == [{"name": "v", "defaultValue": 1}]
    assert runs[1].nodes is None


async def test_only_blocking_issues_make_a_run_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []

    async def fake_check(
        nodes: Any, edges: Any, variables: Any, **kwargs: Any
    ) -> list[Issue]:
        calls.append(kwargs)
        if nodes == "error":
            return [
                Issue(
                    "input_not_connected",
                    "error",
                    "Buffer: not connected.",
                    node_ids=("t1",),
                    field="input_layer_id",
                ),
                Issue("step_not_connected", "warning", "Note: not connected."),
            ]
        if nodes == "crash":
            raise KeyError("x-ui")
        return [Issue("field_maybe_missing", "warning", "Maybe missing.")]

    monkeypatch.setattr(scan, "check_workflow", fake_check)
    runs = [
        scan.Run(_row("w1", GOOD), "job-1", "error", [], []),
        scan.Run(_row("w2", GOOD), "job-2", "warning", [], []),
        scan.Run(_row("w3", GOOD), "job-3", "crash", [], []),
    ]

    refused = await scan.refused_runs(runs, _no_fields)

    assert [item["workflow_id"] for item in refused] == ["w1", "w3"]
    assert [issue["code"] for issue in refused[0]["issues"]] == ["input_not_connected"]
    assert refused[0]["job_id"] == "job-1"
    assert refused[1]["issues"][0]["code"] == "check_crashed"
    assert refused[1]["issues"][0]["message"] == "KeyError: 'x-ui'"
    assert all(call["unreadable_layer_ids"] == frozenset() for call in calls)
    assert all(call["language"] == "en" for call in calls)
    assert all(call["layer_fields"] is _no_fields for call in calls)
    # The feature counts the route judges the heatmap's destination limit on.
    assert all(
        call["layer_feature_count"] is scan.recorded_feature_count for call in calls
    )


def test_windmill_is_asked_for_the_latest_successful_run_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[tuple[str, dict[str, Any]]] = []

    class FakeResponse:
        def __init__(self, body: Any) -> None:
            self.body = body

        def json(self) -> Any:
            return self.body

    class FakeWindmill:
        def __init__(self, **kwargs: Any) -> None:
            pass

        def get(self, endpoint: str, **kwargs: Any) -> FakeResponse:
            requests.append((endpoint, kwargs["params"]))
            if endpoint.endswith("/jobs/completed/list"):
                return FakeResponse([{"id": "job-9"}])
            return FakeResponse({"id": "job-9", "args": {"nodes": []}})

    monkeypatch.setattr(scan, "Windmill", FakeWindmill)
    monkeypatch.setattr(scan.settings, "WINDMILL_WORKSPACE", "goat")

    job = scan.WindmillRunHistory().latest_successful_run("wf-1")

    assert job == {"id": "job-9", "args": {"nodes": []}}
    (list_path, list_params), (get_path, get_params) = requests
    assert list_path == "/w/goat/jobs/completed/list"
    assert list_params["script_path_exact"] == "f/goat/tools/workflow_runner"
    assert list_params["job_kinds"] == "script"
    assert list_params["success"] == "true"
    assert json.loads(list_params["args"]) == {"workflow_id": "wf-1"}
    assert json.loads(list_params["result"]) == {"status": "success"}
    assert list_params["per_page"] == 1
    assert get_path == "/w/goat/jobs_u/get/job-9"
    assert get_params == {"no_logs": "true"}


def _patch_main(
    monkeypatch: pytest.MonkeyPatch, rows: list[scan.WorkflowRow], issues: list[Issue]
) -> list[Any]:
    loaded: list[Any] = []

    async def fake_load(ids: Any) -> list[scan.WorkflowRow]:
        loaded.append(ids)
        return rows

    async def fake_check(*args: Any, **kwargs: Any) -> list[Issue]:
        return issues

    monkeypatch.setattr(scan, "load_workflows", fake_load)
    monkeypatch.setattr(scan, "check_workflow", fake_check)
    monkeypatch.setattr(
        scan, "WindmillRunHistory", lambda: FakeHistory({"w1": _job("job-1", [])})
    )
    monkeypatch.setattr(scan.ducklake_manager, "init", lambda settings: None)
    monkeypatch.setattr(scan.ducklake_manager, "close", lambda: None)
    return loaded


def test_main_fails_and_prints_what_would_be_refused(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    issue = Issue(
        "tool_removed", "error", 'Old: the tool "x" does not exist.', node_ids=("t1",)
    )
    _patch_main(monkeypatch, [_row("w1", GOOD, "Flow")], [issue])

    assert scan.main([]) == 1

    out = capsys.readouterr().out
    assert "Would be refused: 1" in out
    assert 'w1  project p-w1  "Flow"  run job-1' in out
    assert 'tool_removed [t1]: Old: the tool "x" does not exist.' in out


def test_main_passes_when_nothing_is_refused(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _patch_main(monkeypatch, [_row("w1", GOOD), _row("w2", GOOD)], [])

    assert scan.main(["--json"]) == 0

    report = json.loads(capsys.readouterr().out)
    assert report == {
        "damaged": [],
        "checked": 1,
        "without_run": 1,
        "source": "latest successful run",
        "refused": [],
    }


def test_main_with_ids_file_reads_only_those_workflows(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ids_file = tmp_path / "ids.txt"
    ids_file.write_text("# succeeded on dev\nw1\n\n w2 \n", encoding="utf-8")
    loaded = _patch_main(monkeypatch, [_row("w1", DAMAGED)], [])

    assert scan.main(["--ids-file", str(ids_file)]) == 1
    assert loaded == [["w1", "w2"]]
