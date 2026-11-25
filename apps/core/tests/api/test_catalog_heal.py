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
import pytest_asyncio
from core.core.config import settings
from core.db.models._link_model import LayerProjectGroup
from core.db.models.bundle import Bundle
from core.db.models.layer import Layer
from core.services.catalog_promote import bundle_versions_of
from goatlib.catalog.promote import bundle_version
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

S = settings.SCHEMA


@pytest_asyncio.fixture(autouse=True)
async def no_projects_left(db_session: AsyncSession) -> Any:
    """These tests give the shared default user projects; they go with the test,
    or a later test of that user in the same worker finds them."""
    before = set(
        (await db_session.execute(text(f"SELECT id FROM {S}.project"))).scalars()
    )
    yield
    await db_session.rollback()
    await db_session.execute(
        text(f"DELETE FROM {S}.project WHERE NOT (id = ANY(:before))"),
        {"before": list(before)},
    )
    await db_session.commit()


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


async def _value(db: AsyncSession, sql: str, **params: Any) -> Any:
    return (await db.execute(text(sql), params)).scalar_one()


async def _new_project(client: AsyncClient, folder: dict[str, Any]) -> str:
    created = await client.post(
        f"{settings.API_V2_STR}/project",
        json={"name": "catalog", "folder_id": str(folder["id"])},
    )
    assert created.status_code in (200, 201), created.text
    return str(created.json()["id"])


async def _add(client: AsyncClient, project: str, *catalog_ids: str) -> Any:
    return await client.post(
        f"{settings.API_V2_STR}/project/{project}/layer-catalog",
        params={"catalog_ids": list(catalog_ids)},
    )


async def _update(client: AsyncClient, project: str, **target: int) -> Any:
    return await client.post(
        f"{settings.API_V2_STR}/project/{project}/catalog-update", json=target
    )


def _plan_in_catalog(
    monkeypatch: pytest.MonkeyPatch, roles: dict[str, str | None], version: str
) -> None:
    """The mirror holds plan `plan` with these members (item id: role)."""
    monkeypatch.setattr(
        "goatlib.catalog.promote.resolve_item_ids",
        lambda mirror, ids: [m for i in ids for m in (roles if i == "plan" else [i])],
    )
    monkeypatch.setattr(
        "goatlib.catalog.promote.read_items",
        lambda mirror, ids: {
            i: {"collection": "plan", "goat:role": roles[i], "version": version}
            for i in ids
        },
    )
    monkeypatch.setattr(
        "goatlib.catalog.promote.typed_datasets",
        lambda mirror, datasets: {"plan": ("xplan", "Bebauungsplan 1", None)},
    )


