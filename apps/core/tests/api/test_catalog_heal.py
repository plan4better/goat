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
    promoted_v1 = dict(promoted)
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
        lambda mirror, datasets: {"plan": ("xplan", "Bebauungsplan 1", None)},
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
    # A version the publisher gives the plan is used as it is.
    assert bundle_versions_of(
        {"m": {"collection": "plan", "version": "1"}},
        {"plan": ("xplan", "Bebauungsplan 1", "7")},
    ) == {"plan": "7"}
    assert set(keys) == {plan_version}

    again = await client.post(
        f"{settings.API_V2_STR}/project/{first}/layer-catalog",
        params={"catalog_ids": ["plan"]},
    )
    assert again.status_code == 409

    # Anyone reads the shared bundle, though it has no folder.
    read = await client.get(f"{settings.API_V2_STR}/bundle/{bundle_id}")
    assert read.status_code == 200, read.text
    assert read.json()["folder_id"] is None

    # A bundle that lost its members (catalog cleanup) gets them back on the next add.
    await db_session.execute(
        text(f"DELETE FROM {S}.bundle_layer WHERE bundle_id = :b"), {"b": bundle_id}
    )
    await db_session.commit()
    third = await project()
    readded = await client.post(
        f"{settings.API_V2_STR}/project/{third}/layer-catalog",
        params={"catalog_ids": ["plan"]},
    )
    assert readded.status_code == 200, readded.text
    assert len(readded.json()) == len(members)

    member_alone = await client.post(
        f"{settings.API_V2_STR}/project/{first}/layer-catalog",
        params={"catalog_ids": ["m-text"]},
    )
    assert member_alone.status_code == 400
    assert "added whole" in member_alone.json()["detail"]

    # A member moves with its bundle, never alone.
    member_link = (
        await db_session.execute(
            text(
                f"SELECT lp.id FROM {S}.layer_project lp JOIN {S}.layer_project_group g "
                "ON g.id = lp.layer_project_group_id WHERE g.bundle_id = :b LIMIT 1"
            ),
            {"b": bundle_id},
        )
    ).scalar_one()
    alone = await client.post(
        f"{settings.API_V2_STR}/project/{first}/catalog-update",
        json={"layer_project_id": member_link},
    )
    assert alone.status_code == 400
    assert "Bebauungsplan 1" in alone.json()["detail"]

    # A newer version moves the whole group by role: m-area changed, m-new
    # appeared, m-text left. The other project keeps the old version.
    def member_layer(name: str) -> Layer:
        return Layer(
            id=uuid4(),
            name=name,
            type="table",
            other_properties={"catalog_materialize": {"status": "ready"}},
        )

    new_area, new_new = member_layer("m-area v2"), member_layer("m-new")
    db_session.add_all([new_area, new_new])
    await db_session.commit()
    promoted["m-area"], promoted["m-new"] = new_area.id, new_new.id
    members_v2 = {"m-area": "BP_BaugebietsTeilFlaeche", "m-new": "BP_GruenFlaeche"}
    versions_v2 = {"m-area": "2", "m-new": "1"}
    monkeypatch.setattr(
        "goatlib.catalog.promote.resolve_item_ids",
        lambda mirror, ids: [
            m for i in ids for m in (members_v2 if i == "plan" else [i])
        ],
    )
    monkeypatch.setattr(
        "goatlib.catalog.promote.read_items",
        lambda mirror, ids: {
            i: {
                "collection": "plan",
                "goat:role": members_v2[i],
                "version": versions_v2[i],
            }
            for i in ids
        },
    )

    async def rows(sql: str, **params: Any) -> list[Any]:
        return list((await db_session.execute(text(sql), params)).all())

    (group_id,) = (
        await rows(
            f"SELECT id FROM {S}.layer_project_group WHERE project_id = :p",
            p=str(first),
        )
    )[0]
    area_link = (
        await rows(
            f"SELECT id FROM {S}.layer_project WHERE project_id = :p AND layer_id = :l",
            p=str(first),
            l=str(promoted_v1["m-area"]),
        )
    )[0][0]
    moved = await client.post(
        f"{settings.API_V2_STR}/project/{first}/catalog-update",
        json={"group_id": group_id},
    )
    assert moved.status_code == 200, moved.text
    entries = dict(
        await rows(
            f"SELECT layer_id, id FROM {S}.layer_project WHERE layer_project_group_id = :g",
            g=group_id,
        )
    )
    assert set(entries) == {new_area.id, new_new.id}
    assert entries[new_area.id] == area_link
    new_bundle = (
        await rows(
            f"SELECT bundle_id FROM {S}.layer_project_group WHERE id = :g", g=group_id
        )
    )[0][0]
    assert new_bundle != bundle_id
    assert (
        await rows(
            f"SELECT bundle_id FROM {S}.layer_project_group WHERE project_id = :p",
            p=str(second),
        )
    )[0][0] == bundle_id

    # A version with a member that has no role cannot be matched: refused.
    monkeypatch.setattr(
        "goatlib.catalog.promote.read_items",
        lambda mirror, ids: {
            i: {
                "collection": "plan",
                "goat:role": None if i == "m-new" else members_v2[i],
                "version": "3",
            }
            for i in ids
        },
    )
    roleless = await client.post(
        f"{settings.API_V2_STR}/project/{first}/catalog-update",
        json={"group_id": group_id},
    )
    assert roleless.status_code == 400
    assert "role" in roleless.json()["detail"]

    # Two updates at once: the one that finds the group already moved answers 409.
    monkeypatch.setattr(
        "goatlib.catalog.promote.read_items",
        lambda mirror, ids: {
            i: {"collection": "plan", "goat:role": members_v2[i], "version": "3"}
            for i in ids
        },
    )

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
    late = await client.post(
        f"{settings.API_V2_STR}/project/{first}/catalog-update",
        json={"group_id": group_id},
    )
    assert late.status_code == 409


