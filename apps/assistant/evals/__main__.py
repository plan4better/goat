"""``python -m evals`` (from apps/assistant): run the eval set against a model,
promote a passing model into the tested-models list, and keep the regression
workflows (``runs``, workflow_runs.json).

A run spends provider tokens, so it never runs in CI (it refuses when CI is
set) and always names the model it grades: GOAT AI as ASSISTANT_DEFAULT_*
configure it, or --provider/--model.
"""

import argparse
import asyncio
import os
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import get_args

from dotenv import load_dotenv

from assistant.config import AssistantSettings
from assistant.llm.endpoints import EndpointPolicy
from assistant.llm.failures import secrets_of
from assistant.llm.providers import OpenModels, Target, default_target, open_models
from assistant.llm.types import PROVIDER_TYPES
from evals import runs
from evals.backends import Backends, write_eval_catalog
from evals.graders import Grade, grade
from evals.harness import Transcript, run_task
from evals.judge import ModelJudge, apply_judge
from evals.report import RESULTS_DIR, TESTED_FILE, build_report, promote, write_report
from evals.tasks import EvalTask, Suite, load_tasks

ROOT = Path(__file__).resolve().parents[3]
EVAL_KEY_ENV = "ASSISTANT_EVAL_API_KEY"
JUDGE_KEY_ENV = "ASSISTANT_EVAL_JUDGE_API_KEY"
#: Providers that sign with the SDK's credential chain or take no key.
NO_API_KEY: frozenset[str] = frozenset({"bedrock", "vertex", "test"})


class CliError(ValueError):
    """A command line the CLI refuses; the text is for the person running it."""


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m evals", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list", help="list the tasks")
    run = commands.add_parser("run", help="run tasks against a model")
    run.add_argument("--suite", choices=list(get_args(Suite)))
    run.add_argument(
        "--task", action="append", default=[], help="a task id; repeatable"
    )
    run.add_argument(
        "--provider",
        choices=[*PROVIDER_TYPES, "test"],
        help="provider type; default: ASSISTANT_DEFAULT_PROVIDER",
    )
    run.add_argument("--model")
    run.add_argument("--base-url")
    run.add_argument("--region")
    run.add_argument(
        "--api-key-env",
        help=f"variable holding the model's API key (default {EVAL_KEY_ENV}); required for any "
        "model other than GOAT AI's, whose key ASSISTANT_DEFAULT_API_KEY is never sent elsewhere",
    )
    run.add_argument(
        "--judge-provider",
        choices=[*PROVIDER_TYPES, "test"],
        help="default: ASSISTANT_DEFAULT_PROVIDER",
    )
    run.add_argument("--judge-model")
    run.add_argument("--judge-base-url")
    run.add_argument("--judge-region")
    run.add_argument(
        "--judge-api-key-env",
        help=f"variable holding the judge's API key (default {JUDGE_KEY_ENV})",
    )
    run.add_argument(
        "--no-judge", action="store_true", help="leave free-text checks undecided"
    )
    run.add_argument("--concurrency", type=int, default=4)
    run.add_argument("--results-dir", type=Path, default=RESULTS_DIR)
    run.add_argument("--allow-test-model", action="store_true", help=argparse.SUPPRESS)
    prom = commands.add_parser(
        "promote", help="add a passing model to the tested-models list"
    )
    prom.add_argument("results", type=Path)
    prom.add_argument(
        "--tested-file", type=Path, default=TESTED_FILE, help=argparse.SUPPRESS
    )
    runs_command = commands.add_parser(
        "runs",
        help="refresh the configs of the regression workflows (workflow_runs.json)",
    )
    runs_command.add_argument(
        "--add-from",
        type=Path,
        metavar="RESULTS",
        help="first add the workflows this eval run's results file records",
    )
    return parser


