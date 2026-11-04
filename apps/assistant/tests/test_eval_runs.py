"""The regression set of assistant-shaped workflows (evals/workflow_runs.json):
its configs are what to_config gives, each case runs where its tools can, and
the workflows an eval run created can join it. No model is called."""

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from evals import runs
from evals.__main__ import main
from evals.harness import Transcript
from evals.report import build_report
from evals.tasks import load_tasks

SET: dict[str, Any] = json.loads(runs.RUNS_FILE.read_text(encoding="utf-8"))


def _datasets(config: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        node["data"] for node in config["nodes"] if node["data"]["type"] == "dataset"
    ]


@pytest.mark.parametrize("case", SET["cases"], ids=lambda case: case["note"][:40])
def test_a_draft_case_keeps_the_config_to_config_gives(case: dict[str, Any]) -> None:
    if "draft" not in case:
        pytest.skip("added from an eval run: keeps the config core saved")
    assert case["config"] == runs.convert(
        case, SET["titles"]
    ), "run `uv run python -m evals runs` from apps/assistant"


@pytest.mark.parametrize("case", SET["cases"], ids=lambda case: case["note"][:40])
def test_a_case_runs_where_its_tools_can_and_on_layers_the_runners_have(
    case: dict[str, Any],
) -> None:
    assert case["run"] == runs.run_kind(case["config"])
    for data in _datasets(case["config"]):
        assert data.get("layerId")
        assert data.get("projectLayerId") in runs.RUNNABLE_LAYERS


def test_the_set_has_cases_for_both_runners() -> None:
    assert {case["run"] for case in SET["cases"]} == {"chain", "routing"}


def test_refresh_writes_the_configs_and_then_finds_nothing_to_change(
    tmp_path: Path,
) -> None:
    stale = json.loads(json.dumps(SET))
    for case in stale["cases"]:
        if "draft" in case:
            case["config"] = None
    path = tmp_path / "runs.json"
    path.write_text(json.dumps(stale), encoding="utf-8")
    drafts = sum("draft" in case for case in SET["cases"])
    assert runs.refresh(path) == drafts
    assert json.loads(path.read_text(encoding="utf-8")) == SET
    assert runs.refresh(path) == 0


def test_an_eval_runs_workflows_join_the_set_once_and_only_if_they_can_run(
    tmp_path: Path,
) -> None:
    config = SET["cases"][0]["config"]
    open_step = json.loads(json.dumps(config))
    _datasets(open_step)[0].pop("layerId")
    report = {
        "tasks": [
            {
                "id": "wf-01",
                "workflows": [
                    {"name": "Walk", "config": config},
                    {"name": "Open", "config": open_step},
                ],
            }
        ]
    }
    report_path = tmp_path / "results.json"
    report_path.write_text(json.dumps(report), encoding="utf-8")
    path = tmp_path / "runs.json"
    path.write_text(json.dumps({"titles": {}, "cases": []}), encoding="utf-8")
    added, skipped = runs.add_from_report(report_path, path)
    assert added == 1
    assert skipped == ["wf-01: 'Open' has a dataset step without a layer"]
    assert json.loads(path.read_text(encoding="utf-8"))["cases"] == [
        {"note": "wf-01: Walk", "run": runs.run_kind(config), "config": config}
    ]
    assert runs.add_from_report(report_path, path)[0] == 0


def test_a_workflow_with_a_note_converts_runs_and_joins_the_set(
    tmp_path: Path,
) -> None:
    """A note is no step: it changes neither where a case runs nor whether
    the runners can run it."""
    case = json.loads(
        json.dumps(next(case for case in SET["cases"] if "draft" in case))
    )
    first = case["draft"]["steps"][0]["id"]
    case["draft"]["notes"] = [
        {"id": "about", "text": "What the workflow answers.", "near": [first]}
    ]
    config = runs.convert(case, SET["titles"])
    assert [node["type"] for node in config["nodes"]].count("textAnnotation") == 1
    assert runs.run_kind(config) == case["run"]
    report_path = tmp_path / "results.json"
    report_path.write_text(
        json.dumps(
            {"tasks": [{"id": "wf-01", "workflows": [{"name": "W", "config": config}]}]}
        ),
        encoding="utf-8",
    )
    path = tmp_path / "runs.json"
    path.write_text(json.dumps({"titles": {}, "cases": []}), encoding="utf-8")
    assert runs.add_from_report(report_path, path) == (1, [])


def test_a_report_keeps_the_workflows_a_task_created() -> None:
    task = next(task for task in load_tasks() if task.suite == "workflow")
    config: dict[str, Any] = {"nodes": [], "edges": []}
    transcript = Transcript(
        task_id=task.id,
        answer="",
        tool_calls=[],
        proposals=[],
        requests={},
        error=None,
        input_tokens=0,
        output_tokens=0,
        seconds=1.0,
        first_text_seconds=None,
        saved=[{"id": "w-1", "name": "Walk", "config": config, "project_id": "p"}],
    )
    report = build_report(
        {"provider": "test", "model": "m"},
        None,
        [(task, transcript, [])],
        datetime.now(UTC),
    )
    assert report["tasks"][0]["workflows"] == [{"name": "Walk", "config": config}]


def test_runs_spends_no_tokens_so_ci_may_run_it(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    path = tmp_path / "runs.json"
    path.write_text(runs.RUNS_FILE.read_text(encoding="utf-8"), encoding="utf-8")
    monkeypatch.setattr(runs, "RUNS_FILE", path)
    monkeypatch.setenv("CI", "true")
    assert main(["runs"]) == 0
