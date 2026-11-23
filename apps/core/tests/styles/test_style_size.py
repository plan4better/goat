"""Size limits of what core stores with a map (spec 10): a style document, a
project layer's time position and a project's scene. A larger one is refused
before anything else reads it, and nothing is stored."""

import asyncio
from typing import Any
from uuid import UUID

import pytest
from core.core.config import settings
from goatlib.style.map_rows import MAX_DOCUMENT_BYTES, MAX_MAP_VALUE_BYTES, json_bytes
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.styles.conftest import StyleWorld
from tests.styles.test_style_routes import create, styles_url, with_fill

API = settings.API_V2_STR
S = settings.SCHEMA


def sized(document: dict[str, Any], size: int) -> dict[str, Any]:
    """`document` with a legend caption that makes it exactly `size` bytes."""
    out = {**document, "legend": {**document.get("legend", {}), "caption": ""}}
    out["legend"]["caption"] = "x" * (size - json_bytes(out))
    assert json_bytes(out) == size
    return out


async def stored_style(db: AsyncSession, style_id: str) -> Any:
    return (
        await db.execute(
            text(f"SELECT revision, document FROM {S}.layer_style WHERE id = :id"),
            {"id": style_id},
        )
    ).one()


async def revisions(db: AsyncSession, style_id: str) -> int:
    return (
        await db.execute(
            text(f"SELECT count(*) FROM {S}.layer_style_revision WHERE style_id = :id"),
            {"id": style_id},
        )
    ).scalar_one()


@pytest.mark.asyncio
async def test_a_save_over_the_limit_is_refused_and_stores_nothing(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    style = await create(client, world, "Large")
    document = sized(with_fill(style["document"], "#222222"), MAX_DOCUMENT_BYTES + 1)
    response = await client.put(
        f"{styles_url(world)}/{style['id']}",
        json={"base_rev": 1, "document": document},
    )
    assert response.status_code == 422, response.text[:300]
    assert response.json()["detail"] == {"code": "document_too_large"}
    row = await stored_style(db_session, style["id"])
    assert (row.revision, row.document) == (1, style["document"])
    assert await revisions(db_session, style["id"]) == 1


@pytest.mark.asyncio
async def test_a_save_at_the_limit_is_stored(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    style = await create(client, world, "At the limit")
    document = sized(with_fill(style["document"], "#222222"), MAX_DOCUMENT_BYTES)
    response = await client.put(
        f"{styles_url(world)}/{style['id']}",
        json={"base_rev": 1, "document": document},
    )
    assert response.status_code == 200, response.text[:300]
    assert response.json()["revision"] == 2
    row = await stored_style(db_session, style["id"])
    assert row.document["legend"]["caption"] == document["legend"]["caption"]


@pytest.mark.asyncio
async def test_a_check_over_the_limit_is_refused(
    client: AsyncClient, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    style = await create(client, world, "Checked")
    document = sized(style["document"], MAX_DOCUMENT_BYTES + 1)
    response = await client.post(
        f"{styles_url(world)}/{style['id']}/check", json={"document": document}
    )
    assert response.status_code == 422, response.text[:300]
    assert response.json()["detail"] == {"code": "document_too_large"}
    under = await client.post(
        f"{styles_url(world)}/{style['id']}/check",
        json={"document": sized(style["document"], MAX_DOCUMENT_BYTES)},
    )
    assert under.status_code == 200, under.text[:300]


@pytest.mark.asyncio
async def test_a_dataset_default_over_the_limit_is_refused_before_its_row_exists(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    base = {
        "version": "1.0.0",
        "kind": "vector",
        "symbol": {"fill": {"color": "#111111"}},
    }
    response = await client.put(
        f"{API}/layer/{world.layer_id}/style",
        json={"document": sized(base, MAX_DOCUMENT_BYTES + 1)},
    )
    assert response.status_code == 422, response.text[:300]
    assert response.json()["detail"] == {"code": "document_too_large"}
    rows = (
        await db_session.execute(
            text(f"SELECT count(*) FROM {S}.layer_style WHERE layer_id = :id"),
            {"id": world.layer_id},
        )
    ).scalar_one()
    assert rows == 0


@pytest.mark.asyncio
async def test_a_time_value_over_its_limit_is_refused(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    url = f"{API}/project/{world.project_id}/layer/{world.layer_project_id}/map-state"
    big = "x" * MAX_MAP_VALUE_BYTES
    response = await client.patch(url, json={"time_value": big})
    assert response.status_code == 422, response.text[:300]
    assert response.json()["detail"] == {"code": "time_value_too_large"}
    stored = (
        await db_session.execute(
            text(f"SELECT time_value FROM {S}.layer_project WHERE id = :id"),
            {"id": world.layer_project_id},
        )
    ).scalar_one()
    assert stored is None
    fits = await client.patch(url, json={"time_value": big[:-2]})
    assert fits.status_code == 204, fits.text[:300]


@pytest.mark.asyncio
async def test_a_scene_over_its_limit_is_refused(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    scene = {"fog": {"color": "#ffffff"}, "note": "x" * MAX_MAP_VALUE_BYTES}
    response = await client.put(
        f"{API}/project/{world.project_id}", json={"name": "renamed", "scene": scene}
    )
    assert response.status_code == 422, response.text[:300]
    assert response.json()["detail"] == {"code": "scene_too_large"}
    row = (
        await db_session.execute(
            text(f"SELECT scene, name FROM {S}.project WHERE id = :p"),
            {"p": world.project_id},
        )
    ).one()
    assert (row.scene, row.name) == (None, "p")


@pytest.mark.asyncio
async def test_goatlib_work_runs_off_the_event_loop(
    client: AsyncClient,
    api_style_world: StyleWorld,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A save, a check and a read call goatlib on a whole document in a worker
    thread, so one large style does not hold up every other request."""
    from core.services import style as style_service

    on_loop: list[str] = []

    def off_loop(name: str) -> None:
        original = getattr(style_service, name)

        def wrapper(*args: Any, **kwargs: Any) -> Any:
            try:
                asyncio.get_running_loop()
                on_loop.append(name)
            except RuntimeError:
                pass
            return original(*args, **kwargs)

        monkeypatch.setattr(style_service, name, wrapper)

    world = api_style_world
    style = await create(client, world, "Threads")
    for name in (
        "assign_ids",
        "existing_ids",
        "diff",
        "apply",
        "validate",
        "upgrade",
        "stamp",
        "same_ignoring_stamps",
    ):
        off_loop(name)
    url = f"{styles_url(world)}/{style['id']}"
    saved = await client.put(
        url, json={"base_rev": 1, "document": with_fill(style["document"], "#777777")}
    )
    assert saved.status_code == 200, saved.text[:300]
    # Based on the older revision: merged onto the stored document.
    merged = await client.put(
        url, json={"base_rev": 1, "document": with_fill(style["document"], "#888888")}
    )
    assert merged.status_code == 200, merged.text[:300]
    assert merged.json()["revision"] == 3
    checked = await client.post(f"{url}/check", json={"document": style["document"]})
    assert checked.status_code == 200, checked.text[:300]
    read = await client.get(url)
    assert read.status_code == 200, read.text[:300]
    default = await client.put(
        f"{API}/layer/{world.layer_id}/style", json={"document": style["document"]}
    )
    assert default.status_code == 200, default.text[:300]
    assert on_loop == []
    assert UUID(saved.json()["id"]) == UUID(style["id"])
