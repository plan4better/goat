"""Core refuses to save a workflow config that cannot be read as a workflow.

Only the shape is checked (`goatlib.workflows.checks.shape_issues`): an
incomplete workflow, such as a tool step with no tool chosen and nothing
connected, is saved as it is. A damaged config already stored is still
returned, so the editor can show what is broken.
"""

import copy
from typing import Any
from uuid import UUID

import pytest
from core.core.config import settings
from core.db.models.workflow import Workflow
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from tests.authz.test_template_api import _create_project, _create_workflow

API = settings.API_V2_STR


def _valid_config() -> dict[str, Any]:
    return {
        "nodes": [
            {
                "id": "dataset-1",
                "type": "dataset",
                "position": {"x": 0, "y": 0},
                "data": {"type": "dataset", "label": "Input Layer"},
            },
            {
                "id": "tool-1",
                "type": "tool",
                "position": {"x": 300, "y": 0},
                "data": {"type": "tool", "label": "Buffer", "config": {}},
            },
        ],
        "edges": [
            {
                "id": "edge-1",
                "source": "dataset-1",
                "target": "tool-1",
                "targetHandle": "input_layer_id",
            }
        ],
        "viewport": {"x": 0, "y": 0, "zoom": 1},
        "variables": [],
    }


def _damaged_config() -> dict[str, Any]:
    config = _valid_config()
    config["nodes"].append(copy.deepcopy(config["nodes"][0]))
    config["edges"].append({"id": "edge-2", "source": "tool-1"})
    return config


def _assert_damaged(response: Any, codes: list[str]) -> None:
    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    assert detail["message"] == "The workflow is damaged."
    assert [issue["code"] for issue in detail["issues"]] == codes
    assert all(issue["level"] == "damaged" for issue in detail["issues"])


async def _read(client: AsyncClient, project_id: str, workflow_id: str) -> Any:
    response = await client.get(f"{API}/project/{project_id}/workflow/{workflow_id}")
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.asyncio
async def test_a_damaged_create_is_refused_with_its_issues(
    client: AsyncClient, fixture_get_home_folder: dict[str, object]
) -> None:
    project_id = await _create_project(client, str(fixture_get_home_folder["id"]))

    response = await client.post(
        f"{API}/project/{project_id}/workflow",
        json={"name": "broken", "config": _damaged_config()},
    )

    _assert_damaged(response, ["node_duplicate_id", "edge_without_ends"])
    issues = response.json()["detail"]["issues"]
    assert issues[0]["node_ids"] == ["dataset-1"]
    assert issues[0]["params"] == {"id": "dataset-1"}
    assert issues[1]["params"] == {"index": 1}
    listed = await client.get(f"{API}/project/{project_id}/workflow")
    assert listed.json() == []


@pytest.mark.asyncio
async def test_a_create_without_a_list_of_connections_is_refused(
    client: AsyncClient, fixture_get_home_folder: dict[str, object]
) -> None:
    project_id = await _create_project(client, str(fixture_get_home_folder["id"]))

    response = await client.post(
        f"{API}/project/{project_id}/workflow",
        json={"name": "broken", "config": {"nodes": []}},
    )

    _assert_damaged(response, ["edges_not_list"])


@pytest.mark.asyncio
async def test_a_damaged_update_is_refused_and_the_stored_config_kept(
    client: AsyncClient, fixture_get_home_folder: dict[str, object]
) -> None:
    project_id = await _create_project(client, str(fixture_get_home_folder["id"]))
    workflow_id = await _create_workflow(client, project_id, _valid_config())

    response = await client.put(
        f"{API}/project/{project_id}/workflow/{workflow_id}",
        json={"config": {"nodes": [{"type": "tool"}], "edges": []}},
    )

    _assert_damaged(response, ["node_without_id"])
    assert (await _read(client, project_id, workflow_id))["config"] == _valid_config()


@pytest.mark.asyncio
async def test_an_update_with_a_null_config_is_refused(
    client: AsyncClient, fixture_get_home_folder: dict[str, object]
) -> None:
    project_id = await _create_project(client, str(fixture_get_home_folder["id"]))
    workflow_id = await _create_workflow(client, project_id, _valid_config())

    response = await client.put(
        f"{API}/project/{project_id}/workflow/{workflow_id}",
        json={"config": None},
    )

    _assert_damaged(response, ["config_not_object"])
    assert (await _read(client, project_id, workflow_id))["config"] == _valid_config()


@pytest.mark.asyncio
async def test_valid_and_incomplete_workflows_are_saved(
    client: AsyncClient, fixture_get_home_folder: dict[str, object]
) -> None:
    project_id = await _create_project(client, str(fixture_get_home_folder["id"]))
    workflow_id = await _create_workflow(client, project_id, _valid_config())

    # A tool step with no tool chosen and nothing connected: incomplete, and
    # still saved, because workflows are built step by step.
    incomplete = _valid_config()
    incomplete["nodes"].append(
        {
            "id": "tool-2",
            "type": "tool",
            "position": {"x": 600, "y": 0},
            "data": {"type": "tool", "label": "New step"},
        }
    )
    response = await client.put(
        f"{API}/project/{project_id}/workflow/{workflow_id}",
        json={"config": incomplete},
    )

    assert response.status_code == 200, response.text
    assert (await _read(client, project_id, workflow_id))["config"] == incomplete


@pytest.mark.asyncio
async def test_a_stored_damaged_workflow_still_loads_and_can_be_renamed(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_get_home_folder: dict[str, object],
) -> None:
    project_id = await _create_project(client, str(fixture_get_home_folder["id"]))
    damaged = _damaged_config()
    stored = Workflow(project_id=UUID(project_id), name="old", config=damaged)
    db_session.add(stored)
    await db_session.commit()
    workflow_id = str(stored.id)

    assert (await _read(client, project_id, workflow_id))["config"] == damaged
    listed = await client.get(f"{API}/project/{project_id}/workflow")
    assert listed.status_code == 200, listed.text
    assert [w["config"] for w in listed.json()] == [damaged]

    # A rename sends no config, so there is nothing to check.
    renamed = await client.put(
        f"{API}/project/{project_id}/workflow/{workflow_id}",
        json={"name": "renamed"},
    )
    assert renamed.status_code == 200, renamed.text
    body = await _read(client, project_id, workflow_id)
    assert body["name"] == "renamed"
    assert body["config"] == damaged
