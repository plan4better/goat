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
from goatlib.catalog.promote import bundle_version
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
    monkeypatch.setattr("core.services.processes.execute_process", enqueue)
    return layers_dir, promoted, enqueue


async def _project_with_ready_catalog_layer(
    client: AsyncClient,
    db: AsyncSession,
    me: UUID,
    home_folder_id: UUID,
    *,
    raster: bool = False,
    status: str = "ready",
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
    shape: dict[str, Any] = (
        {"type": "raster"}
        if raster
        else {
            "type": "feature",
            "feature_layer_type": "standard",
            "feature_layer_geometry_type": "polygon",
        }
    )
    layer = Layer(
        id=uuid4(),
        user_id=me,
        folder_id=home_folder_id,
        name="catalog layer",
        **shape,
        other_properties={
            "catalog_materialize": {
                "status": status,
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


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "reason"), [("failed", "failed"), ("ready", "ready, file missing")]
)
async def test_a_raster_layer_without_its_copy_is_materialized_again(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: Any,
    fixture_get_home_folder: dict[str, Any],
    catalog: tuple[Path, dict[str, UUID], AsyncMock],
    status: str,
    reason: str,
) -> None:
    """A catalog raster failed for good before the job could copy one; re-adding
    it now runs the job again in the entry already in the project."""
    _, promoted, enqueue = catalog
    project_id, layer_id = await _project_with_ready_catalog_layer(
        client,
        db_session,
        fixture_create_user,
        fixture_get_home_folder["id"],
        raster=True,
        status=status,
    )
    promoted["item-1"] = layer_id

    response = await client.post(
        f"{settings.API_V2_STR}/project/{project_id}/layer-catalog",
        params={"catalog_ids": ["item-1"]},
    )

    assert response.status_code == 200, response.text
    enqueue.assert_awaited_once()
    assert enqueue.await_args is not None
    assert enqueue.await_args.kwargs["inputs"] == {"layer_id": str(layer_id)}
    doc = await _materialize_doc(db_session, layer_id)
    assert doc["status"] == "pending" and doc["heal_reason"] == reason
    assert await _links(db_session, project_id, layer_id) == 1


@pytest.mark.asyncio
async def test_a_ready_raster_layer_with_its_copy_is_left_alone(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: Any,
    fixture_get_home_folder: dict[str, Any],
    catalog: tuple[Path, dict[str, UUID], AsyncMock],
) -> None:
    layers_dir, promoted, enqueue = catalog
    project_id, layer_id = await _project_with_ready_catalog_layer(
        client,
        db_session,
        fixture_create_user,
        fixture_get_home_folder["id"],
        raster=True,
    )
    promoted["item-1"] = layer_id
    (layers_dir / f"t_{layer_id.hex}.tif").write_bytes(b"II*\x00")

    response = await client.post(
        f"{settings.API_V2_STR}/project/{project_id}/layer-catalog",
        params={"catalog_ids": ["item-1"]},
    )

    assert response.status_code == 200, response.text
    enqueue.assert_not_awaited()
    assert (await _materialize_doc(db_session, layer_id))["status"] == "ready"


@pytest.mark.asyncio
async def test_a_map_service_layer_is_never_materialized(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: Any,
    fixture_get_home_folder: dict[str, Any],
    catalog: tuple[Path, dict[str, UUID], AsyncMock],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A WMS/WMTS has no file by design: "ready without its file" is not a heal."""
    _, promoted, enqueue = catalog
    project_id, layer_id = await _project_with_ready_catalog_layer(
        client, db_session, fixture_create_user, fixture_get_home_folder["id"]
    )

    async def promote(conn: Any, catalog_id: str, **_: Any) -> dict[str, Any]:
        return {"layer_id": str(layer_id), "created": False, "materialize": False}

    monkeypatch.setattr("goatlib.catalog.promote.promote", promote)

    response = await client.post(
        f"{settings.API_V2_STR}/project/{project_id}/layer-catalog",
        params={"catalog_ids": ["item-1"]},
    )

    assert response.status_code == 200, response.text
    enqueue.assert_not_awaited()


@pytest.mark.asyncio
async def test_an_xplan_plan_is_added_whole_as_one_shared_bundle(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_get_home_folder: dict[str, Any],
    catalog: tuple[Path, dict[str, UUID], AsyncMock],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The first add makes one bundle without owner of its promoted layers, each
    with its role; any later add reuses it; a single member is refused, and so
    is the plan again in a project that has it. Members are promoted under the
    plan's version, so a newer plan never shares a layer with an older one."""
    _, promoted, _ = catalog
    keys: list[str | None] = []

    async def promote(conn: Any, catalog_id: str, **kw: Any) -> dict[str, Any]:
        keys.append(kw.get("version"))
        return {"layer_id": str(promoted[catalog_id]), "created": False}

    monkeypatch.setattr("goatlib.catalog.promote.promote", promote)
    members = {"m-area": "BP_BaugebietsTeilFlaeche", "m-text": "text"}
    for item_id in members:
        layer = Layer(
            id=uuid4(),
            name=item_id,
            type="table",
            catalog_external_uid=item_id,
            catalog_version="1",
            other_properties={"catalog_materialize": {"status": "ready"}},
        )
        db_session.add(layer)
        promoted[item_id] = layer.id
    await db_session.commit()
    monkeypatch.setattr(
        "goatlib.catalog.promote.resolve_item_ids",
        lambda mirror, ids: [m for i in ids for m in (members if i == "plan" else [i])],
    )
    monkeypatch.setattr(
        "goatlib.catalog.promote.read_items",
        lambda mirror, ids: {
            i: {"collection": "plan", "goat:role": members[i], "version": "1"}
            for i in ids
        },
    )
    monkeypatch.setattr(
        "goatlib.catalog.promote.typed_datasets",
        lambda mirror, datasets: {"plan": ("xplan", "Bebauungsplan 1")},
    )

    async def project() -> UUID:
        created = await client.post(
            f"{settings.API_V2_STR}/project",
            json={"name": "plan", "folder_id": str(fixture_get_home_folder["id"])},
        )
        assert created.status_code in (200, 201), created.text
        return UUID(created.json()["id"])

    first, second = await project(), await project()
    for project_id in (first, second):
        added = await client.post(
            f"{settings.API_V2_STR}/project/{project_id}/layer-catalog",
            params={"catalog_ids": ["plan"]},
        )
        assert added.status_code == 200, added.text

    bundles = (
        await db_session.execute(
            text(
                f"SELECT id, bundle_type, user_id, space_id FROM {S}.bundle "
                "WHERE catalog_external_uid = 'plan'"
            )
        )
    ).all()
    assert len(bundles) == 1
    bundle_id, kind, owner, space = bundles[0]
    assert (kind, owner, space) == ("xplan", None, None)
    roles = (
        await db_session.execute(
            text(f"SELECT role FROM {S}.bundle_layer WHERE bundle_id = :b"),
            {"b": bundle_id},
        )
    ).scalars()
    assert sorted(roles) == sorted(members.values())
    groups = (
        await db_session.execute(
            text(f"SELECT count(*) FROM {S}.layer_project_group WHERE bundle_id = :b"),
            {"b": bundle_id},
        )
    ).scalar_one()
    assert groups == 2, "one locked group in each project, one shared bundle"
    plan_version = bundle_version([(m, "1") for m in members])
    assert set(keys) == {f"1@{plan_version}"}

    again = await client.post(
        f"{settings.API_V2_STR}/project/{first}/layer-catalog",
        params={"catalog_ids": ["plan"]},
    )
    assert again.status_code == 409

    member_alone = await client.post(
        f"{settings.API_V2_STR}/project/{first}/layer-catalog",
        params={"catalog_ids": ["m-text"]},
    )
    assert member_alone.status_code == 400
    assert "added whole" in member_alone.json()["detail"]