async def test_a_catalog_layer_moves_to_its_new_version_in_place(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_get_home_folder: dict[str, Any],
    catalog: tuple[Path, dict[str, UUID], AsyncMock],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The entry keeps its id, name, order and filter and points at the new
    version's layer; an untouched style follows the catalog, an edited one is
    kept; another entry of the same dataset stays; a second update is a 409."""
    _, promoted, enqueue = catalog

    def catalog_layer(version: str, copy: str = "ready") -> Layer:
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
    old, new = catalog_layer("1", copy="failed"), catalog_layer("2")
    db_session.add_all([old, new])
    await db_session.commit()
    promoted["item-u"] = new.id
    monkeypatch.setattr(
        "goatlib.catalog.promote.read_items",
        lambda mirror, ids: {
            i: {"id": i, "version": "2", "goat:geometryType": "line"} for i in ids
        },
    )

    created = await client.post(
        f"{settings.API_V2_STR}/project",
        json={"name": "update", "folder_id": str(fixture_get_home_folder["id"])},
    )
    project_id = created.json()["id"]
    links = []
    for _ in range(2):
        linked = await client.post(
            f"{settings.API_V2_STR}/project/{project_id}/layer",
            params={"layer_ids": [str(old.id)]},
        )
        links.append(linked.json()[0]["id"])
    edited, untouched = links

    async def scalar(sql: str, **params: Any) -> Any:
        return (await db_session.execute(text(sql), params)).scalar_one()

    await db_session.execute(
        text(
            f"UPDATE {S}.layer_style SET document = document || '{{\"edited\": true}}' "
            f"WHERE id = (SELECT active_style_id FROM {S}.layer_project WHERE id = :l)"
        ),
        {"l": edited},
    )
    # Written by the system, not the user (a style check): still "untouched".
    await db_session.execute(
        text(
            f"UPDATE {S}.layer_style SET document = document || "
            f'\'{{"computed": {{"no_data": true}}}}\' '
            f"WHERE id = (SELECT active_style_id FROM {S}.layer_project WHERE id = :l)"
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
    before = await scalar(
        f'SELECT name || ord::text FROM (SELECT name, "order" AS ord '
        f"FROM {S}.layer_project WHERE id = :l) x",
        l=untouched,
    )

    url = f"{settings.API_V2_STR}/project/{project_id}/catalog-update"
    for link in (untouched, edited):
        moved = await client.post(url, json={"layer_project_id": link})
        assert moved.status_code == 200, moved.text
        assert [row["id"] for row in moved.json()] == [link]
        if link == untouched:
            # The other entry of the same dataset stays on its version.
            assert (
                await scalar(
                    f"SELECT layer_id FROM {S}.layer_project WHERE id = :l", l=edited
                )
                == old.id
            )
    for link in (untouched, edited):
        assert (
            await scalar(
                f"SELECT layer_id FROM {S}.layer_project WHERE id = :l", l=link
            )
            == new.id
        )
    after = await scalar(
        f'SELECT name || ord::text FROM (SELECT name, "order" AS ord '
        f"FROM {S}.layer_project WHERE id = :l) x",
        l=untouched,
    )
    assert after == before

    def active_style(link: int) -> str:
        return (
            f"SELECT s.document FROM {S}.layer_style s JOIN {S}.layer_project lp "
            f"ON s.id = lp.active_style_id WHERE lp.id = {int(link)}"
        )

    assert (await scalar(active_style(untouched))).get("v") == 2
    # What the entry copied from its layer follows the new version too.
    assert (
        await scalar(
            f"SELECT other_properties->'layers' FROM {S}.layer_project WHERE id = :l",
            l=untouched,
        )
    ) == ["wms-layer-v2"]
    assert (await scalar(active_style(edited))).get("edited") is True
    assert enqueue.await_count >= 1

    again = await client.post(url, json={"layer_project_id": untouched})
    assert again.status_code == 409

    # Two updates at once: the one that finds the entry already moved answers 409.
    raced = (
        await client.post(
            f"{settings.API_V2_STR}/project/{project_id}/layer",
            params={"layer_ids": [str(old.id)]},
        )
    ).json()[0]["id"]

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
    late = await client.post(url, json={"layer_project_id": raced})
    assert late.status_code == 409

    # A new version of another kind (line to polygon) is refused: the kept
    # style and filter would not fit it.
    reshaped = (
        await client.post(
            f"{settings.API_V2_STR}/project/{project_id}/layer",
            params={"layer_ids": [str(old.id)]},
        )
    ).json()[0]["id"]
    monkeypatch.setattr(
        "goatlib.catalog.promote.read_items",
        lambda mirror, ids: {
            i: {"id": i, "version": "3", "goat:geometryType": "polygon"} for i in ids
        },
    )
    other_kind = await client.post(url, json={"layer_project_id": reshaped})
    assert other_kind.status_code == 400
    assert "add it again" in other_kind.json()["detail"]
