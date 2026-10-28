"""Map state writes (spec 10): one field per request, last write
wins, and the project layer's `updated_at` stays (the web keys its tile sources on it)."""

from uuid import UUID

import pytest
from core.core.config import settings
from core.db.models._link_model import LayerProjectGroup, LayerProjectLink
from core.db.models.layer_style import LayerStyle
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.styles.conftest import StyleWorld

API = settings.API_V2_STR
S = settings.SCHEMA
DOC = {"version": 1, "kind": "vector", "symbol": {"fill": {"color": "#111111"}}}


async def style_of(db: AsyncSession, layer_project_id: int) -> UUID:
    row = LayerStyle(layer_project_id=layer_project_id, name="S", document=DOC)
    db.add(row)
    await db.commit()
    assert row.id is not None
    return row.id


async def link_row(db: AsyncSession, layer_project_id: int):
    return (
        await db.execute(
            text(
                "SELECT visible, active_style_id, position, time_value, legend_expanded, updated_at "
                f"FROM {S}.layer_project WHERE id = :id"
            ),
            {"id": layer_project_id},
        )
    ).one()


@pytest.mark.asyncio
async def test_map_state_writes_one_field_and_leaves_updated_at(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    url = f"{API}/project/{world.project_id}/layer/{world.layer_project_id}/map-state"
    before = await link_row(db_session, world.layer_project_id)
    style_id = await style_of(db_session, world.layer_project_id)
    for body in (
        {"visible": False},
        {"active_style_id": str(style_id)},
        {"position": "below_roads"},
        {"time_value": 2024},
        {"legend_expanded": False},
    ):
        response = await client.patch(url, json=body)
        assert response.status_code == 204, response.text
    after = await link_row(db_session, world.layer_project_id)
    assert (after.visible, after.active_style_id, after.position) == (
        False,
        style_id,
        "below_roads",
    )
    assert (after.time_value, after.legend_expanded) == (2024, False)
    assert after.updated_at == before.updated_at
    assert (await client.patch(url, json={"position": "sideways"})).status_code == 422


@pytest.mark.asyncio
async def test_an_active_style_of_another_layer_is_refused(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    other = LayerProjectLink(
        project_id=world.project_id,
        layer_id=world.layer_id,
        name="other",
        properties={},
    )
    db_session.add(other)
    await db_session.commit()
    assert other.id is not None
    foreign = await style_of(db_session, other.id)
    response = await client.patch(
        f"{API}/project/{world.project_id}/layer/{world.layer_project_id}/map-state",
        json={"active_style_id": str(foreign)},
    )
    assert response.status_code == 422
    assert (await link_row(db_session, world.layer_project_id)).active_style_id is None


@pytest.mark.asyncio
async def test_group_visibility(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    group = LayerProjectGroup(name="G", project_id=world.project_id)
    db_session.add(group)
    await db_session.commit()
    response = await client.patch(
        f"{API}/project/{world.project_id}/group/{group.id}/map-state",
        json={"visible": False},
    )
    assert response.status_code == 204, response.text
    visible = (
        await db_session.execute(
            text(f"SELECT visible FROM {S}.layer_project_group WHERE id = :id"),
            {"id": group.id},
        )
    ).scalar_one()
    assert visible is False
    other_project = await client.patch(
        f"{API}/project/{world.project_id}/group/999999/map-state",
        json={"visible": False},
    )
    assert other_project.status_code == 404


@pytest.mark.asyncio
async def test_the_project_locale_is_written_and_cleared(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    url = f"{API}/project/{api_style_world.project_id}"
    response = await client.put(url, json={"locale": "de-DE"})
    assert response.status_code == 200, response.text
    assert response.json()["locale"] == "de-DE"
    cleared = await client.put(url, json={"locale": None})
    assert cleared.status_code == 200
    locale = (
        await db_session.execute(
            text(f"SELECT locale FROM {S}.project WHERE id = :id"),
            {"id": api_style_world.project_id},
        )
    ).scalar_one()
    assert locale is None


@pytest.mark.asyncio
async def test_a_locale_that_is_not_a_language_tag_is_refused(
    client: AsyncClient, api_style_world: StyleWorld
) -> None:
    """The web formats numbers with it (Intl.NumberFormat throws on a bad tag)."""
    url = f"{API}/project/{api_style_world.project_id}"
    for bad in ("not a locale; x", "de_DE", "-DE"):
        response = await client.put(url, json={"locale": bad})
        assert response.status_code == 422, (bad, response.text)
    assert (await client.put(url, json={"locale": "pt-BR"})).status_code == 200
