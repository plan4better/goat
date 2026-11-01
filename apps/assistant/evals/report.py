"""Eval results (one JSON file per run) and promotion into the tested-models
list (spec §4.3): the admin page labels every other model "untested"."""

import contextlib
import json
import os
import statistics
import tempfile
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from assistant.llm.failures import redact
from evals.graders import Grade, task_passed
from evals.harness import Transcript
from evals.tasks import EVAL_SET_VERSION, EvalTask, load_tasks

ASSISTANT = Path(__file__).resolve().parents[1]
TESTED_FILE = ASSISTANT / "src" / "assistant" / "llm" / "tested_models.json"
RESULTS_DIR = ASSISTANT / "evals" / "results"

#: The bar for the tested-models list: overall, per suite, every critical task, every judge check decided.
PASS_SCORE = 0.85
SUITE_PASS_SCORE = 0.8
#: Characters of each answer kept in the report.
ANSWER_CHARS = 2000
#: Characters of an error or grade detail kept in the report.
DETAIL_CHARS = 500


def _added(counts: Iterable[dict[str, int]]) -> dict[str, int]:
    total: dict[str, int] = {}
    for count in counts:
        for name, calls in count.items():
            total[name] = total.get(name, 0) + calls
    return total


def _cost(costs: list[float | None]) -> float | None:
    """The run's billed cost; None when no task's provider reported one."""
    known = [cost for cost in costs if cost is not None]
    return round(sum(known), 6) if known else None


def _median(values: list[float]) -> float | None:
    return statistics.median(values) if values else None


def scrub(
    text: str | None, secrets: Iterable[str], limit: int = DETAIL_CHARS
) -> str | None:
    """Exception texts can echo request headers: mask the keys in use, then truncate."""
    if text is None:
        return None
    return str(redact(text, secrets))[:limit]


def build_report(
    model: dict[str, str],
    judge: dict[str, str] | None,
    results: list[tuple[EvalTask, Transcript, list[Grade]]],
    started_at: datetime,
    *,
    secrets: Iterable[str] = (),
    judge_tokens: tuple[int, int] = (0, 0),
) -> dict[str, Any]:
    known = list(secrets)
    tasks: list[dict[str, Any]] = []
    by_suite: dict[str, dict[str, int]] = {}
    for task, transcript, grades in results:
        passed = task_passed(grades)
        suite = by_suite.setdefault(task.suite, {"tasks": 0, "passed": 0})
        suite["tasks"] += 1
        suite["passed"] += int(passed)
        first_text = transcript.first_text_seconds
        tasks.append(
            {
                "id": task.id,
                "suite": task.suite,
                "critical": task.critical,
                "passed": passed,
                "seconds": round(transcript.seconds, 2),
                "first_text_seconds": None
                if first_text is None
                else round(first_text, 2),
                "input_tokens": transcript.input_tokens,
                "output_tokens": transcript.output_tokens,
                "cache_read_tokens": transcript.cache_read_tokens,
                # Which providers answered (a gateway routes one model to many)
                # and what they billed, where the gateway reports it.
                "providers": transcript.providers,
                "cost": None if transcript.cost is None else round(transcript.cost, 6),
                # Model calls that gave nothing to show or run, and the retries.
                "reasoning_only": transcript.reasoning_only,
                "retries": transcript.retries,
                "error": scrub(transcript.error, known),
                "tools": [call.name for call in transcript.tool_calls],
                # The workflows core saved in the task, as `python -m evals
                # runs --add-from` reads them.
                "workflows": [
                    {"name": row.get("name"), "config": row.get("config")}
                    for row in transcript.saved
                ],
                "grades": [
                    {
                        "check": g.check,
                        "passed": g.passed,
                        "detail": scrub(g.detail, known),
                    }
                    for g in grades
                ],
                "answer": scrub(transcript.answer, known, ANSWER_CHARS),
            }
        )
    count = len(tasks)
    passed_count = sum(int(t["passed"]) for t in tasks)
    finished = datetime.now(UTC)
    return {
        "eval_set_version": EVAL_SET_VERSION,
        "started_at": started_at.isoformat(),
        "finished_at": finished.isoformat(),
        "model": model,
        "judge": judge,
        "summary": {
            "tasks": count,
            "passed": passed_count,
            "score": passed_count / count if count else 0.0,
            "critical_failed": [
                t["id"] for t in tasks if t["critical"] and not t["passed"]
            ],
            "undecided": sum(
                1 for t in tasks for g in t["grades"] if g["passed"] is None
            ),
            "by_suite": by_suite,
            "median_seconds": _median([t["seconds"] for t in tasks]),
            "median_first_text_seconds": _median(
                [
                    t["first_text_seconds"]
                    for t in tasks
                    if t["first_text_seconds"] is not None
                ]
            ),
            # Task run times added up (tasks run concurrently) and the wall clock.
            "total_seconds": round(sum(t["seconds"] for t in tasks), 2),
            "wall_seconds": round((finished - started_at).total_seconds(), 2),
            "input_tokens": sum(t["input_tokens"] for t in tasks),
            "output_tokens": sum(t["output_tokens"] for t in tasks),
            "cache_read_tokens": sum(t.get("cache_read_tokens", 0) for t in tasks),
            "providers": _added(t.get("providers") or {} for t in tasks),
            "cost": _cost([t.get("cost") for t in tasks]),
            "reasoning_only": sum(t.get("reasoning_only", 0) for t in tasks),
            "retries": sum(t.get("retries", 0) for t in tasks),
            "judge_input_tokens": judge_tokens[0],
            "judge_output_tokens": judge_tokens[1],
        },
        "tasks": tasks,
    }


