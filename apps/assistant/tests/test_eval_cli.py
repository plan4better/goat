"""The eval CLI: never in CI, explicit about the model, and the only way a
model enters the tested-models list. No test here talks to a real model."""

import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest
from pydantic_ai.models.test import TestModel

from assistant.config import AssistantSettings
from assistant.llm import capabilities
from evals import __main__ as cli
from evals.__main__ import CliError, main
from evals.graders import Grade
from evals.harness import ToolCall, Transcript
from evals.judge import ModelJudge, Verdict, apply_judge
from evals.report import (
    PASS_SCORE,
    TESTED_FILE,
    build_report,
    promotion_refusal,
    write_report,
)
from evals.tasks import EVAL_SET_VERSION, EvalTask, JudgeCheck, load_tasks


@pytest.fixture(autouse=True)
def _no_dotenv(monkeypatch: pytest.MonkeyPatch) -> None:
    """The developer's root .env must not leak into os.environ through main()."""
    monkeypatch.setattr(cli, "load_dotenv", lambda *args, **kwargs: False)


def _report(
    fail: tuple[str, ...] = (),
    undecided: tuple[str, ...] = (),
    drop: tuple[str, ...] = (),
    **changes: object,
) -> dict[str, object]:
    """A full run of the current set: every task passes except those named."""
    records = []
    for task in load_tasks():
        if task.id in drop:
            continue
        state: bool | None = True
        if task.id in fail:
            state = False
        if task.id in undecided:
            state = None
        records.append(
            {
                "id": task.id,
                "suite": task.suite,
                "critical": task.critical,
                "passed": state is True,
                "grades": [
                    {"check": check.kind, "passed": state, "detail": ""}
                    for check in task.checks
                ],
            }
        )
    report: dict[str, object] = {
        "eval_set_version": EVAL_SET_VERSION,
        "model": {"provider": "anthropic", "model": "m-1"},
        "judge": {"provider": "anthropic", "model": "judge-1"},
        "summary": {"tasks": len(records)},
        "tasks": records,
        "finished_at": "2026-10-02T10:00:00+00:00",
    }
    report.update(changes)
    return report


def _plain_ids(suite: str, critical: bool, count: int) -> list[str]:
    return [
        task.id
        for task in load_tasks(suite)  # type: ignore[arg-type]
        if task.critical is critical
    ][:count]


def _judge_task() -> EvalTask:
    return next(
        task
        for task in load_tasks()
        if any(isinstance(check, JudgeCheck) for check in task.checks)
    )


def _transcript(task: EvalTask, **changes: object) -> Transcript:
    values: dict[str, object] = {
        "task_id": task.id,
        "answer": "An answer.",
        "tool_calls": [ToolCall("catalog_search", {}, {"items": []}, False)],
        "proposals": [],
        "requests": {},
        "error": None,
        "input_tokens": 10,
        "output_tokens": 5,
        "seconds": 1.0,
        "first_text_seconds": 0.5,
    }
    values.update(changes)
    return Transcript(**values)  # type: ignore[arg-type]


