"""A workflow template remembers how its outputs were styled.

The author runs the workflow, styles the exported layer in the project, and
saves the workflow as a template. Each export node of the template then
carries that style (`outputStyle`), so whoever uses the template gets the
same look on the first run (the runner applies it when the export creates a
new layer). An export that never ran carries no style, and a workflow
without one is frozen exactly as before.
"""

import json
from collections.abc import Awaitable, Callable
from typing import Any
from uuid import UUID

import pytest
from core.core.config import settings
from core.db.models.folder import Folder
from core.db.models.user import User
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.authz.test_template_api import (
    _create_project,
    _create_workflow,
    _dataset_workflow_config,
)

S = settings.SCHEMA
EXPORT_NODE = "export-0640d526-f9ad-4d6d-9645-6a7a1c990162"
STYLE = {
    "version": 1,
    "kind": "vector",
    "symbol": {"fill": {"color": "#ff0000", "opacity": 0.6}, "outline": {"width": 2}},
}


def _with_export(config: dict[str, Any]) -> dict[str, Any]:
    config["nodes"].append(
        {
            "id": EXPORT_NODE,
            "type": "export",
            "position": {"x": 400, "y": 0},
            "data": {
                "type": "export",
                "label": "Export Dataset",
                "datasetName": "Buffers",
            },
        }
    )
    return config


async def _template(
    client: AsyncClient, home: str, project_id: str, workflow_id: str, layer_id: UUID
) -> dict[str, Any]:
    created = await client.post(
        f"{settings.API_V2_STR}/template",
        json={
            "name": "Styled workflow",
            "folder_id": home,
            "source": {
                "kind": "workflow",
                "project_id": project_id,
                "workflow_id": workflow_id,
            },
            "inputs": [
                {
                    "key": "node:dataset-1",
                    "label": "Input Layer",
                    "mode": "ship",
                    "layer_id": str(layer_id),
                    "layer_type": "feature",
                    "geometry_type": "polygon",
                }
            ],
        },
    )
    assert created.status_code == 201, created.text
    return created.json()


async def _template_config(db: AsyncSession, template_id: str) -> dict[str, Any]:
    config = (
        await db.execute(
            text(f"SELECT config FROM {S}.template WHERE id = :t"), {"t": template_id}
        )
    ).scalar_one()
    return config if isinstance(config, dict) else json.loads(config)


def _export_data(config: dict[str, Any]) -> dict[str, Any]:
    return next(n for n in config["nodes"] if n["id"] == EXPORT_NODE)["data"]


@pytest.fixture
async def source(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: Callable[..., Awaitable[Any]],
) -> dict[str, Any]:
    home = str(fixture_get_home_folder["id"])
    owner = await db_session.get(User, fixture_create_user)
    folder = await db_session.get(Folder, UUID(home))
    assert owner is not None and folder is not None
    dataset = await make_layer(owner, folder)
    result = await make_layer(owner, folder)
    await db_session.commit()
    project_id = await _create_project(client, home, name="source")
    workflow_id = await _create_workflow(
        client, project_id, _with_export(_dataset_workflow_config(dataset.id))
    )
    return {
        "home": home,
        "project": project_id,
        "workflow": workflow_id,
        "dataset": dataset,
        "result": result,
    }


async def _ran_and_styled(db: AsyncSession, source: dict[str, Any]) -> None:
    """What a run and the author's styling leave behind: the export's layer in
    the project, its entry stamped with the workflow and node, and styled."""
    stamp = {
        "workflow_export": {
            "workflow_id": source["workflow"],
            "export_node_id": EXPORT_NODE,
        }
    }
    await db.execute(
        text(
            f"""
            WITH lp AS (
                INSERT INTO {S}.layer_project
                    (layer_id, project_id, name, "order", other_properties, updated_at)
                VALUES (:l, :p, 'Buffers', 0, CAST(:stamp AS jsonb), now())
                RETURNING id
            ),
            s AS (
                INSERT INTO {S}.layer_style (layer_project_id, name, document)
                SELECT id, 'Default', CAST(:style AS jsonb) FROM lp
                RETURNING id, layer_project_id
            )
            UPDATE {S}.layer_project SET active_style_id = s.id
            FROM s WHERE layer_project.id = s.layer_project_id
            """
        ),
        {
            "l": source["result"].id,
            "p": source["project"],
            "style": json.dumps(STYLE),
            "stamp": json.dumps(stamp),
        },
    )
    await db.commit()


@pytest.mark.asyncio
async def test_a_workflow_template_keeps_the_style_of_its_exported_layer(
    client: AsyncClient, db_session: AsyncSession, source: dict[str, Any]
) -> None:
    await _ran_and_styled(db_session, source)
    template = await _template(
        client,
        source["home"],
        source["project"],
        source["workflow"],
        source["dataset"].id,
    )
    assert (
        _export_data(await _template_config(db_session, template["id"]))["outputStyle"]
        == STYLE
    )

    # Used into another project, the workflow's export node still carries it.
    target = await _create_project(client, source["home"], name="target")
    used = await client.post(
        f"{settings.API_V2_STR}/template/{template['id']}/use",
        json={"project_id": target},
    )
    assert used.status_code == 200, used.text
    workflow = await client.get(
        f"{settings.API_V2_STR}/project/{target}/workflow/{used.json()['workflow_id']}"
    )
    assert _export_data(workflow.json()["config"])["outputStyle"] == STYLE


@pytest.mark.asyncio
async def test_an_export_that_never_ran_carries_no_style(
    client: AsyncClient, db_session: AsyncSession, source: dict[str, Any]
) -> None:
    template = await _template(
        client,
        source["home"],
        source["project"],
        source["workflow"],
        source["dataset"].id,
    )
    assert "outputStyle" not in _export_data(
        await _template_config(db_session, template["id"])
    )
