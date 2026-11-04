"""Assistant-shaped workflows kept as regression cases (``workflow_runs.json``).

Each case is a workflow in the eval suite's workflow project
(``backends.WORKFLOW_LAYERS``): a draft written the way the assistant drafts,
with the config ``to_config`` gives for it, or a workflow an eval run
created, with the config core saved. CI runs every case on layers with that
project's ids, names and fields, so a created workflow counts as good only
once it runs there: goatlib's workflow chain tests run the cases without
routing, the end-to-end suite the ones with routing (``run``).

``python -m evals runs`` rewrites the config of every draft case (a test
fails while one differs from what ``to_config`` gives); with ``--add-from``
it first adds the workflows an eval run created.
"""

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Literal

from goatlib.tools.registry import get_tools_by_category

from assistant.workflows.draft import Draft, ProjectLayer, Region, to_config
from evals.backends import WORKFLOW_LAYERS

RUNS_FILE = Path(__file__).parent / "workflow_runs.json"
#: Tools that route on the street network or public transport: only the
#: end-to-end suite has that data.
ROUTING_TOOLS = frozenset(
    tool.name for tool in get_tools_by_category("accessibility_indicators")
)
#: The project entries a dataset step may read: the layers both runners have.
RUNNABLE_LAYERS = frozenset(layer.layer_project_id for layer in WORKFLOW_LAYERS)

RunKind = Literal["chain", "routing"]


def run_kind(config: Mapping[str, Any]) -> RunKind:
    """Where a workflow runs: "routing" when one of its steps routes."""
    tools = {
        str((node.get("data") or {}).get("processId"))
        for node in config.get("nodes", [])
        if (node.get("data") or {}).get("type") == "tool"
    }
    return "routing" if tools & ROUTING_TOOLS else "chain"


def _layers() -> dict[int, ProjectLayer]:
    return {
        layer.layer_project_id: ProjectLayer(
            layer_project_id=layer.layer_project_id,
            layer_id=layer.layer_id,
            name=layer.name,
            type=layer.layer_type,
            geometry_type=layer.geometry or None,
        )
        for layer in WORKFLOW_LAYERS
    }


def convert(case: Mapping[str, Any], titles: Mapping[str, str]) -> dict[str, Any]:
    """The config ``to_config`` gives for a draft case."""
    regions = {row["nuts_id"]: Region(**row) for row in case.get("regions", [])}
    draft = Draft.model_validate(case["draft"])
    converted = to_config(draft, layers=_layers(), regions=regions, titles=titles)
    return converted.config


def _read(path: Path) -> dict[str, Any]:
    data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return data


def _write(path: Path, data: Mapping[str, Any]) -> None:
    text = json.dumps(data, indent=2, ensure_ascii=False)
    path.write_text(text + "\n", encoding="utf-8")


def refresh(path: Path | None = None) -> int:
    """Sets each draft case's config and run to what its draft gives now;
    returns how many cases changed."""
    path = path or RUNS_FILE
    data = _read(path)
    changed = 0
    for case in data["cases"]:
        if "draft" not in case:
            continue
        config = convert(case, data["titles"])
        kind = run_kind(config)
        if case.get("config") != config or case.get("run") != kind:
            case["config"], case["run"] = config, kind
            changed += 1
    if changed:
        _write(path, data)
    return changed


def _unrunnable(config: Mapping[str, Any]) -> str | None:
    """Why the runners cannot run a workflow, or None."""
    for node in config.get("nodes", []):
        data = node.get("data") or {}
        if data.get("type") != "dataset":
            continue
        if not data.get("layerId"):
            return "has a dataset step without a layer"
        if data.get("projectLayerId") not in RUNNABLE_LAYERS:
            entry = data.get("projectLayerId")
            return f"reads project entry {entry}, which the runners do not have"
    return None


def add_from_report(
    report_path: Path, path: Path | None = None
) -> tuple[int, list[str]]:
    """Adds the workflows an eval run created (its results' ``workflows``)
    as cases; returns how many were added and why each other one was not."""
    path = path or RUNS_FILE
    data = _read(path)
    known = [case["config"] for case in data["cases"]]
    added = 0
    skipped: list[str] = []
    for task in _read(report_path).get("tasks", []):
        for workflow in task.get("workflows", []):
            name, config = workflow.get("name"), workflow.get("config")
            reason = (
                "has no config" if not isinstance(config, dict) else _unrunnable(config)
            )
            if reason is None and config in known:
                reason = "is in the set already"
            if reason is not None:
                skipped.append(f"{task.get('id')}: {name!r} {reason}")
                continue
            data["cases"].append(
                {
                    "note": f"{task.get('id')}: {name}",
                    "run": run_kind(config),
                    "config": config,
                }
            )
            known.append(config)
            added += 1
    if added:
        _write(path, data)
    return added, skipped