def test_refuses_to_run_in_ci(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("CI", "true")
    assert (
        main(["run", "--provider", "test", "--model", "test", "--allow-test-model"])
        == 2
    )
    assert "never in CI" in capsys.readouterr().err


def test_ci_set_to_false_is_not_ci(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("CI", "false")
    # Past the CI guard, the test provider is refused for another reason.
    assert main(["run", "--provider", "test", "--model", "test"]) == 2
    assert "never in CI" not in capsys.readouterr().err


def test_list_and_promote_are_not_blocked_in_ci(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("CI", "true")
    assert main(["list"]) == 0
    assert len(capsys.readouterr().out.splitlines()) == len(load_tasks())


def test_refuses_the_test_model_unless_asked(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CI", raising=False)
    assert main(["run", "--provider", "test", "--model", "test"]) == 2


def test_refuses_without_a_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CI", raising=False)
    monkeypatch.setenv("ASSISTANT_DEFAULT_PROVIDER", "none")
    assert main(["run"]) == 2


def test_refuses_an_unknown_task_id(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
) -> None:
    monkeypatch.delenv("CI", raising=False)
    code = main(
        [
            "run",
            "--provider",
            "test",
            "--model",
            "test",
            "--allow-test-model",
            "--task",
            "cat-99",
            "--no-judge",
            "--results-dir",
            str(tmp_path),
        ]
    )
    assert code == 2
    assert "cat-99" in capsys.readouterr().err
    assert list(tmp_path.glob("*.json")) == []


def test_a_run_writes_a_report(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("CI", raising=False)
    code = main(
        [
            "run",
            "--provider",
            "test",
            "--model",
            "test",
            "--allow-test-model",
            "--task",
            "cat-14",
            "--no-judge",
            "--results-dir",
            str(tmp_path),
        ]
    )
    assert code == 0
    [path] = list(tmp_path.glob("*.json"))
    report = json.loads(path.read_text())
    assert report["model"] == {"provider": "test", "model": "test"}
    assert report["summary"]["tasks"] == 1
    assert report["tasks"][0]["id"] == "cat-14"
    assert {
        "grades",
        "seconds",
        "first_text_seconds",
        "input_tokens",
        "answer",
    } <= set(report["tasks"][0])


def test_promotion_is_refused_below_the_score() -> None:
    # 60 of 71 (0.845): below the score, while each suite stays at 0.8 or more
    # (catalog 29 of 36, project 21 of 24, workflow 10 of 11).
    plain = (
        _plain_ids("catalog", False, 7)
        + _plain_ids("project", False, 3)
        + _plain_ids("workflow", False, 1)
    )
    refusal = promotion_refusal(_report(fail=tuple(plain)))
    assert refusal is not None and "score" in refusal


def test_promotion_is_refused_after_a_critical_failure() -> None:
    critical = _plain_ids("catalog", True, 1)
    refusal = promotion_refusal(_report(fail=tuple(critical)))
    assert refusal is not None and critical[0] in refusal


def test_promotion_is_refused_with_undecided_judge_checks() -> None:
    refusal = promotion_refusal(_report(undecided=("cat-01",)))
    assert refusal is not None and "judge" in refusal


def test_promotion_is_refused_for_a_weak_suite() -> None:
    # 19 of 24 project tasks (0.79), while the whole set stays above the score.
    refusal = promotion_refusal(_report(fail=tuple(_plain_ids("project", False, 5))))
    assert refusal is not None and "project" in refusal


def test_promotion_is_refused_for_a_partial_run() -> None:
    refusal = promotion_refusal(_report(drop=("cat-01",)))
    assert refusal is not None and "cat-01" in refusal


def test_promotion_goes_by_the_task_records_not_the_summary() -> None:
    plain = tuple(
        _plain_ids("catalog", False, 7)
        + _plain_ids("project", False, 3)
        + _plain_ids("workflow", False, 1)
    )
    report = _report(fail=plain)
    report["summary"] = {
        "tasks": 71,
        "score": 1.0,
        "undecided": 0,
        "critical_failed": [],
    }
    assert promotion_refusal(report) is not None


@pytest.mark.parametrize(
    "damage", ["no_tasks", "no_grades", "bad_state", "duplicate", "extra"]
)
def test_a_malformed_report_is_a_refusal_not_a_crash(damage: str) -> None:
    report = _report()
    records = report["tasks"]
    assert isinstance(records, list)
    if damage == "no_tasks":
        del report["tasks"]
    elif damage == "no_grades":
        del records[3]["grades"]
    elif damage == "bad_state":
        records[3]["grades"][0]["passed"] = "yes"
    elif damage == "duplicate":
        records.append(dict(records[0]))
    else:
        records.append({**records[0], "id": "cat-99"})
    assert promotion_refusal(report) is not None


def test_promotion_is_refused_for_a_test_judge_or_none() -> None:
    assert "judge" in (
        promotion_refusal(_report(judge={"provider": "test", "model": "test"})) or ""
    )
    assert "judge" in (promotion_refusal(_report(judge=None)) or "")


def test_promotion_is_refused_when_the_model_judged_itself() -> None:
    refusal = promotion_refusal(
        _report(judge={"provider": "anthropic", "model": "m-1"})
    )
    assert refusal is not None
    assert "judged itself" in refusal and "--judge-model" in refusal
    # The same model id under another provider is a different model.
    assert (
        promotion_refusal(_report(judge={"provider": "openai", "model": "m-1"})) is None
    )


def test_promote_records_the_judge(tmp_path: Path) -> None:
    tested = tmp_path / "tested_models.json"
    tested.write_text(json.dumps({"description": "d", "models": []}))
    results = tmp_path / "r.json"
    results.write_text(json.dumps(_report()))
    assert main(["promote", str(results), "--tested-file", str(tested)]) == 0
    entry = json.loads(tested.read_text())["models"][0]
    assert entry["judge"] == {"provider": "anthropic", "model": "judge-1"}


def test_promotion_is_refused_for_another_set_version() -> None:
    report = _report()
    report["eval_set_version"] = EVAL_SET_VERSION + 1
    refusal = promotion_refusal(report)
    assert refusal is not None and "version" in refusal


def test_the_bar_itself_passes() -> None:
    assert promotion_refusal(_report()) is None
    # 40 of 46 tasks is the lowest passing count at 0.85.
    plain = tuple(_plain_ids("catalog", False, 3) + _plain_ids("project", False, 3))
    assert 40 / 46 >= PASS_SCORE
    assert promotion_refusal(_report(fail=plain)) is None


def test_promote_adds_one_entry_per_model(tmp_path: Path) -> None:
    tested = tmp_path / "tested_models.json"
    tested.write_text(
        json.dumps(
            {
                "description": "d",
                "models": [{"provider": "anthropic", "model": "m-1", "score": 0.5}],
            }
        )
    )
    results = tmp_path / "r.json"
    results.write_text(json.dumps(_report()))
    assert main(["promote", str(results), "--tested-file", str(tested)]) == 0
    data = json.loads(tested.read_text())
    models = data["models"]
    assert data["description"] == "d"
    assert len(models) == 1
    assert models[0]["provider"] == "anthropic"
    assert models[0]["eval_set_version"] == EVAL_SET_VERSION
    assert models[0]["results"] == "r.json"
    assert models[0]["date"] == "2026-10-02"
    assert models[0]["score"] == 1.0


def test_promote_refuses_the_test_provider(tmp_path: Path) -> None:
    tested = tmp_path / "tested_models.json"
    tested.write_text(json.dumps({"description": "d", "models": []}))
    report = _report()
    report["model"] = {"provider": "test", "model": "test"}
    results = tmp_path / "r.json"
    results.write_text(json.dumps(report))
    assert main(["promote", str(results), "--tested-file", str(tested)]) == 1
    assert json.loads(tested.read_text())["models"] == []


def test_promote_refuses_a_missing_file(tmp_path: Path) -> None:
    tested = tmp_path / "tested_models.json"
    tested.write_text(json.dumps({"description": "d", "models": []}))
    assert (
        main(["promote", str(tmp_path / "nope.json"), "--tested-file", str(tested)])
        == 1
    )


def test_the_real_tested_models_file_still_loads() -> None:
    data = json.loads(TESTED_FILE.read_text())
    assert "python -m evals promote" in data["description"]
    assert capabilities._load_tested() == frozenset(
        (m["provider"], m["model"]) for m in data["models"]
    )


def test_results_are_kept_out_of_git() -> None:
    probe = TESTED_FILE.parents[3] / "evals" / "results" / "20261002-x.json"
    ignored = subprocess.run(
        ["git", "check-ignore", "-q", str(probe)], cwd=probe.parent, check=False
    )
    assert ignored.returncode == 0


async def test_the_judge_decides_only_the_judge_checks() -> None:
    task = _judge_task()
    transcript = _transcript(task)
    grades = [
        Grade(check.kind, None if isinstance(check, JudgeCheck) else True, "x")
        for check in task.checks
    ]
    judge = ModelJudge(
        TestModel(custom_output_args={"passed": True, "reason": "Meets the rubric."})
    )
    decided = await apply_judge(task, transcript, grades, judge)
    for check, before, after in zip(task.checks, grades, decided, strict=True):
        if isinstance(check, JudgeCheck):
            assert (after.passed, after.detail) == (True, "Meets the rubric.")
        else:
            assert after == before


async def test_a_judge_failure_leaves_the_check_undecided() -> None:
    class Broken:
        async def judge(
            self, task: EvalTask, rubric: str, transcript: Transcript
        ) -> Verdict:
            raise RuntimeError("provider down")

    task = _judge_task()
    grades = [Grade(check.kind, None, "judge") for check in task.checks]
    decided = await apply_judge(task, _transcript(task), grades, Broken())
    undecided = [g for g in decided if g.passed is None]
    assert undecided and "provider down" in undecided[0].detail


async def test_without_a_judge_the_checks_stay_undecided() -> None:
    task = _judge_task()
    grades = [Grade(check.kind, None, "judge") for check in task.checks]
    decided = await apply_judge(task, _transcript(task), grades, None)
    assert [
        g.passed
        for g, c in zip(decided, task.checks, strict=True)
        if isinstance(c, JudgeCheck)
    ] == [None]


async def test_a_failed_run_fails_its_judge_checks() -> None:
    class NeverCalled:
        async def judge(
            self, task: EvalTask, rubric: str, transcript: Transcript
        ) -> Verdict:
            raise AssertionError("a failed run is not judged")

    task = _judge_task()
    transcript = _transcript(task, error="TimeoutError: ", answer="")
    grades = [Grade(check.kind, None, "judge") for check in task.checks]
    decided = await apply_judge(task, transcript, grades, NeverCalled())
    assert all(
        g.passed is False
        for g, c in zip(decided, task.checks, strict=True)
        if isinstance(c, JudgeCheck)
    )


def test_the_module_runs_with_python_dash_m() -> None:
    root = TESTED_FILE.parents[3]
    out = subprocess.run(
        [sys.executable, "-m", "evals", "list"],
        cwd=root,
        capture_output=True,
        text=True,
        check=True,
    )
    assert len(out.stdout.splitlines()) == len(load_tasks())


def _settings(monkeypatch: pytest.MonkeyPatch, **env: str) -> AssistantSettings:
    for name in list(os.environ):
        if name.startswith("ASSISTANT_DEFAULT_") or name.startswith("ASSISTANT_EVAL_"):
            monkeypatch.delenv(name)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    return AssistantSettings()


_GOAT_AI = {
    "ASSISTANT_DEFAULT_PROVIDER": "anthropic",
    "ASSISTANT_DEFAULT_MODEL": "goat-model",
    "ASSISTANT_DEFAULT_API_KEY": "sk-instance-key-123456",
}


def test_the_default_provider_uses_the_instance_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(monkeypatch, **_GOAT_AI)
    target = cli._target(
        settings, "anthropic", "other-model", None, None, "ASSISTANT_EVAL_API_KEY"
    )
    assert target is not None
    assert target.credentials == {"api_key": "sk-instance-key-123456"}


def test_an_own_key_wins_over_the_instance_key(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = _settings(monkeypatch, **_GOAT_AI, ASSISTANT_EVAL_API_KEY="sk-own")
    target = cli._target(
        settings, "anthropic", "m", None, None, "ASSISTANT_EVAL_API_KEY"
    )
    assert target is not None and target.credentials == {"api_key": "sk-own"}


def test_another_provider_needs_its_own_key(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = _settings(monkeypatch, **_GOAT_AI)
    with pytest.raises(CliError, match="ASSISTANT_EVAL_API_KEY"):
        cli._target(settings, "openai", "m", None, None, "ASSISTANT_EVAL_API_KEY")


def test_the_same_provider_at_another_url_needs_its_own_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(monkeypatch, **_GOAT_AI)
    with pytest.raises(CliError, match="never used for another endpoint"):
        cli._target(
            settings,
            "anthropic",
            "m",
            "https://proxy.example.org",
            None,
            "ASSISTANT_EVAL_API_KEY",
        )
    with pytest.raises(CliError, match="MY_KEY"):
        cli._target(settings, "anthropic", "m", None, "eu-1", "MY_KEY")


def test_the_instance_key_never_reaches_a_judge_elsewhere(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("CI", raising=False)
    for name, value in _GOAT_AI.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("ASSISTANT_EVAL_JUDGE_API_KEY", raising=False)
    code = main(
        ["run", "--judge-provider", "openai", "--judge-model", "j", "--task", "cat-14"]
    )
    assert code == 2
    assert "ASSISTANT_EVAL_JUDGE_API_KEY" in capsys.readouterr().err


def test_a_provider_without_a_key_chain_needs_no_key_variable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(monkeypatch, **_GOAT_AI)
    target = cli._target(settings, "bedrock", "claude-x", None, "eu-central-1", "K")
    assert target is not None and target.credentials == {}


@pytest.mark.parametrize(
    "flags",
    [
        ["--model", "m"],
        ["--base-url", "https://x.example.org"],
        ["--region", "eu-1"],
        ["--api-key-env", "K"],
        ["--judge-model", "j"],
        ["--judge-base-url", "https://x.example.org"],
        ["--judge-api-key-env", "K"],
        ["--no-judge", "--judge-provider", "openai"],
    ],
)
def test_flags_that_would_be_ignored_are_an_error(
    flags: list[str],
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.delenv("CI", raising=False)
    assert main(["run", *flags]) == 2
    assert capsys.readouterr().err.strip()


def test_a_provider_without_a_model_is_refused(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("CI", raising=False)
    assert main(["run", "--provider", "openai", "--no-judge"]) == 2
    assert "model is required" in capsys.readouterr().err


def _boom(*args: object, **kwargs: object) -> None:
    raise OSError("disk full")


def test_a_failed_report_write_leaves_the_old_file(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    report = _report()
    path = write_report(report, tmp_path)
    old = path.read_text()
    changed = {**report, "judge": None}
    monkeypatch.setattr(json, "dump", _boom)
    with pytest.raises(OSError):
        write_report(changed, tmp_path)
    assert path.read_text() == old
    assert [p.name for p in tmp_path.iterdir()] == [path.name]


def test_runs_that_finish_in_the_same_second_keep_their_own_files(
    tmp_path: Path,
) -> None:
    """Parallel runs of one model often finish within a second: each keeps its
    own results file, and rewriting one run (a later judge) keeps its name."""
    first = {**_report(), "finished_at": "2026-10-21T13:33:54.120000+00:00"}
    second = {**_report(), "finished_at": "2026-10-21T13:33:54.870000+00:00"}
    a = write_report(first, tmp_path)
    b = write_report(second, tmp_path)
    assert a != b
    assert write_report({**first, "judge": None}, tmp_path) == a
    assert len(list(tmp_path.iterdir())) == 2


def test_a_failed_promotion_write_leaves_the_old_list(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    tested = tmp_path / "tested_models.json"
    old = json.dumps({"description": "d", "models": []})
    tested.write_text(old)
    results = tmp_path / "r.json"
    results.write_text(json.dumps(_report()))
    monkeypatch.setattr(json, "dump", _boom)
    assert main(["promote", str(results), "--tested-file", str(tested)]) == 1
    assert tested.read_text() == old
    assert sorted(p.name for p in tmp_path.iterdir()) == [
        "r.json",
        "tested_models.json",
    ]


def test_the_report_scrubs_and_truncates_errors() -> None:
    task = _judge_task()
    key = "sk-secret-key-abcdef123456"
    transcript = _transcript(
        task,
        error=f"AuthenticationError: bad key {key} " + "x" * 2000,
        answer=f"echo {key}",
    )
    grades = [Grade("judge", False, f"judge failed: {key}")]
    report = build_report(
        {"provider": "p", "model": "m"},
        {"provider": "p", "model": "j"},
        [(task, transcript, grades)],
        datetime.now(UTC),
        secrets=[key],
        judge_tokens=(7, 3),
    )
    record = report["tasks"][0]
    assert key not in json.dumps(report)
    assert len(record["error"]) <= 500
    assert record["grades"][0]["detail"] == "judge failed: …"
    summary = report["summary"]
    assert (summary["judge_input_tokens"], summary["judge_output_tokens"]) == (7, 3)
    assert summary["total_seconds"] == 1.0 and "wall_seconds" in summary


def test_the_report_names_the_providers_that_answered_and_what_they_billed() -> None:
    tasks = [task for task in load_tasks() if task.suite == "catalog"][:3]
    transcripts = [
        _transcript(tasks[0], providers={"DeepInfra": 3}, cost=0.002),
        _transcript(tasks[1], providers={"DeepInfra": 1, "Together": 2}, cost=0.001),
        _transcript(tasks[2]),
    ]
    report = build_report(
        {"provider": "p", "model": "m"},
        None,
        [(task, transcript, []) for task, transcript in zip(tasks, transcripts)],
        datetime.now(UTC),
    )
    records = report["tasks"]
    assert [record["providers"] for record in records] == [
        {"DeepInfra": 3},
        {"DeepInfra": 1, "Together": 2},
        {},
    ]
    assert [record["cost"] for record in records] == [0.002, 0.001, None]
    summary = report["summary"]
    assert summary["providers"] == {"DeepInfra": 4, "Together": 2}
    assert summary["cost"] == pytest.approx(0.003)
    alone = build_report(
        {"provider": "p", "model": "m"},
        None,
        [(tasks[2], transcripts[2], [])],
        datetime.now(UTC),
    )
    assert (alone["summary"]["providers"], alone["summary"]["cost"]) == ({}, None)


def test_the_report_counts_responses_without_text_or_a_call_and_the_retries() -> None:
    tasks = [task for task in load_tasks() if task.suite == "catalog"][:2]
    report = build_report(
        {"provider": "p", "model": "m"},
        None,
        [
            (tasks[0], _transcript(tasks[0], reasoning_only=2, retries=2), []),
            (tasks[1], _transcript(tasks[1]), []),
        ],
        datetime.now(UTC),
    )
    assert [(t["reasoning_only"], t["retries"]) for t in report["tasks"]] == [
        (2, 2),
        (0, 0),
    ]
    assert (report["summary"]["reasoning_only"], report["summary"]["retries"]) == (2, 2)


async def test_the_judge_counts_its_tokens_and_needs_a_real_bool() -> None:
    task = _judge_task()
    judge = ModelJudge(TestModel(custom_output_args={"passed": False, "reason": "No."}))
    verdict = await judge.judge(task, "rubric text here", _transcript(task))
    assert verdict.passed is False
    assert judge.usage.input_tokens > 0 and judge.usage.output_tokens > 0
    with pytest.raises(ValueError):
        Verdict.model_validate({"passed": "yes", "reason": "x"})
    with pytest.raises(ValueError):
        Verdict.model_validate({"passed": 1, "reason": "x"})


def test_a_grading_failure_errors_one_task_and_keeps_the_others(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("CI", raising=False)
    real_grade = cli.grade

    async def flaky(
        task: EvalTask, transcript: Transcript, backends: object
    ) -> list[Grade]:
        if task.id == "cat-01":
            raise RuntimeError("oracle unavailable")
        return await real_grade(task, transcript, backends)  # type: ignore[arg-type]

    monkeypatch.setattr(cli, "grade", flaky)
    code = main(
        [
            "run",
            "--provider",
            "test",
            "--model",
            "test",
            "--allow-test-model",
            "--task",
            "cat-01",
            "--task",
            "cat-14",
            "--no-judge",
            "--results-dir",
            str(tmp_path),
        ]
    )
    assert code == 0
    [path] = list(tmp_path.glob("*.json"))
    records = {t["id"]: t for t in json.loads(path.read_text())["tasks"]}
    assert set(records) == {"cat-01", "cat-14"}
    assert records["cat-01"]["passed"] is False
    assert "oracle unavailable" in records["cat-01"]["error"]
    assert records["cat-14"]["error"] is None
