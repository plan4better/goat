"""Publishing snapshots the map and every named style (spec 13.2); the project then
shows which layers have unpublished changes, and why."""

import copy
import json
from typing import Any
from uuid import UUID

import pytest
from core.core.config import settings
from core.db.models.layer_style import LayerStyle
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.styles.conftest import StyleWorld

API = settings.API_V2_STR
S = settings.SCHEMA
CLASSIFIED: dict[str, Any] = {
    "version": 1,
    "kind": "vector",
    "symbol": {"fill": {"color": "#111111"}},
    "classify": [
        {
            "id": "density",
            "field": "density",
            "method": "quantile",
            "count": 2,
            "classes": [{"id": "c1", "to": 5}, {"id": "c2", "from": 5}],
            "computed": {"at": "2026-10-25T10:00:00Z", "data": "ducklake:0"},
        }
    ],
}


@pytest.fixture(autouse=True)
def tracker_reads_the_scratch_lake(lake: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "DUCKLAKE_CATALOG_SCHEMA", lake)


async def styles(db: AsyncSession, world: StyleWorld) -> list[UUID]:
    ids = []
    for position, name in enumerate(["Density", "Plain"]):
        row = LayerStyle(
            layer_project_id=world.layer_project_id,
            name=name,
            position=position,
            document=CLASSIFIED,
        )
        db.add(row)
        await db.commit()
        assert row.id is not None
        ids.append(row.id)
    return ids


async def change(db: AsyncSession, style_id: UUID, edit) -> None:
    document = copy.deepcopy(CLASSIFIED)
    edit(document)
    await db.execute(
        text(f"UPDATE {S}.layer_style SET document = CAST(:d AS jsonb) WHERE id = :id"),
        {"d": json.dumps(document), "id": style_id},
    )
    await db.commit()


async def unpublished(client: AsyncClient, world: StyleWorld) -> list[dict[str, Any]]:
    response = await client.get(f"{API}/project/{world.project_id}/map")
    assert response.status_code == 200, response.text
    return response.json()["unpublished"]


async def publish(client: AsyncClient, world: StyleWorld) -> dict[str, Any]:
    response = await client.post(f"{API}/project/{world.project_id}/publish")
    assert response.status_code == 200, response.text
    return response.json()["config"]


@pytest.mark.asyncio
async def test_publishing_stores_the_map_and_every_named_style(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    first, second = await styles(db_session, world)
    config = await publish(client, world)
    assert config["map"]["layers"][0]["id"] == world.layer_project_id
    published = config["styles"][str(world.layer_project_id)]
    assert [s["id"] for s in published] == [str(first), str(second)]
    assert published[0]["document"] == CLASSIFIED
    assert await unpublished(client, world) == []


@pytest.mark.asyncio
async def test_a_recompute_shows_as_unpublished_with_reason_recomputed(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    first, _ = await styles(db_session, world)
    await publish(client, world)

    def recompute(doc: dict[str, Any]) -> None:
        doc["classify"][0]["classes"] = [{"id": "c1", "to": 9}, {"id": "c2", "from": 9}]
        doc["classify"][0]["computed"] = {
            "at": "2026-10-26T10:00:00Z",
            "data": "ducklake:7",
        }

    await change(db_session, first, recompute)
    assert await unpublished(client, world) == [
        {"layer_project_id": world.layer_project_id, "reason": "recomputed"}
    ]


@pytest.mark.asyncio
async def test_an_edit_shows_as_edited(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    _, second = await styles(db_session, world)
    await publish(client, world)
    await change(
        db_session, second, lambda doc: doc["symbol"]["fill"].update(color="#ff0000")
    )
    assert await unpublished(client, world) == [
        {"layer_project_id": world.layer_project_id, "reason": "edited"}
    ]


@pytest.mark.asyncio
async def test_stamps_alone_are_no_change(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    first, _ = await styles(db_session, world)
    await publish(client, world)
    await change(
        db_session,
        first,
        lambda doc: doc["classify"][0]["computed"].update(at="2026-10-27T10:00:00Z"),
    )
    assert await unpublished(client, world) == []
