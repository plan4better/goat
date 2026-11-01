"""The workflow routes that read a step's temporary results stay in the
caller's own folder, `user_<id>/w_<workflow>/n_<step>/`.

The workflow and step ids of the URL become folder names there: a workflow id
must be a UUID and a step id only letters, digits, `-` and `_`, as for a run,
and a path that would still resolve outside the caller's folder is refused.
"""

from collections.abc import Iterator
from pathlib import Path
from uuid import UUID

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import processes.routers.workflows as workflows_router
from processes.deps.auth import get_user_id
from processes.main import app

USER = "8f19467a-6287-4563-8905-588c3a736f39"
SOMEONE_ELSE = "1c684d0f-f831-48a8-803f-98d7f00bbd23"
WORKFLOW = "7a193b81-0000-4000-8000-000000000001"


@pytest.fixture
def client() -> Iterator[TestClient]:
    app.dependency_overrides[get_user_id] = lambda: UUID(USER)
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_user_id, None)


@pytest.fixture
def temp_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(workflows_router, "TEMP_DATA_ROOT", tmp_path)
    return tmp_path


def test_a_workflow_id_that_is_no_uuid_is_refused(
    client: TestClient, temp_root: Path
) -> None:
    # `%2E%2E` reaches the route as `..`.
    for response in (
        client.get("/workflows/%2E%2E/metadata"),
        client.get("/workflows/%2E%2E/nodes/tool-1/metadata"),
        client.post(
            "/workflows/%2E%2E/predict-schema",
            json={"process_id": "buffer", "input_schemas": {}},
        ),
    ):
        assert response.status_code == 422, response.request.url


def test_a_step_id_with_other_characters_is_refused(
    client: TestClient, temp_root: Path
) -> None:
    response = client.get(f"/workflows/{WORKFLOW}/nodes/%2E%2E/metadata")

    assert response.status_code == 422, response.text


def test_the_callers_own_step_is_read(client: TestClient, temp_root: Path) -> None:
    step = (
        temp_root
        / f"user_{USER.replace('-', '')}"
        / f"w_{WORKFLOW.replace('-', '')}"
        / "n_tool-1"
    )
    step.mkdir(parents=True)
    (step / "metadata.json").write_text('{"columns": {"name": "VARCHAR"}}')

    one = client.get(f"/workflows/{WORKFLOW}/nodes/tool-1/metadata")
    every = client.get(f"/workflows/{WORKFLOW}/metadata")

    assert one.status_code == 200, one.text
    assert one.json()["columns"] == {"name": "VARCHAR"}
    assert every.status_code == 200, every.text
    assert every.json()["nodes"]["tool-1"]["columns"] == {"name": "VARCHAR"}


@pytest.mark.parametrize(
    "path",
    [
        lambda: workflows_router._get_workflow_temp_path(
            USER, f"x/../../user_{SOMEONE_ELSE.replace('-', '')}"
        ),
        lambda: workflows_router._get_temp_node_path(
            USER, WORKFLOW, f"x/../../../user_{SOMEONE_ELSE.replace('-', '')}/w_x/n_y"
        ),
    ],
)
def test_a_temp_path_never_resolves_outside_the_callers_folder(
    path: object, temp_root: Path
) -> None:
    """Whatever the routes let through, a path that resolves into another
    user's folder is refused."""
    with pytest.raises(HTTPException) as refused:
        path()  # type: ignore[operator]

    assert refused.value.status_code == 404
