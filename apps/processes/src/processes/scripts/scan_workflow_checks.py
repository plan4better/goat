"""Release gate for the workflow checks: which saved workflows would they refuse?

Read-only: Postgres is read in a read-only transaction, Windmill only with
GET requests, DuckLake through the read-only manager. Two scans:

1. Every row of `customer.workflow` through `shape_issues`. A damaged config
   can no longer be saved (core) or run (processes).
2. Every workflow with a successful `workflow_runner` job in Windmill, through
   `check_workflow` with the steps, connections and variables of its latest
   successful run. Those ran, so a refusal is a check that is too strict, or,
   after review, a real problem the run happened to survive. Every layer
   counts as readable (the run's own access check passed); fields are looked
   up in DuckLake as `POST /workflows/check` does. With `--ids-file` the
   stored configs of the listed workflows are checked instead, for a database
   whose Windmill history is elsewhere.

Run it in the processes container, or on a host with the processes settings
(`processes.config`) in the environment, pointed at the database, Windmill and
DuckLake of the copy to scan:

    set -a && . ./.env && set +a          # from the repo root
    cd apps/processes
    uv run --no-sync python -m processes.scripts.scan_workflow_checks [--json] [--ids-file FILE]

Settings it reads: POSTGRES_SERVER, POSTGRES_PORT, POSTGRES_USER,
POSTGRES_PASSWORD, POSTGRES_DB, POSTGRES_TRANSACTION_POOLER and CUSTOMER_SCHEMA
for the workflows; WINDMILL_URL, WINDMILL_WORKSPACE and WINDMILL_TOKEN (or
WINDMILL_TOKEN_FILE) for the run history; the DuckLake settings
(DUCKLAKE_POSTGRES_SERVER, DUCKLAKE_POSTGRES_PORT, DUCKLAKE_CATALOG_SCHEMA,
DUCKLAKE_DATA_DIR, DUCKLAKE_S3_*) for field lookups; and KEYCLOAK_SERVER_URL,
or AUTH=false, without which the settings do not load. WINDMILL_URL and
WINDMILL_TOKEN are read from the real environment only, not from a .env file.

Exit code 1 when a workflow is damaged or would be refused, else 0.
"""

import argparse
import asyncio
import json
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import asyncpg
from goatlib.config.postgres import asyncpg_connect_args
from goatlib.workflows.checks import Issue, shape_issues
from wmill import Windmill

from processes.config import settings
from processes.ducklake import ducklake_manager
from processes.services.workflow_checks import (
    LayerFields,
    check_workflow,
    ducklake_layer_fields,
    recorded_feature_count,
)

RUNNER_PATH = "f/goat/tools/workflow_runner"
BLOCKING_LEVELS = frozenset({"damaged", "error"})


@dataclass(frozen=True)
class WorkflowRow:
    id: str
    project_id: str
    name: str
    config: Any


@dataclass(frozen=True)
class Run:
    """What one check runs on: a workflow's steps and the run they come from."""

    workflow: WorkflowRow
    job_id: str | None
    nodes: Any
    edges: Any
    variables: Any


class RunHistory(Protocol):
    def latest_successful_run(self, workflow_id: str) -> dict[str, Any] | None: ...


class WindmillRunHistory:
    """The latest successful `workflow_runner` job of a workflow, read with GETs.

    Windmill marks a job successful when the runner returns; a run that
    returns `{"status": "failed"}` is a failed run all the same, so the result
    has to say "success" too.
    """

    def __init__(self) -> None:
        self._client = Windmill(
            base_url=settings.WINDMILL_URL,
            token=settings.WINDMILL_TOKEN,
            workspace=settings.WINDMILL_WORKSPACE,
        )
        self._workspace = settings.WINDMILL_WORKSPACE

    def latest_successful_run(self, workflow_id: str) -> dict[str, Any] | None:
        listed = self._client.get(
            f"/w/{self._workspace}/jobs/completed/list",
            params={
                "script_path_exact": RUNNER_PATH,
                "job_kinds": "script",
                "success": "true",
                "args": json.dumps({"workflow_id": workflow_id}),
                "result": json.dumps({"status": "success"}),
                "order_desc": "true",
                "per_page": 1,
            },
        ).json()
        if not listed:
            return None
        # The list leaves out a job's arguments; the job itself has them.
        job: dict[str, Any] = self._client.get(
            f"/w/{self._workspace}/jobs_u/get/{listed[0]['id']}",
            params={"no_logs": "true"},
        ).json()
        return job


async def load_workflows(ids: Sequence[str] | None) -> list[WorkflowRow]:
    """Every workflow, or the ones in `ids`, in a read-only transaction."""
    conn = await asyncpg.connect(
        host=settings.POSTGRES_SERVER,
        port=settings.POSTGRES_PORT,
        user=settings.POSTGRES_USER,
        password=settings.POSTGRES_PASSWORD,
        database=settings.POSTGRES_DB,
        **asyncpg_connect_args(
            "goat-processes-scan", settings.POSTGRES_TRANSACTION_POOLER
        ),
    )
    query = (
        "SELECT id::text AS id, project_id::text AS project_id, name, config "
        f"FROM {settings.CUSTOMER_SCHEMA}.workflow "
    )
    try:
        async with conn.transaction(readonly=True):
            if ids is None:
                rows = await conn.fetch(query + "ORDER BY project_id, id")
            else:
                rows = await conn.fetch(
                    query + "WHERE id = ANY($1::uuid[]) ORDER BY project_id, id",
                    list(ids),
                )
    finally:
        await conn.close()
    return [
        WorkflowRow(
            id=row["id"],
            project_id=row["project_id"],
            name=row["name"],
            # asyncpg returns JSONB as text.
            config=json.loads(row["config"]),
        )
        for row in rows
    ]