def _write_json(path: Path, data: Any) -> None:
    """Write to a temp file in the same directory, then replace: a failure
    leaves the old file (or none) rather than a half-written one."""
    handle = tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
        delete=False,
    )
    try:
        with handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(handle.name, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(handle.name)
        raise


def write_report(report: dict[str, Any], directory: Path = RESULTS_DIR) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    # To the microsecond: runs of one model started together finish within a
    # second of each other, and a rewrite of a run keeps its finished_at.
    stamp = datetime.fromisoformat(report["finished_at"]).strftime("%Y%m%d-%H%M%S-%f")
    name = f"{report['model']['provider']}-{report['model']['model']}"
    slug = "".join(c if c.isalnum() or c in "-." else "-" for c in name)
    path = directory / f"{stamp}-{slug}.json"
    _write_json(path, report)
    return path


def _recomputed(report: dict[str, Any]) -> dict[str, Any]:
    """The numbers promotion goes by, from the per-task records and not from the
    summary, so a hand-edited summary cannot lift a run over the bar. Raises
    ValueError for a report that is incomplete or malformed."""
    expected = {task.id: task for task in load_tasks()}
    records = report.get("tasks")
    if not isinstance(records, list):
        raise ValueError("the results have no task records")
    seen: dict[str, dict[str, Any]] = {}
    try:
        for record in records:
            task_id = record["id"]
            if task_id in seen:
                raise ValueError(f"task {task_id} appears twice")
            seen[task_id] = record
        missing = sorted(set(expected) - set(seen))
        if missing:
            raise ValueError(
                f"results cover only part of the set; missing {', '.join(missing)}"
            )
        unknown = sorted(set(seen) - set(expected))
        if unknown:
            raise ValueError(
                f"results name tasks outside the set: {', '.join(unknown)}"
            )
        by_suite: dict[str, dict[str, int]] = {}
        critical_failed: list[str] = []
        undecided = 0
        passed = 0
        for task_id, task in expected.items():
            grades = seen[task_id]["grades"]
            if len(grades) != len(task.checks):
                raise ValueError(
                    f"task {task_id} has {len(grades)} of {len(task.checks)} grades"
                )
            states = [grade["passed"] for grade in grades]
            if any(state not in (True, False, None) for state in states):
                raise ValueError(f"task {task_id} has a malformed grade")
            ok = all(state is True for state in states)
            undecided += sum(state is None for state in states)
            passed += int(ok)
            if task.critical and not ok:
                critical_failed.append(task_id)
            suite = by_suite.setdefault(task.suite, {"tasks": 0, "passed": 0})
            suite["tasks"] += 1
            suite["passed"] += int(ok)
    except (KeyError, TypeError, AttributeError) as exc:
        raise ValueError(
            f"the results are malformed ({type(exc).__name__}: {exc})"
        ) from None
    return {
        "tasks": len(expected),
        "passed": passed,
        "score": passed / len(expected),
        "critical_failed": critical_failed,
        "undecided": undecided,
        "by_suite": by_suite,
    }


def promotion_refusal(report: dict[str, Any]) -> str | None:
    """Why this run may not enter the tested-models list, or None."""
    if not isinstance(report, dict):
        return "the results file is not a report"
    model = report.get("model")
    judge = report.get("judge")
    if report.get("eval_set_version") != EVAL_SET_VERSION:
        return f"results are for eval set version {report.get('eval_set_version')}, the set is at {EVAL_SET_VERSION}"
    if (
        not isinstance(model, dict)
        or not model.get("provider")
        or not model.get("model")
    ):
        return "the results do not name a provider and a model"
    if model["provider"] == "test":
        return "the test provider is never a tested model"
    if not isinstance(judge, dict) or not judge.get("provider"):
        return "the run had no judge; run with a judge"
    if judge["provider"] == "test":
        return "the test provider cannot judge a tested model"
    if (judge["provider"], judge.get("model")) == (model["provider"], model["model"]):
        return (
            "the model under test judged itself; run again with another model as "
            "judge (--judge-provider and --judge-model)"
        )
    try:
        summary = _recomputed(report)
    except ValueError as exc:
        return str(exc)
    if summary["undecided"]:
        return f"{summary['undecided']} judge checks are undecided; run with a judge"
    if summary["critical_failed"]:
        return f"critical tasks failed: {', '.join(summary['critical_failed'])}"
    if summary["score"] < PASS_SCORE:
        return f"score {summary['score']:.2f} is below {PASS_SCORE}"
    for name, suite in summary["by_suite"].items():
        if suite["passed"] / suite["tasks"] < SUITE_PASS_SCORE:
            return f"the {name} suite passed {suite['passed']} of {suite['tasks']}, below {SUITE_PASS_SCORE}"
    return None


def promote(report_path: Path, tested_file: Path = TESTED_FILE) -> dict[str, Any]:
    """Add (or replace) the model of a passing run in the tested-models list;
    raises ValueError with the reason when the run does not pass."""
    report = json.loads(report_path.read_text(encoding="utf-8"))
    refusal = promotion_refusal(report)
    if refusal is not None:
        raise ValueError(refusal)
    entry = {
        "provider": report["model"]["provider"],
        "model": report["model"]["model"],
        "judge": {
            "provider": report["judge"]["provider"],
            "model": report["judge"].get("model"),
        },
        "eval_set_version": report["eval_set_version"],
        "score": round(_recomputed(report)["score"], 3),
        "date": str(report["finished_at"])[:10],
        "results": report_path.name,
    }
    data = json.loads(tested_file.read_text(encoding="utf-8"))
    models = [
        m
        for m in data["models"]
        if (m["provider"], m["model"]) != (entry["provider"], entry["model"])
    ]
    models.append(entry)
    data["models"] = sorted(models, key=lambda m: (m["provider"], m["model"]))
    _write_json(tested_file, data)
    return entry