def _table_layer(name: str) -> Layer:
    return Layer(
        id=uuid4(),
        name=name,
        type="table",
        catalog_external_uid=name,
        catalog_version="1",
        other_properties={"catalog_materialize": {"status": "ready"}},
    )


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
    is the plan again in a project that has it. A newer plan version moves the
    whole group, member by role."""
    _, promoted, _ = catalog
    keys: list[str | None] = []

    async def promote(conn: Any, catalog_id: str, **kw: Any) -> dict[str, Any]:
        keys.append(kw.get("version"))
        return {"layer_id": str(promoted[catalog_id]), "created": False}

    monkeypatch.setattr("goatlib.catalog.promote.promote", promote)
    roles = {"m-area": "BP_BaugebietsTeilFlaeche", "m-text": "text"}
    v1 = {item_id: _table_layer(item_id) for item_id in roles}
    db_session.add_all(v1.values())
    await db_session.commit()
    promoted.update({item_id: layer.id for item_id, layer in v1.items()})
    _plan_in_catalog(monkeypatch, roles, "1")

    first = await _new_project(client, fixture_get_home_folder)
    second = await _new_project(client, fixture_get_home_folder)
    for project in (first, second):
        added = await _add(client, project, "plan")
        assert added.status_code == 200, added.text

    bundle_id, kind, owner, space = (
        await db_session.execute(
            text(
                f"SELECT id, bundle_type, user_id, space_id FROM {S}.bundle "
                "WHERE catalog_external_uid = 'plan'"
            )
        )
    ).one()
    assert (kind, owner, space) == ("xplan", None, None)
    stored = (
        await db_session.execute(
            text(f"SELECT role FROM {S}.bundle_layer WHERE bundle_id = :b"),
            {"b": bundle_id},
        )
    ).scalars()
    assert sorted(stored) == sorted(roles.values())
    assert (
        await _value(
            db_session,
            f"SELECT count(*) FROM {S}.layer_project_group WHERE bundle_id = :b",
            b=bundle_id,
        )
        == 2
    ), "one locked group in each project, one shared bundle"
    # Members are keyed by the plan's version; one the publisher gives is used as is.
    assert set(keys) == {bundle_version([(m, "1") for m in roles])}
    assert bundle_versions_of(
        {"m": {"collection": "plan", "version": "1"}},
        {"plan": ("xplan", "Bebauungsplan 1", "7")},
    ) == {"plan": "7"}

    assert (await _add(client, first, "plan")).status_code == 409
    # Anyone reads the shared bundle, though it has no folder.
    read = await client.get(f"{settings.API_V2_STR}/bundle/{bundle_id}")
    assert read.status_code == 200, read.text
    assert read.json()["folder_id"] is None

    # A bundle that lost its members (catalog cleanup) gets them back on the next add.
    await db_session.execute(
        text(f"DELETE FROM {S}.bundle_layer WHERE bundle_id = :b"), {"b": bundle_id}
    )
    await db_session.commit()
    readded = await _add(
        client, await _new_project(client, fixture_get_home_folder), "plan"
    )
    assert readded.status_code == 200, readded.text
    assert len(readded.json()) == len(roles)

    # Members go in and move with their bundle, never alone.
    alone = await _add(client, first, "m-text")
    assert alone.status_code == 400
    assert "added whole" in alone.json()["detail"]
    group_id = await _value(
        db_session,
        f"SELECT id FROM {S}.layer_project_group WHERE project_id = :p",
        p=first,
    )
    area_link = await _value(
        db_session,
        f"SELECT id FROM {S}.layer_project WHERE layer_project_group_id = :g "
        "AND layer_id = :l",
        g=group_id,
        l=v1["m-area"].id,
    )
    alone = await _update(client, first, layer_project_id=area_link)
    assert alone.status_code == 400
    assert "Bebauungsplan 1" in alone.json()["detail"]

    # A newer version moves the whole group by role: m-area changed, m-new
    # appeared, m-text left. The other project keeps the old version.
    v2 = {"m-area": _table_layer("m-area v2"), "m-new": _table_layer("m-new")}
    db_session.add_all(v2.values())
    await db_session.commit()
    promoted.update({item_id: layer.id for item_id, layer in v2.items()})
    roles_v2 = {"m-area": "BP_BaugebietsTeilFlaeche", "m-new": "BP_GruenFlaeche"}
    _plan_in_catalog(monkeypatch, roles_v2, "2")
    moved = await _update(client, first, group_id=group_id)
    assert moved.status_code == 200, moved.text
    entries = dict(
        (
            await db_session.execute(
                text(
                    f"SELECT layer_id, id FROM {S}.layer_project "
                    "WHERE layer_project_group_id = :g"
                ),
                {"g": group_id},
            )
        ).all()
    )
    assert entries == {
        v2["m-area"].id: area_link,
        v2["m-new"].id: entries[v2["m-new"].id],
    }
    group_bundle = (
        f"SELECT bundle_id FROM {S}.layer_project_group WHERE project_id = :p"
    )
    assert await _value(db_session, group_bundle, p=first) != bundle_id
    assert await _value(db_session, group_bundle, p=second) == bundle_id
    newest = await _update(client, first, group_id=group_id)
    assert newest.status_code == 409
    assert "already on the newest version" in newest.json()["detail"]

    # Entries move by role, so a version with a member without one is refused.
    _plan_in_catalog(monkeypatch, {**roles_v2, "m-new": None}, "3")
    roleless = await _update(client, first, group_id=group_id)
    assert roleless.status_code == 400
    assert "role" in roleless.json()["detail"]

    # Two updates at once: the one that finds the group already moved answers 409.
    _plan_in_catalog(monkeypatch, roles_v2, "3")

    async def promote_while_another_moves_it(
        conn: Any, catalog_id: str, **_: Any
    ) -> dict[str, Any]:
        await conn.execute(
            f"UPDATE {S}.layer_project_group SET bundle_id = $1 WHERE id = $2",
            bundle_id,
            group_id,
        )
        return {"layer_id": str(promoted[catalog_id]), "created": False}

    monkeypatch.setattr(
        "goatlib.catalog.promote.promote", promote_while_another_moves_it
    )
    assert (await _update(client, first, group_id=group_id)).status_code == 409


async def test_a_catalog_layer_moves_to_its_new_version_in_place(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_get_home_folder: dict[str, Any],
    catalog: tuple[Path, dict[str, UUID], AsyncMock],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The entry keeps its id, name and order and points at the new version's
    layer, with what it copied from that layer; an untouched style follows the
    catalog, an edited one is kept; another entry of the same dataset stays; a
    second update is a 409, and a new version of another kind is refused."""
    _, promoted, enqueue = catalog

    def catalog_layer(version: str, copy: str) -> Layer:
        return Layer(
            id=uuid4(),
            name="Radwege",
            type="feature",
            feature_layer_type="standard",
            feature_layer_geometry_type="line",
            catalog_external_uid="item-u",
            catalog_version=version,
            other_properties={
                "catalog_item": {"id": "item-u", "version": version},
                "catalog_materialize": {"status": copy},
                "layers": [f"wms-layer-v{version}"],
            },
        )

    # The old copy failed: the entry still moves.
    old, new = catalog_layer("1", "failed"), catalog_layer("2", "ready")
    db_session.add_all([old, new])
    await db_session.commit()
    promoted["item-u"] = new.id
    monkeypatch.setattr(
        "goatlib.catalog.promote.read_items",
        lambda mirror, ids: {
            i: {"id": i, "version": "2", "goat:geometryType": "line"} for i in ids
        },
    )
    project = await _new_project(client, fixture_get_home_folder)

    async def entry() -> int:
        linked = await client.post(
            f"{settings.API_V2_STR}/project/{project}/layer",
            params={"layer_ids": [str(old.id)]},
        )
        return int(linked.json()[0]["id"])

    edited, untouched = await entry(), await entry()
    active = f"SELECT active_style_id FROM {S}.layer_project WHERE id = :l"
    await db_session.execute(
        text(
            f"UPDATE {S}.layer_style SET document = document || "
            f"'{{\"edited\": true}}' WHERE id = ({active})"
        ),
        {"l": edited},
    )
    # Written by the system, not the user (a style check): still "untouched".
    await db_session.execute(
        text(
            f"UPDATE {S}.layer_style SET document = document || "
            f'\'{{"computed": {{"no_data": true}}}}\' WHERE id = ({active})'
        ),
        {"l": untouched},
    )
    await db_session.execute(
        text(
            f"INSERT INTO {S}.layer_style (layer_id, name, document) SELECT :new, name, "
            f"document || '{{\"v\": 2}}' FROM {S}.layer_style WHERE layer_id = :old"
        ),
        {"new": str(new.id), "old": str(old.id)},
    )
    await db_session.commit()
    entry_sql = (
        f'SELECT layer_id::text || name || "order"::text FROM {S}.layer_project '
        "WHERE id = :l"
    )
    before = await _value(db_session, entry_sql, l=untouched)

    moved = await _update(client, project, layer_project_id=untouched)
    assert moved.status_code == 200, moved.text
    assert [row["id"] for row in moved.json()] == [untouched]
    layer_of = f"SELECT layer_id FROM {S}.layer_project WHERE id = :l"
    # The other entry of the same dataset stays on its version.
    assert await _value(db_session, layer_of, l=edited) == old.id
    assert (await _update(client, project, layer_project_id=edited)).status_code == 200
    for link in (untouched, edited):
        assert await _value(db_session, layer_of, l=link) == new.id
    after = await _value(db_session, entry_sql, l=untouched)
    assert after == before.replace(str(old.id), str(new.id))
    assert enqueue.await_count >= 1

    style = (
        f"SELECT s.document FROM {S}.layer_style s JOIN {S}.layer_project lp "
        "ON s.id = lp.active_style_id WHERE lp.id = :l"
    )
    assert (await _value(db_session, style, l=untouched)).get("v") == 2
    assert (await _value(db_session, style, l=edited)).get("edited") is True
    copied = f"SELECT other_properties->'layers' FROM {S}.layer_project WHERE id = :l"
    assert await _value(db_session, copied, l=untouched) == ["wms-layer-v2"]

    newest = await _update(client, project, layer_project_id=untouched)
    assert newest.status_code == 409
    assert "already on the newest version" in newest.json()["detail"]

    # Two updates at once: the one that finds the entry already moved answers 409.
    raced = await entry()

    async def promote_while_another_moves_it(
        conn: Any, catalog_id: str, **_: Any
    ) -> dict[str, Any]:
        await conn.execute(
            f"UPDATE {S}.layer_project SET layer_id = $1 WHERE id = $2", new.id, raced
        )
        return {"layer_id": str(new.id), "created": False}

    monkeypatch.setattr(
        "goatlib.catalog.promote.promote", promote_while_another_moves_it
    )
    assert (await _update(client, project, layer_project_id=raced)).status_code == 409

    # A new version of another kind (line to polygon) is refused: the kept
    # style and filter would not fit it.
    reshaped = await entry()
    monkeypatch.setattr(
        "goatlib.catalog.promote.read_items",
        lambda mirror, ids: {
            i: {"id": i, "version": "3", "goat:geometryType": "polygon"} for i in ids
        },
    )
    other_kind = await _update(client, project, layer_project_id=reshaped)
    assert other_kind.status_code == 400
    assert "add it again" in other_kind.json()["detail"]
    assert await _value(db_session, layer_of, l=reshaped) == old.id