def _target(
    settings: AssistantSettings,
    provider: str | None,
    model: str | None,
    base_url: str | None,
    region: str | None,
    key_env: str,
) -> Target | None:
    """The model to grade (or to judge): named on the command line, else GOAT AI.

    GOAT AI's key (ASSISTANT_DEFAULT_API_KEY) is used only for GOAT AI's own
    provider and endpoint; any other model needs its own key in ``key_env``,
    so the instance key never travels to another endpoint."""
    if provider is None:
        return default_target(settings)
    if not model:
        raise CliError(f"a model is required with --provider {provider}")
    default_url = settings.default_base_url or None
    default_region = settings.default_region or None
    same_endpoint = (
        provider == settings.default_provider
        and base_url in (None, default_url)
        and region in (None, default_region)
    )
    key = os.environ.get(key_env, "")
    if same_endpoint:
        key = key or settings.default_api_key.get_secret_value()
        base_url, region = base_url or default_url, region or default_region
    elif not key and provider not in NO_API_KEY:
        raise CliError(
            f"{provider} is not GOAT AI's provider and endpoint, so its API key must be in "
            f"${key_env}; ASSISTANT_DEFAULT_API_KEY is never used for another endpoint"
        )
    return Target(
        connection_id=None,
        provider=provider,
        model=model,
        base_url=base_url,
        region=region,
        credentials={"api_key": key} if key else {},
    )


def _ignored_flags(args: argparse.Namespace) -> str | None:
    """A flag that would be silently ignored is an error."""
    if args.provider is None:
        named = [
            flag
            for flag, value in (
                ("--model", args.model),
                ("--base-url", args.base_url),
                ("--region", args.region),
                ("--api-key-env", args.api_key_env),
            )
            if value
        ]
        if named:
            return f"{', '.join(named)} need --provider; without it GOAT AI is graded as configured"
    judge_flags = [
        flag
        for flag, value in (
            ("--judge-model", args.judge_model),
            ("--judge-base-url", args.judge_base_url),
            ("--judge-region", args.judge_region),
            ("--judge-api-key-env", args.judge_api_key_env),
        )
        if value
    ]
    if args.judge_provider is None and judge_flags:
        return f"{', '.join(judge_flags)} need --judge-provider"
    if args.no_judge and (judge_flags or args.judge_provider):
        return "--no-judge cannot be combined with the --judge-* flags"
    return None


def _in_ci() -> bool:
    return os.environ.get("CI", "").strip().lower() not in ("", "0", "false")


