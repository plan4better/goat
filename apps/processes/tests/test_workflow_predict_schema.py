"""`POST /workflows/{id}/predict-schema` reads only what the caller may read.

A layer's columns are the shape of its data, so every layer id the request
names must be readable by the caller (404 otherwise, as for any refused
request). The DuckLake read runs in a worker thread, off the event loop. A
source node id names a step of the caller's own workflow, never a path.
"""

import asyncio
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

import processes.routers.workflows as workflows_router
from processes.deps.auth import get_user_id
from processes.main import app
from processes.services import access

USER = "8f19467a-6287-4563-8905-588c3a736f39"
SOMEONE_ELSE = "1c684d0f-f831-48a8-803f-98d7f00bbd23"
LAYER = "90e3bcb2-d7ec-4abf-955d-50633ab4a101"
WORKFLOW = "7a193b81-0000-4000-8000-000000000001"


@pytest.fixture
def client() -> Iterator[TestClient]:
    app.dependency_overrides[get_user_id] = lambda: UUID(USER)
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_user_id, None)


@pytest.fixture
def reads(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, bool]]:
    """The DuckLake schema read, answered; records (layer, ran on the loop)."""
    seen: list[tuple[str, bool]] = []

    def read(layer_id: str) -> dict[str, str]:
        try:
            asyncio.get_running_loop()
            on_loop = True
        except RuntimeError:
            on_loop = False
        seen.append((layer_id, on_loop))
        return {"name": "VARCHAR", "geometry": "GEOMETRY"}

    monkeypatch.setattr(workflows_router, "_get_layer_schema_from_ducklake", read)
    return seen


@pytest.fixture
def temp_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(workflows_router, "TEMP_DATA_ROOT", tmp_path)
    return tmp_path


def _predict(client: TestClient, input_schema: dict[str, Any]) -> Any:
    return client.post(
        f"/workflows/{WORKFLOW}/predict-schema",
        json={
            "process_id": "buffer",
            "input_schemas": {"input_layer_id": input_schema},
            "params": {"distances": [100]},
        },
    )


def test_a_readable_layer_is_read_off_the_event_loop(
    client: TestClient, reads: list[tuple[str, bool]]
) -> None:
    response = _predict(client, {"layer_id": LAYER})

    assert response.status_code == 200, response.text
    assert response.json()["columns"] == {
        "name": "VARCHAR",
        "geometry": "GEOMETRY",
        "buffer_distance": "INTEGER",
    }
    assert reads == [(LAYER, False)]


def test_a_layer_the_caller_cannot_read_is_not_found(
    client: TestClient,
    reads: list[tuple[str, bool]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    asked: list[list[dict[str, str]]] = []

    async def refuse(
        user_id: Any, entries: list[dict[str, str]]
    ) -> list[dict[str, str]]:
        asked.append(entries)
        return [
            {"kind": e["kind"], "raw_id": e["id"], "action": e["action"]}
            for e in entries
        ]

    monkeypatch.setattr(access, "denied_references", refuse)

    response = _predict(client, {"layer_id": LAYER})

    assert response.status_code == 404, response.text
    assert asked == [[{"kind": "layer", "id": LAYER, "action": "read"}]]
    assert reads == []


def test_a_value_that_is_no_layer_id_reads_nothing(
    client: TestClient, reads: list[tuple[str, bool]]
) -> None:
    """An editor id it could not resolve (a project entry number): predicted
    without input columns, as before."""
    response = _predict(client, {"layer_id": "86901"})

    assert response.status_code == 200, response.text
    assert response.json()["columns"] == {"buffer_distance": "INTEGER"}
    assert reads == []


def test_an_executed_step_of_the_callers_workflow_is_read(
    client: TestClient, temp_root: Path
) -> None:
    step_dir = (
        temp_root
        / f"user_{USER.replace('-', '')}"
        / f"w_{WORKFLOW.replace('-', '')}"
        / "n_tool-1"
    )
    step_dir.mkdir(parents=True)
    (step_dir / "metadata.json").write_text(
        json.dumps({"columns": {"name": "VARCHAR"}})
    )

    response = _predict(client, {"source_node_id": "tool-1"})

    assert response.status_code == 200, response.text
    assert response.json()["columns"]["name"] == "VARCHAR"


def test_a_source_node_id_never_leaves_the_callers_workflow(
    client: TestClient, temp_root: Path
) -> None:
    """With a `n_..` directory in the caller's own workflow (a step with the
    id `..` writes one), `..` segments would reach someone else's results."""
    mine = (
        temp_root / f"user_{USER.replace('-', '')}" / f"w_{WORKFLOW.replace('-', '')}"
    )
    (mine / "n_..").mkdir(parents=True)
    theirs = temp_root / f"user_{SOMEONE_ELSE.replace('-', '')}" / "w_x" / "n_y"
    theirs.mkdir(parents=True)
    (theirs / "metadata.json").write_text(json.dumps({"columns": {"salary": "DOUBLE"}}))
    escape = f"../../../../user_{SOMEONE_ELSE.replace('-', '')}/w_x/n_y"

    response = _predict(client, {"source_node_id": escape})

    assert response.status_code == 200, response.text
    assert "salary" not in response.json()["columns"]