async def test_a_new_version_whose_map_service_cannot_be_drawn_is_refused(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_get_home_folder: dict[str, Any],
    catalog: tuple[Path, dict[str, UUID], AsyncMock],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The update checks a map service's link before it promotes anything, as the
    add does: 400, and the entry stays on its layer."""
    _, promoted, _ = catalog

    def service_layer(version: str) -> Layer:
        return Layer(
            id=uuid4(),
            name="Luftbild",
            type="raster",
            catalog_external_uid="item-w",
            catalog_version=version,
            other_properties={"catalog_item": {"id": "item-w", "version": version}},
        )

    old, new = service_layer("1"), service_layer("2")
    db_session.add_all([old, new])
    await db_session.commit()
    promoted["item-w"] = new.id
    # A WMS without a `rel=wms` link.
    monkeypatch.setattr(
        "goatlib.catalog.promote.read_items",
        lambda mirror, ids: {
            i: {"id": i, "version": "2", "goat:layerType": "wms"} for i in ids
        },
    )
    project = await _new_project(client, fixture_get_home_folder)
    linked = await client.post(
        f"{settings.API_V2_STR}/project/{project}/layer",
        params={"layer_ids": [str(old.id)]},
    )
    assert linked.status_code == 200, linked.text
    link = int(linked.json()[0]["id"])

    refused = await _update(client, project, layer_project_id=link)
    assert refused.status_code == 400
    assert "rel=wms" in refused.json()["detail"]
    layer_of = f"SELECT layer_id FROM {S}.layer_project WHERE id = :l"
    assert await _value(db_session, layer_of, l=link) == old.id


async def test_a_layer_of_its_own_never_moves_onto_the_catalog_copy(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: Any,
    fixture_get_home_folder: dict[str, Any],
    catalog: tuple[Path, dict[str, UUID], AsyncMock],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A user's own layer that carries a `catalog_item` whose id is in the catalog
    is still not the catalog's copy: its entry is refused and keeps its layer."""
    _, promoted, _ = catalog
    shape: dict[str, Any] = {
        "name": "Radwege",
        "type": "feature",
        "feature_layer_type": "standard",
        "feature_layer_geometry_type": "line",
    }
    own = Layer(
        id=uuid4(),
        user_id=fixture_create_user,
        folder_id=fixture_get_home_folder["id"],
        **shape,
        other_properties={"catalog_item": {"id": "item-o", "version": "1"}},
    )
    shared = Layer(
        id=uuid4(),
        **shape,
        catalog_external_uid="item-o",
        catalog_version="2",
        other_properties={"catalog_item": {"id": "item-o", "version": "2"}},
    )
    db_session.add_all([own, shared])
    await db_session.commit()
    promoted["item-o"] = shared.id
    monkeypatch.setattr(
        "goatlib.catalog.promote.read_items",
        lambda mirror, ids: {
            i: {"id": i, "version": "2", "goat:geometryType": "line"} for i in ids
        },
    )
    project = await _new_project(client, fixture_get_home_folder)
    linked = await client.post(
        f"{settings.API_V2_STR}/project/{project}/layer",
        params={"layer_ids": [str(own.id)]},
    )
    assert linked.status_code == 200, linked.text
    link = int(linked.json()[0]["id"])

    refused = await _update(client, project, layer_project_id=link)
    assert refused.status_code == 400
    assert "not from the catalog" in refused.json()["detail"]
    layer_of = f"SELECT layer_id FROM {S}.layer_project WHERE id = :l"
    assert await _value(db_session, layer_of, l=link) == own.id


async def test_a_group_of_a_bundle_of_its_own_is_not_updated(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: Any,
    fixture_get_home_folder: dict[str, Any],
    catalog: tuple[Path, dict[str, UUID], AsyncMock],
) -> None:
    """A project group of a user's own bundle is not from the catalog: its update
    is refused and its entries keep their layers."""
    home = fixture_get_home_folder["id"]
    bundle = Bundle(
        user_id=fixture_create_user, folder_id=home, name="Plan", bundle_type="xplan"
    )
    own = Layer(
        id=uuid4(), user_id=fixture_create_user, folder_id=home, name="m", type="table"
    )
    db_session.add_all([bundle, own])
    await db_session.commit()
    project = await _new_project(client, fixture_get_home_folder)
    group = LayerProjectGroup(
        name="Plan", project_id=UUID(project), bundle_id=bundle.id
    )
    db_session.add(group)
    await db_session.commit()
    linked = await client.post(
        f"{settings.API_V2_STR}/project/{project}/layer",
        params={"layer_ids": [str(own.id)]},
    )
    assert linked.status_code == 200, linked.text
    link = int(linked.json()[0]["id"])
    await db_session.execute(
        text(f"UPDATE {S}.layer_project SET layer_project_group_id = :g WHERE id = :l"),
        {"g": group.id, "l": link},
    )
    await db_session.commit()

    refused = await _update(client, project, group_id=group.id)
    assert refused.status_code == 400
    assert "not from the catalog" in refused.json()["detail"]
    layer_of = f"SELECT layer_id FROM {S}.layer_project WHERE id = :l"
    assert await _value(db_session, layer_of, l=link) == own.id
