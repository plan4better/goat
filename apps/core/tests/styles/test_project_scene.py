"""The project's scene (3D spec 5.2, 6): saved through the project update like the
basemap, checked by goatlib first; an error stores nothing of the request."""

from collections.abc import Callable
from typing import Any
from uuid import UUID

import pytest
from core.core.config import settings
from core.db.models.layer_style import LayerStyle
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.authz.conftest import auth_on, authz_sql  # noqa: F401
from tests.styles.conftest import StyleWorld
from tests.styles.test_style_routes import viewer_world

API = settings.API_V2_STR
S = settings.SCHEMA
EXTRUDED = {"version": 1, "kind": "vector", "symbol": {"extrude": {"height": 10}}}
#: Sun position is no longer offered: a write with its keys is refused.
SUN_POSITION = {"light": {"mode": "sun", "month": 6, "day": 21}}


@pytest.fixture(autouse=True)
def scene_sources(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        settings, "TERRAIN_TILES_URL", "https://terrain.example.com/{z}/{x}/{y}.webp"
    )
    monkeypatch.setattr(
        settings, "BUILDINGS_TILES_URL", "https://buildings.example.com/planet"
    )


async def update(client: AsyncClient, world: StyleWorld, **body: Any) -> Any:
    return await client.put(f"{API}/project/{world.project_id}", json=body)


async def stored(db: AsyncSession, world: StyleWorld) -> Any:
    return (
        await db.execute(
            text(f"SELECT scene, name FROM {S}.project WHERE id = :p"),
            {"p": world.project_id},
        )
    ).one()


async def set_active_style(
    db: AsyncSession, world: StyleWorld, document: dict[str, Any]
) -> None:
    row = LayerStyle(
        layer_project_id=world.layer_project_id, name="Heights", document=document
    )
    db.add(row)
    await db.commit()
    await db.execute(
        text(f"UPDATE {S}.layer_project SET active_style_id = :s WHERE id = :lp"),
        {"s": row.id, "lp": world.layer_project_id},
    )
    await db.commit()


@pytest.mark.asyncio
async def test_editor_saves_scene_with_the_project(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    """A scene with only warnings is stored; the answer is the project."""
    world = api_style_world
    scene = {"terrain": False, "fog": {"color": "#ffffff"}, "buildings": True}
    r = await update(client, world, scene=scene)
    assert r.status_code == 200, r.text
    assert r.json()["scene"] == scene
    assert (await stored(db_session, world)).scene == scene
    read = await client.get(f"{API}/project/{world.project_id}")
    assert read.json()["scene"] == scene


@pytest.mark.asyncio
async def test_an_update_without_scene_leaves_it(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    await update(client, world, scene={"buildings": False})
    r = await update(client, world, name="renamed")
    assert r.status_code == 200, r.text
    row = await stored(db_session, world)
    assert (row.scene, row.name) == ({"buildings": False}, "renamed")


@pytest.mark.asyncio
async def test_null_and_empty_reset_to_automatic(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    for automatic in (None, {}):
        await update(client, world, scene={"buildings": False})
        r = await update(client, world, scene=automatic)
        assert r.status_code == 200, r.text
        assert r.json().get("scene") is None
        assert (await stored(db_session, world)).scene is None


@pytest.mark.asyncio
async def test_a_scene_with_an_error_stores_nothing(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    """Neither the scene nor the other fields of the request."""
    world = api_style_world
    await update(client, world, scene={"buildings": False})
    r = await update(client, world, name="renamed", scene=SUN_POSITION)
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "invalid_scene"
    assert [(i["code"], i["path"]) for i in detail["issues"]] == [
        ("unknown_key", "/scene/light/day"),
        ("unknown_key", "/scene/light/mode"),
        ("unknown_key", "/scene/light/month"),
    ]
    row = await stored(db_session, world)
    assert (row.scene, row.name) == ({"buildings": False}, "p")


@pytest.mark.asyncio
async def test_unknown_keys_in_the_scene_are_refused(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    r = await update(client, api_style_world, scene={"rain": True})
    assert r.status_code == 422
    assert [i["code"] for i in r.json()["detail"]["issues"]] == ["unknown_key"]
    assert (await stored(db_session, api_style_world)).scene is None


@pytest.mark.asyncio
async def test_viewer_cannot_save_scene(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    auth_on: Callable[..., dict[str, str]],  # noqa: F811 (the imported fixture)
) -> None:
    """The project update's own authorization: a viewer lacks update-project,
    which `auth_z` answers with 401, and nothing is stored."""
    world = await viewer_world(db_session)
    me = UUID(str(settings.DEFAULT_USER_ID))
    r = await client.put(
        f"{API}/project/{world.project_id}",
        json={"scene": {"buildings": False}},
        headers=auth_on(me),
    )
    assert r.status_code == 401, r.text
    assert (await stored(db_session, world)).scene is None


@pytest.mark.asyncio
async def test_extruded_layers_and_missing_sources_still_save(
    client: AsyncClient,
    db_session: AsyncSession,
    api_style_world: StyleWorld,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Warnings (buildings over an extruded layer, a source this installation
    lacks) do not stop the save."""
    world = api_style_world
    await set_active_style(db_session, world, EXTRUDED)
    monkeypatch.setattr(settings, "TERRAIN_TILES_URL", "")
    scene = {"buildings": True, "terrain": {"exaggeration": 2}}
    r = await update(client, world, scene=scene)
    assert r.status_code == 200, r.text
    assert (await stored(db_session, world)).scene == scene


@pytest.mark.asyncio
async def test_extruded_layers_are_the_shown_ones_that_draw_heights(
    db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    from core.services.map_document import extruded_layers

    world = api_style_world
    assert await extruded_layers(db_session, world.project_id) == frozenset()
    await set_active_style(db_session, world, EXTRUDED)
    assert await extruded_layers(db_session, world.project_id) == {
        world.layer_project_id
    }
    await db_session.execute(
        text(f"UPDATE {S}.layer_project SET visible = false WHERE id = :lp"),
        {"lp": world.layer_project_id},
    )
    await db_session.commit()
    assert await extruded_layers(db_session, world.project_id) == frozenset()