async def _run(
    args: argparse.Namespace,
    settings: AssistantSettings,
    target: Target,
    judge_target: Target | None,
) -> int:
    tasks: list[EvalTask] = load_tasks(args.suite)
    if args.task:
        unknown = sorted(set(args.task) - {task.id for task in tasks})
        if unknown:
            print(f"Unknown task ids: {', '.join(unknown)}", file=sys.stderr)
            return 2
        tasks = [task for task in tasks if task.id in set(args.task)]
    policy = EndpointPolicy.from_settings(settings)
    opened: list[OpenModels] = [open_models(target, policy)]
    judge = None
    started = datetime.now(UTC)
    try:
        if judge_target is not None:
            opened.append(open_models(judge_target, policy))
            judge = ModelJudge(opened[-1].main)
        with tempfile.TemporaryDirectory(prefix="goat-eval-catalog-") as directory:
            write_eval_catalog(Path(directory))
            backends = Backends(Path(directory))
            try:
                gate = asyncio.Semaphore(max(args.concurrency, 1))

                async def one(
                    task: EvalTask,
                ) -> tuple[EvalTask, Transcript, list[Grade]]:
                    async with gate:
                        transcript: Transcript | None = None
                        try:
                            transcript = await run_task(
                                task, opened[0].main, backends, settings
                            )
                            grades = await apply_judge(
                                task,
                                transcript,
                                await grade(task, transcript, backends),
                                judge,
                            )
                        except Exception as exc:
                            # One task that cannot be graded is an errored
                            # task of the report, not the end of the run.
                            reason = f"{type(exc).__name__}: {exc}"
                            transcript = transcript or Transcript(
                                task.id, "", [], [], {}, reason, 0, 0, 0.0, None
                            )
                            transcript.error = transcript.error or reason
                            grades = [
                                Grade(check.kind, False, f"errored: {reason}")
                                for check in task.checks
                            ]
                        mark = (
                            "PASS" if all(g.passed is True for g in grades) else "FAIL"
                        )
                        print(
                            f"{mark}  {task.id}  {transcript.seconds:6.1f}s  {task.prompt[:60]}"
                        )
                        return task, transcript, grades

                results = await asyncio.gather(*(one(task) for task in tasks))
            finally:
                backends.close()
    finally:
        for models in opened:
            await models.aclose()
    report = build_report(
        {"provider": target.provider, "model": target.model},
        None
        if judge_target is None
        else {"provider": judge_target.provider, "model": judge_target.model},
        list(results),
        started,
        secrets=[
            *secrets_of(target),
            *(secrets_of(judge_target) if judge_target else []),
        ],
        judge_tokens=(
            (judge.usage.input_tokens, judge.usage.output_tokens) if judge else (0, 0)
        ),
    )
    path = write_report(report, args.results_dir)
    summary = report["summary"]
    print(
        f"\n{summary['passed']}/{summary['tasks']} passed (score {summary['score']:.2f}), "
        f"critical failed: {summary['critical_failed'] or 'none'}, undecided: {summary['undecided']}"
    )
    print(f"results: {path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "list":
        for task in load_tasks():
            print(
                f"{task.id}  {task.suite:8}  {'critical ' if task.critical else ''}{task.prompt}"
            )
        return 0
    if args.command == "promote":
        try:
            entry = promote(args.results, args.tested_file)
        except (ValueError, OSError) as exc:
            print(f"not promoted: {exc}", file=sys.stderr)
            return 1
        print(f"added {entry['provider']} / {entry['model']} to {args.tested_file}")
        return 0
    if args.command == "runs":
        if args.add_from is not None:
            added, skipped = runs.add_from_report(args.add_from)
            for reason in skipped:
                print(f"not added: {reason}", file=sys.stderr)
            print(f"added {added} workflow(s) to {runs.RUNS_FILE}")
        print(f"refreshed {runs.refresh()} draft config(s) in {runs.RUNS_FILE}")
        return 0
    if _in_ci():
        print(
            "Evals spend provider tokens and run by hand, never in CI.", file=sys.stderr
        )
        return 2
    problem = _ignored_flags(args)
    if problem is not None:
        print(problem, file=sys.stderr)
        return 2
    load_dotenv(ROOT / ".env")
    settings = AssistantSettings()
    try:
        target = _target(
            settings,
            args.provider,
            args.model,
            args.base_url,
            args.region,
            args.api_key_env or EVAL_KEY_ENV,
        )
        if target is None:
            print(
                "No model: set ASSISTANT_DEFAULT_PROVIDER and _MODEL, or pass --provider and --model.",
                file=sys.stderr,
            )
            return 2
        if target.provider == "test" and not args.allow_test_model:
            print(
                "The test provider grades nothing; name a real model.", file=sys.stderr
            )
            return 2
        judge_target = None
        if not args.no_judge:
            judge_target = _target(
                settings,
                args.judge_provider,
                args.judge_model,
                args.judge_base_url,
                args.judge_region,
                args.judge_api_key_env or JUDGE_KEY_ENV,
            )
            if judge_target is None:
                print(
                    "No judge model: pass --judge-provider/--judge-model or --no-judge.",
                    file=sys.stderr,
                )
                return 2
            if judge_target.provider == "test" and not args.allow_test_model:
                print(
                    "The test provider cannot judge; name a real model.",
                    file=sys.stderr,
                )
                return 2
    except CliError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    return asyncio.run(_run(args, settings, target, judge_target))


if __name__ == "__main__":
    sys.exit(main())