def damaged_workflows(rows: Sequence[WorkflowRow]) -> list[dict[str, Any]]:
    damaged = []
    for row in rows:
        issues = shape_issues(row.config)
        if issues:
            damaged.append(
                {
                    "workflow_id": row.id,
                    "project_id": row.project_id,
                    "name": row.name,
                    "codes": [issue.code for issue in issues],
                }
            )
    return damaged


def _list_or_empty(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def runs_from_history(
    rows: Sequence[WorkflowRow], history: RunHistory
) -> tuple[list[Run], int]:
    """The latest successful run of each workflow, and how many had none."""
    runs: list[Run] = []
    without_run = 0
    for row in rows:
        job = history.latest_successful_run(row.id)
        if job is None:
            without_run += 1
            continue
        args = job.get("args") or {}
        runs.append(
            Run(
                workflow=row,
                job_id=job.get("id"),
                nodes=args.get("nodes"),
                edges=args.get("edges"),
                variables=_list_or_empty(args.get("variables")),
            )
        )
    return runs, without_run


def runs_from_stored_configs(rows: Sequence[WorkflowRow]) -> list[Run]:
    runs = []
    for row in rows:
        config = row.config if isinstance(row.config, dict) else {}
        runs.append(
            Run(
                workflow=row,
                job_id=None,
                nodes=config.get("nodes"),
                edges=config.get("edges"),
                variables=_list_or_empty(config.get("variables")),
            )
        )
    return runs


async def refused_runs(
    runs: Sequence[Run], layer_fields: LayerFields
) -> list[dict[str, Any]]:
    """The runs `check_workflow` would refuse, with their blocking issues.

    A check that raises is listed too, with the error as its only issue: on
    `/execute` it would answer 500 and block the run all the same.
    """
    refused = []
    for run in runs:
        try:
            issues: list[Issue] = await check_workflow(
                run.nodes,
                run.edges,
                run.variables,
                language="en",
                unreadable_layer_ids=frozenset(),
                layer_fields=layer_fields,
                layer_feature_count=recorded_feature_count,
            )
        except Exception as exc:
            issues = [
                Issue(
                    code="check_crashed",
                    level="error",
                    message=f"{type(exc).__name__}: {exc}",
                )
            ]
        blocking = [issue for issue in issues if issue.level in BLOCKING_LEVELS]
        if blocking:
            refused.append(
                {
                    "workflow_id": run.workflow.id,
                    "project_id": run.workflow.project_id,
                    "name": run.workflow.name,
                    "job_id": run.job_id,
                    "issues": [issue.to_dict() for issue in blocking],
                }
            )
    return refused


def render_text(report: dict[str, Any]) -> str:
    lines = [f"Damaged workflows: {len(report['damaged'])}"]
    for item in report["damaged"]:
        lines.append(
            f"  {item['workflow_id']}  project {item['project_id']}  "
            f"\"{item['name']}\": {', '.join(item['codes'])}"
        )
    lines.append(
        f"Checked: {report['checked']} ({report['source']}); "
        f"without a successful run: {report['without_run']}"
    )
    lines.append(f"Would be refused: {len(report['refused'])}")
    for item in report["refused"]:
        run = f"  run {item['job_id']}" if item["job_id"] else ""
        lines.append(
            f"  {item['workflow_id']}  project {item['project_id']}  "
            f"\"{item['name']}\"{run}"
        )
        for issue in item["issues"]:
            where = ",".join(issue["node_ids"]) or "workflow"
            field = f" {issue['field']}" if issue["field"] else ""
            lines.append(f"    {issue['code']} [{where}]{field}: {issue['message']}")
    return "\n".join(lines)


def _read_ids(path: Path) -> list[str]:
    return [
        line.strip()
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]


async def scan(
    ids_file: Path | None,
    history: RunHistory | None,
    layer_fields: LayerFields,
) -> dict[str, Any]:
    ids = _read_ids(ids_file) if ids_file else None
    rows = await load_workflows(ids)
    if ids is not None:
        runs = runs_from_stored_configs(rows)
        without_run = 0
        source = "stored configs from --ids-file"
    else:
        assert history is not None
        runs, without_run = await asyncio.to_thread(runs_from_history, rows, history)
        source = "latest successful run"
    return {
        "damaged": damaged_workflows(rows),
        "checked": len(runs),
        "without_run": without_run,
        "source": source,
        "refused": await refused_runs(runs, layer_fields),
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m processes.scripts.scan_workflow_checks",
        description="List saved workflows the workflow checks would refuse.",
    )
    parser.add_argument("--json", action="store_true", help="print JSON")
    parser.add_argument(
        "--ids-file",
        type=Path,
        help="check the stored configs of these workflow ids (one per line) "
        "instead of the Windmill run history",
    )
    args = parser.parse_args(argv)

    ducklake_manager.init(settings)
    try:
        history = None if args.ids_file else WindmillRunHistory()
        report = asyncio.run(scan(args.ids_file, history, ducklake_layer_fields))
    finally:
        ducklake_manager.close()

    print(json.dumps(report, indent=2) if args.json else render_text(report))
    return 1 if report["damaged"] or report["refused"] else 0


if __name__ == "__main__":
    sys.exit(main())
