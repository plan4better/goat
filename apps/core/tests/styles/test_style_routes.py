"""The style routes (spec 10 and 13.1): named styles of a project layer and the dataset default."""

from typing import Any
from uuid import UUID, uuid4

import pytest
from core.core.config import settings
from core.db.models._link_model import LayerProjectLink
from core.db.models.layer import Layer
from core.db.models.layer_style import LayerStyle
from core.db.models.user import User
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.styles.conftest import StyleWorld

API = settings.API_V2_STR
S = settings.SCHEMA


def styles_url(world: StyleWorld, layer_project_id: int | None = None) -> str:
    lp = layer_project_id or world.layer_project_id
    return f"{API}/project/{world.project_id}/layer/{lp}/style"


async def create(
    client: AsyncClient, world: StyleWorld, name: str, **body: Any
) -> dict[str, Any]:
    response = await client.post(styles_url(world), json={"name": name, **body})
    assert response.status_code == 200, response.text
    return response.json()


def with_fill(document: dict[str, Any], color: str) -> dict[str, Any]:
    out = {**document, "symbol": {**document.get("symbol", {})}}
    out["symbol"]["fill"] = {**out["symbol"].get("fill", {}), "color": color}
    return out


async def active_style_id(db: AsyncSession, layer_project_id: int) -> UUID | None:
    return (
        await db.execute(
            text(f"SELECT active_style_id FROM {S}.layer_project WHERE id = :id"),
            {"id": layer_project_id},
        )
    ).scalar_one()


