"""After the switch no core endpoint takes or returns today's `properties`; map
state goes through its columns (spec 10 and 17)."""

import pytest
from core.core.config import settings
from core.db.models._link_model import LayerProjectGroup
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.styles.conftest import StyleWorld

API = settings.API_V2_STR
S = settings.SCHEMA


async def link_row(db: AsyncSession, lp: int):
    return (
        await db.execute(
            text(
                f"SELECT name, properties, visible, legend_expanded, updated_at, "
                f'layer_project_group_id, "order" FROM {S}.layer_project WHERE id = :lp'
            ),
            {"lp": lp},
        )
    ).one()


@pytest.mark.asyncio
async def test_a_payload_with_properties_is_accepted_and_stores_nothing_of_it(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    response = await client.put(
        f"{API}/project/{world.project_id}/layer/{world.layer_project_id}",
        json={"name": "Renamed", "properties": {"color": [1, 2, 3]}},
    )
    assert response.status_code == 200, response.text
    row = await link_row(db_session, world.layer_project_id)
    assert row.name == "Renamed"
    assert row.properties in (None, {})
    dataset = await client.put(
        f"{API}/layer/{world.layer_id}", json={"properties": {"color": [1, 2, 3]}}
    )
    assert dataset.status_code == 200, dataset.text
    stored = (
        await db_session.execute(
            text(f"SELECT properties FROM {S}.layer WHERE id = :l"),
            {"l": world.layer_id},
        )
    ).scalar_one()
    assert stored in (None, {})


@pytest.mark.asyncio
async def test_the_tree_put_writes_the_map_state_columns_and_leaves_updated_at(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    group = LayerProjectGroup(name="G", project_id=world.project_id)
    db_session.add(group)
    await db_session.commit()
    before = await link_row(db_session, world.layer_project_id)
    response = await client.put(
        f"{API}/project/{world.project_id}/layer-tree",
        json={
            "items": [
                {
                    "id": group.id,
                    "type": "group",
                    "order": 0,
                    "visible": False,
                    "expanded": False,
                },
                {
                    "id": world.layer_project_id,
                    "type": "layer",
                    "order": 1,
                    "parent_id": group.id,
                    "visible": False,
                    "legend_expanded": False,
                },
            ]
        },
    )
    assert response.status_code == 204, response.text
    after = await link_row(db_session, world.layer_project_id)
    assert (
        after.visible,
        after.legend_expanded,
        after.layer_project_group_id,
        after.order,
    ) == (
        False,
        False,
        group.id,
        1,
    )
    assert after.updated_at == before.updated_at
    stored = (
        await db_session.execute(
            text(
                f"SELECT visible, expanded FROM {S}.layer_project_group WHERE id = :g"
            ),
            {"g": group.id},
        )
    ).one()
    assert tuple(stored) == (False, False)


@pytest.mark.asyncio
async def test_reads_carry_no_properties(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    group = LayerProjectGroup(name="G", project_id=world.project_id, expanded=False)
    db_session.add(group)
    await db_session.commit()
    layers = (await client.get(f"{API}/project/{world.project_id}/layer")).json()
    assert layers and all("properties" not in row for row in layers)
    dataset = (await client.get(f"{API}/layer/{world.layer_id}")).json()
    assert "properties" not in dataset
    groups = (await client.get(f"{API}/project/{world.project_id}/group")).json()
    [read] = [g for g in groups if g["id"] == group.id]
    assert "properties" not in read
    assert (read["visible"], read["expanded"]) == (True, False)
