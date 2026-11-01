"""Re-adding a catalog dataset heals a layer whose copy is gone from disk.

The rules are unit-tested in `tests/unit/test_materialize_heal.py`; this runs
the endpoint around them: promote and the catalog mirror are faked, the layer
row, the project and the reset are real.
"""

from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock
from uuid import UUID, uuid4

import pytest
from core.core.config import settings
from core.db.models.layer import Layer
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

S = settings.SCHEMA


@pytest.fixture
def catalog(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> tuple[Path, dict[str, UUID], AsyncMock]:
    """A mirror that resolves any id, a promote that always finds the layer
    already promoted, and a recorder in place of the processes service."""
    (tmp_path / "mirror_items.parquet").write_bytes(b"")
    layers_dir = tmp_path / "layers"
    layers_dir.mkdir()
    monkeypatch.setattr(settings, "CATALOG_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(settings, "CATALOG_LAYERS_DIR", str(layers_dir))

    promoted: dict[str, UUID] = {}

    async def promote(conn: Any, catalog_id: str, **_: Any) -> dict[str, Any]:
        return {"layer_id": str(promoted[catalog_id]), "created": False}

    monkeypatch.setattr("goatlib.catalog.promote.promote", promote)
    monkeypatch.setattr(
        "goatlib.catalog.promote.resolve_item_ids", lambda mirror, ids: list(ids)
    )
    monkeypatch.setattr(
        "goatlib.catalog.promote.read_items",
        lambda mirror, ids: {i: {} for i in ids},
    )
    enqueue = AsyncMock()
    monkeypatch.setattr("core.endpoints.v2.project_layer.execute_process", enqueue)
    return layers_dir, promoted, enqueue


async def _project_with_ready_catalog_layer(
    client: AsyncClient, db: AsyncSession, me: UUID, home_folder_id: UUID
) -> tuple[UUID, UUID]:
    created = await client.post(
        f"{settings.API_V2_STR}/project",
        json={
            "name": "catalog heal",
            "folder_id": str(home_folder_id),
            "initial_view_state": {
                "latitude": 48.1502132,
                "longitude": 11.5696284,
                "zoom": 12,
                "min_zoom": 0,
                "max_zoom": 20,
                "bearing": 0,
                "pitch": 0,
            },
        },
    )
    assert created.status_code in (200, 201), created.text
    project_id = UUID(created.json()["id"])
    layer = Layer(
        id=uuid4(),
        user_id=me,
        folder_id=home_folder_id,
        name="catalog layer",
        type="feature",
        feature_layer_type="standard",
        feature_layer_geometry_type="polygon",
        other_properties={
            "catalog_materialize": {
                "status": "ready",
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        },
    )
    db.add(layer)
    layer_id = layer.id
    await db.commit()
    linked = await client.post(
        f"{settings.API_V2_STR}/project/{project_id}/layer",
        params={"layer_ids": [str(layer_id)]},
    )
    assert linked.status_code == 200, linked.text
    return project_id, layer_id


async def _materialize_doc(db: AsyncSession, layer_id: UUID) -> dict[str, Any]:
    doc = (
        await db.execute(
            text(
                f"SELECT other_properties->'catalog_materialize' "
                f"FROM {S}.layer WHERE id = :id"
            ),
            {"id": str(layer_id)},
        )
    ).scalar_one()
    assert isinstance(doc, dict)
    return doc


async def _links(db: AsyncSession, project_id: UUID, layer_id: UUID) -> int:
    count = (
        await db.execute(
            text(
                f"SELECT count(*) FROM {S}.layer_project "
                f"WHERE project_id = :p AND layer_id = :l"
            ),
            {"p": str(project_id), "l": str(layer_id)},
        )
    ).scalar_one()
    return int(count)


@pytest.mark.asyncio
async def test_a_ready_layer_without_its_file_is_materialized_again(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: Any,
    fixture_get_home_folder: dict[str, Any],
    catalog: tuple[Path, dict[str, UUID], AsyncMock],
) -> None:
    _, promoted, enqueue = catalog
    project_id, layer_id = await _project_with_ready_catalog_layer(
        client, db_session, fixture_create_user, fixture_get_home_folder["id"]
    )
    promoted["item-1"] = layer_id

    response = await client.post(
        f"{settings.API_V2_STR}/project/{project_id}/layer-catalog",
        params={"catalog_ids": ["item-1"]},
    )

    assert response.status_code == 200, response.text
    enqueue.assert_awaited_once()
    assert enqueue.await_args is not None
    assert enqueue.await_args.kwargs["process_id"] == "catalog_materialize"
    assert enqueue.await_args.kwargs["inputs"] == {"layer_id": str(layer_id)}
    doc = await _materialize_doc(db_session, layer_id)
    assert doc["status"] == "pending"
    assert doc["heal_reason"] == "ready, file missing"
    # The broken entry is reused, not joined by a twin.
    assert await _links(db_session, project_id, layer_id) == 1
    assert [entry["layer_id"] for entry in response.json()] == [str(layer_id)]


@pytest.mark.asyncio
async def test_a_ready_layer_with_its_file_is_left_alone(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: Any,
    fixture_get_home_folder: dict[str, Any],
    catalog: tuple[Path, dict[str, UUID], AsyncMock],
) -> None:
    layers_dir, promoted, enqueue = catalog
    project_id, layer_id = await _project_with_ready_catalog_layer(
        client, db_session, fixture_create_user, fixture_get_home_folder["id"]
    )
    promoted["item-1"] = layer_id
    (layers_dir / f"t_{layer_id.hex}.parquet").write_bytes(b"PAR1")

    response = await client.post(
        f"{settings.API_V2_STR}/project/{project_id}/layer-catalog",
        params={"catalog_ids": ["item-1"]},
    )

    assert response.status_code == 200, response.text
    enqueue.assert_not_awaited()
    assert (await _materialize_doc(db_session, layer_id))["status"] == "ready"