@pytest.mark.asyncio
async def test_the_style_lifecycle(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    first = await create(client, world, "Population")
    assert (first["revision"], first["position"]) == (1, 0)
    assert first["document"]["kind"] == "vector"
    assert await active_style_id(db_session, world.layer_project_id) == UUID(
        first["id"]
    )

    second = await create(client, world, "Density")
    assert second["position"] == 1
    assert second["document"] == first["document"]

    saved = await client.put(
        f"{styles_url(world)}/{second['id']}",
        json={"base_rev": 1, "document": with_fill(second["document"], "#222222")},
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["revision"] == 2
    assert saved.json()["document"]["symbol"]["fill"]["color"] == "#222222"

    moved = await client.patch(
        f"{styles_url(world)}/{second['id']}",
        json={"name": "Density 2024", "position": 0},
    )
    assert moved.status_code == 200, moved.text
    assert (moved.json()["name"], moved.json()["position"]) == ("Density 2024", 0)
    read_first = await client.get(f"{styles_url(world)}/{first['id']}")
    assert read_first.json()["position"] == 1

    deleted = await client.delete(f"{styles_url(world)}/{first['id']}")
    assert deleted.status_code == 204, deleted.text
    assert await active_style_id(db_session, world.layer_project_id) == UUID(
        second["id"]
    )
    last = await client.delete(f"{styles_url(world)}/{second['id']}")
    assert last.status_code == 409
    assert last.json()["detail"]["code"] == "last_style"


@pytest.mark.asyncio
async def test_a_new_style_copies_the_dataset_default_when_the_layer_has_none(
    client: AsyncClient, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    document = {
        "version": 1,
        "kind": "vector",
        "symbol": {"fill": {"color": "#123456"}},
    }
    put = await client.put(
        f"{API}/layer/{world.layer_id}/style", json={"document": document}
    )
    assert put.status_code == 200, put.text
    first = await create(client, world, "From default")
    assert first["document"]["symbol"]["fill"]["color"] == "#123456"


@pytest.mark.asyncio
async def test_an_eleventh_style_is_refused(
    client: AsyncClient, api_style_world: StyleWorld
) -> None:
    for i in range(10):
        await create(client, api_style_world, f"Style {i}")
    response = await client.post(styles_url(api_style_world), json={"name": "One more"})
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "too_many_styles"


@pytest.mark.asyncio
async def test_a_style_of_another_project_layer_is_404(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    style = await create(client, world, "Mine")
    second = LayerProjectLink(
        project_id=world.project_id,
        layer_id=world.layer_id,
        name="second",
        properties={},
    )
    db_session.add(second)
    await db_session.commit()
    assert second.id is not None
    other_link = second.id
    wrong_layer = await client.get(f"{styles_url(world, other_link)}/{style['id']}")
    assert wrong_layer.status_code == 404
    wrong_project = await client.get(
        f"{API}/project/{uuid4()}/layer/{world.layer_project_id}/style/{style['id']}"
    )
    assert wrong_project.status_code == 404


@pytest.mark.asyncio
async def test_base_too_old_answers_409_with_its_code(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    style = await create(client, api_style_world, "Old")
    await db_session.execute(
        text(f"UPDATE {S}.layer_style SET revision = 30 WHERE id = :id"),
        {"id": style["id"]},
    )
    await db_session.commit()
    response = await client.put(
        f"{styles_url(api_style_world)}/{style['id']}",
        json={"base_rev": 2, "document": with_fill(style["document"], "#333333")},
    )
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "base_too_old"


@pytest.mark.asyncio
async def test_check_stores_nothing(
    client: AsyncClient, api_style_world: StyleWorld
) -> None:
    style = await create(client, api_style_world, "Checked")
    broken = with_fill(style["document"], "#444444")
    broken["symbol"]["fill"]["opacity"] = 5
    response = await client.post(
        f"{styles_url(api_style_world)}/{style['id']}/check", json={"document": broken}
    )
    assert response.status_code == 200, response.text
    assert any(i["path"] == "/symbol/fill/opacity" for i in response.json()["issues"])
    again = await client.get(f"{styles_url(api_style_world)}/{style['id']}")
    assert again.json()["revision"] == 1
    assert again.json()["document"] == style["document"]


@pytest.mark.asyncio
async def test_set_as_default_replaces_the_dataset_default(
    client: AsyncClient, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    style = await create(client, world, "Shared look")
    await client.put(
        f"{styles_url(world)}/{style['id']}",
        json={"base_rev": 1, "document": with_fill(style["document"], "#555555")},
    )
    response = await client.post(f"{styles_url(world)}/{style['id']}/set-as-default")
    assert response.status_code == 200, response.text
    default = await client.get(f"{API}/layer/{world.layer_id}/style")
    assert default.status_code == 200
    assert default.json()["document"]["symbol"]["fill"]["color"] == "#555555"


@pytest.mark.asyncio
async def test_catalog_layer_defaults_are_read_only(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    style = await create(client, world, "Catalog")
    layer = await db_session.get(Layer, world.layer_id)
    assert layer is not None
    layer.catalog_external_uid = "catalog:districts"
    await db_session.commit()
    put = await client.put(
        f"{API}/layer/{world.layer_id}/style", json={"document": style["document"]}
    )
    assert put.status_code == 403
    assert put.json()["detail"]["code"] == "read_only"
    promoted = await client.post(f"{styles_url(world)}/{style['id']}/set-as-default")
    assert promoted.status_code == 403
    assert promoted.json()["detail"]["code"] == "read_only"


@pytest.mark.asyncio
async def test_a_locked_project_layer_refuses_its_styles(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    """A layer added by a member who could not share it (D7) has nothing to restyle."""
    world = api_style_world
    style = await create(client, world, "Locked")
    stranger = User(
        id=uuid4(),
        email=f"x-{uuid4().hex[:6]}@goat.test",
        firstname="X",
        lastname="Y",
        avatar="",
    )
    db_session.add(stranger)
    await db_session.flush()
    await db_session.execute(
        text(
            f"UPDATE {S}.layer SET user_id = :u, folder_id = NULL, space_id = NULL WHERE id = :l"
        ),
        {"u": stranger.id, "l": world.layer_id},
    )
    await db_session.execute(
        text(f"UPDATE {S}.layer_project SET shareable = false WHERE id = :id"),
        {"id": world.layer_project_id},
    )
    await db_session.commit()
    response = await client.get(f"{styles_url(world)}/{style['id']}")
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_opening_the_panel_checks_the_stored_style(
    client: AsyncClient, api_style_world: StyleWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    from core.services import style as style_service

    style = await create(client, api_style_world, "Checked on open")
    damaged = {
        "level": "damaged",
        "code": "field_missing",
        "path": "/symbol",
        "message": "gone",
    }
    calls: list[dict[str, Any]] = []

    async def check(**kwargs: Any) -> dict[str, Any]:
        calls.append(kwargs)
        return {"document": kwargs["document"], "issues": [damaged]}

    monkeypatch.setattr(style_service, "style_check", check)
    response = await client.get(
        f"{styles_url(api_style_world)}/{style['id']}?check=true"
    )
    assert response.status_code == 200, response.text
    assert response.json()["issues"] == [damaged]
    assert calls[0]["compute"] is False


@pytest.mark.asyncio
async def test_a_new_style_copies_the_shown_style_and_does_not_switch_it(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    """No active style set means the first by position is shown (spec 10): a new
    style copies that one and leaves the map as it was."""
    world = api_style_world
    await client.put(
        f"{API}/layer/{world.layer_id}/style",
        json={
            "document": {
                "version": 1,
                "kind": "vector",
                "symbol": {"fill": {"color": "#999999"}},
            }
        },
    )
    first = await create(client, world, "First")
    await client.put(
        f"{styles_url(world)}/{first['id']}",
        json={"base_rev": 1, "document": with_fill(first["document"], "#123123")},
    )
    await client.patch(
        f"{API}/project/{world.project_id}/layer/{world.layer_project_id}/map-state",
        json={"active_style_id": None},
    )
    new = await create(client, world, "Second")
    assert new["document"]["symbol"]["fill"]["color"] == "#123123"
    assert await active_style_id(db_session, world.layer_project_id) is None


async def viewer_world(db: AsyncSession) -> StyleWorld:
    """A world of another user, shared with the API's identity as viewer."""
    from core.db.models._link_model import ResourceGrant
    from tests.styles.conftest import build_style_world

    owner = User(
        id=uuid4(),
        email=f"o-{uuid4().hex[:6]}@goat.test",
        firstname="O",
        lastname="W",
        avatar="",
    )
    db.add(owner)
    await db.flush()
    world = await build_style_world(db, owner)
    role_id = (
        await db.execute(text(f"SELECT id FROM {S}.role WHERE name = 'project-viewer'"))
    ).scalar_one_or_none()
    if role_id is None:
        role_id = (
            await db.execute(
                text(
                    f"INSERT INTO {S}.role (name, resource_type) "
                    "VALUES ('project-viewer', 'project') RETURNING id"
                )
            )
        ).scalar_one()
    db.add(
        ResourceGrant(
            resource_type="project",
            resource_id=world.project_id,
            grantee_type="user",
            grantee_id=UUID(str(settings.DEFAULT_USER_ID)),
            role_id=role_id,
            granted_by=owner.id,
        )
    )
    await db.commit()
    return world


@pytest.mark.asyncio
async def test_a_viewer_reads_but_a_save_answers_403(
    client: AsyncClient, db_session: AsyncSession, fixture_create_user: UUID
) -> None:
    """403, not 401: the browser shows the layer can no longer be edited instead of
    renewing the session and retrying forever (spec 13.1)."""
    world = await viewer_world(db_session)
    style = LayerStyle(
        layer_project_id=world.layer_project_id,
        name="Shared",
        document={
            "version": 1,
            "kind": "vector",
            "symbol": {"fill": {"color": "#111111"}},
        },
    )
    db_session.add(style)
    await db_session.commit()
    url = f"{styles_url(world)}/{style.id}"
    assert (await client.get(url)).status_code == 200
    saved = await client.put(url, json={"base_rev": 1, "document": style.document})
    assert saved.status_code == 403
    assert saved.json()["detail"]["code"] == "forbidden"
    hidden = await client.patch(
        f"{API}/project/{world.project_id}/layer/{world.layer_project_id}/map-state",
        json={"visible": False},
    )
    assert hidden.status_code == 403
    gone = await client.get(f"{API}/project/{uuid4()}/map")
    assert gone.status_code == 404
