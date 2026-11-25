"""Re-adding a catalog dataset heals a layer whose copy is gone from disk.

The rules are unit-tested in `tests/unit/test_materialize_heal.py`; this runs
the endpoint around them: promote and the catalog mirror are faked, the layer
row, the project and the reset are real.
"""

from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock
from uuid import UUID, uuid4

import pytest
import pytest_asyncio
from core.core.config import settings
from core.db.models._link_model import LayerProjectGroup
from core.db.models.bundle import Bundle
from core.db.models.layer import Layer
from core.db.models.workflow import Workflow
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


def _dataset(node_id: str, link: int | None, layer: UUID) -> dict[str, Any]:
    """A workflow dataset node reading `layer` through project entry `link`."""
    data = {"type": "dataset", "projectLayerId": link, "layerId": str(layer)}
    return {"id": node_id, "type": "dataset", "data": data}


async def _workflow(
    db: AsyncSession, project: str, *datasets: dict[str, Any], tool_layer: UUID
) -> UUID:
    """A workflow of `project` with these dataset nodes and one tool whose
    unconnected layer input holds `tool_layer`."""
    tool = {
        "id": "tool",
        "type": "tool",
        "data": {
            "type": "tool",
            "processId": "buffer",
            "config": {"input_layer_id": str(tool_layer), "distance": 100},
        },
    }
    flow = Workflow(
        project_id=UUID(project),
        name="flow",
        config={"nodes": [*datasets, tool], "edges": []},
    )
    db.add(flow)
    await db.commit()
    assert flow.id is not None
    return flow.id


_REVISION = f"SELECT revision FROM {S}.workflow WHERE id = :id"


async def _read_flow(db: AsyncSession, flow: UUID) -> tuple[dict[str, str], str]:
    """The workflow's dataset nodes' layer ids by node id, and its tool's layer."""
    config = await _value(
        db, f"SELECT config FROM {S}.workflow WHERE id = :id", id=flow
    )
    nodes = config["nodes"]
    return (
        {n["id"]: n["data"]["layerId"] for n in nodes if n["type"] == "dataset"},
        nodes[-1]["data"]["config"]["input_layer_id"],
    )


async def _backdate(db: AsyncSession, table: str, row: UUID, days: int = 2) -> None:
    """Make a layer or bundle look last touched `days` ago, past the grace period."""
    await db.execute(
        text(
            f"UPDATE {S}.{table} SET updated_at = now() - make_interval(days => :days) "
            "WHERE id = :id"
        ),
        {"id": row, "days": days},
    )
    await db.commit()


async def _recent(db: AsyncSession, table: str, row: UUID) -> bool:
    return await _value(
        db,
        f"SELECT updated_at > now() - interval '1 hour' FROM {S}.{table} "
        "WHERE id = :id",
        id=row,
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
    roles = {
        "m-area": "BP_BaugebietsTeilFlaeche",
        "m-road": "BP_StrassenVerkehrsFlaeche",
        "m-text": "text",
    }
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

    # A newer version moves the whole group by role: m-area and m-road changed,
    # m-new appeared, m-text left. The other project keeps the old version.
    v2 = {
        "m-area": _table_layer("m-area v2"),
        "m-road": _table_layer("m-road v2"),
        "m-new": _table_layer("m-new"),
    }
    db_session.add_all(v2.values())
    await db_session.commit()
    promoted.update({item_id: layer.id for item_id, layer in v2.items()})
    roles_v2 = {
        "m-area": "BP_BaugebietsTeilFlaeche",
        "m-road": "BP_StrassenVerkehrsFlaeche",
        "m-new": "BP_GruenFlaeche",
    }
    _plan_in_catalog(monkeypatch, roles_v2, "2")
    member_link = (
        f"SELECT id FROM {S}.layer_project WHERE layer_project_group_id = :g "
        "AND layer_id = :l"
    )
    road_link = await _value(db_session, member_link, g=group_id, l=v1["m-road"].id)
    text_link = await _value(db_session, member_link, g=group_id, l=v1["m-text"].id)
    flow = await _workflow(
        db_session,
        first,
        _dataset("area", area_link, v1["m-area"].id),
        _dataset("road", road_link, v1["m-road"].id),
        _dataset("text", text_link, v1["m-text"].id),
        tool_layer=v1["m-area"].id,
    )
    elsewhere = await _workflow(
        db_session,
        second,
        _dataset("area", None, v1["m-area"].id),
        tool_layer=v1["m-area"].id,
    )
    await _backdate(db_session, "bundle", bundle_id)
    for layer in v1.values():
        await _backdate(db_session, "layer", layer.id)
    moved = await _update(client, first, group_id=group_id)
    assert moved.status_code == 200, moved.text
    # The moved members' nodes and the tool setting follow; the node of the
    # removed member keeps its layer, and the other project's workflow stays.
    assert await _read_flow(db_session, flow) == (
        {
            "area": str(v2["m-area"].id),
            "road": str(v2["m-road"].id),
            "text": str(v1["m-text"].id),
        },
        str(v2["m-area"].id),
    )
    assert await _value(db_session, _REVISION, id=flow) == 2
    assert await _read_flow(db_session, elsewhere) == (
        {"area": str(v1["m-area"].id)},
        str(v1["m-area"].id),
    )
    # The other projects still hold the old bundle and its members: their
    # update time, a cache key elsewhere, stays.
    assert not await _recent(db_session, "bundle", bundle_id)
    for layer in v1.values():
        assert not await _recent(db_session, "layer", layer.id)
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
        v2["m-road"].id: road_link,
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


def _catalog_versions(item_id: str, *versions: str) -> list[Layer]:
    """The shared rows of a catalog table item, one per version."""
    return [
        Layer(
            id=uuid4(),
            name="Haltestellen",
            type="table",
            catalog_external_uid=item_id,
            catalog_version=version,
            other_properties={"catalog_item": {"id": item_id, "version": version}},
        )
        for version in versions
    ]


async def test_an_update_moves_the_entrys_workflow_nodes_with_it(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_get_home_folder: dict[str, Any],
    catalog: tuple[Path, dict[str, UUID], AsyncMock],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The project's workflows read the entry's new layer: its dataset nodes and
    the tool settings that copied the old layer id. A tool setting keeps the old
    id while another entry of the project still shows that layer, since it may
    mean that entry, and while a dataset node without an entry still reads it;
    once the last entry moved, it follows in every workflow of the project, also
    one without a node of the entry. A rewritten workflow gets a new revision.
    Workflows of other projects are not touched, and an old version another
    project still shows keeps its update time."""
    _, promoted, _ = catalog
    old, new = _catalog_versions("item-f", "1", "2")
    db_session.add_all([old, new])
    await db_session.commit()
    promoted["item-f"] = new.id
    monkeypatch.setattr(
        "goatlib.catalog.promote.read_items",
        lambda mirror, ids: {i: {"id": i, "version": "2"} for i in ids},
    )
    project = await _new_project(client, fixture_get_home_folder)
    other = await _new_project(client, fixture_get_home_folder)

    async def entry(project: str) -> int:
        linked = await client.post(
            f"{settings.API_V2_STR}/project/{project}/layer",
            params={"layer_ids": [str(old.id)]},
        )
        assert linked.status_code == 200, linked.text
        return int(linked.json()[0]["id"])

    first, second = await entry(project), await entry(project)
    flow = await _workflow(
        db_session,
        project,
        _dataset("first", first, old.id),
        _dataset("second", second, old.id),
        tool_layer=old.id,
    )
    only_first = await _workflow(
        db_session, project, _dataset("first", first, old.id), tool_layer=old.id
    )
    no_node = await _workflow(db_session, project, tool_layer=old.id)
    unlinked = await _workflow(
        db_session, project, _dataset("free", None, old.id), tool_layer=old.id
    )
    elsewhere = await _workflow(
        db_session,
        other,
        _dataset("first", await entry(other), old.id),
        tool_layer=old.id,
    )
    await _backdate(db_session, "layer", old.id)

    assert (await _update(client, project, layer_project_id=first)).status_code == 200
    assert await _read_flow(db_session, flow) == (
        {"first": str(new.id), "second": str(old.id)},
        str(old.id),
    )
    assert await _read_flow(db_session, only_first) == (
        {"first": str(new.id)},
        str(old.id),
    )
    assert await _read_flow(db_session, no_node) == ({}, str(old.id))
    # A new revision: an editor still showing the old workflow gets the
    # "changed elsewhere" notice instead of saving the old ids back.
    assert await _value(db_session, _REVISION, id=flow) == 2
    assert await _value(db_session, _REVISION, id=no_node) == 1

    assert (await _update(client, project, layer_project_id=second)).status_code == 200
    assert await _read_flow(db_session, flow) == (
        {"first": str(new.id), "second": str(new.id)},
        str(new.id),
    )
    assert await _read_flow(db_session, only_first) == (
        {"first": str(new.id)},
        str(new.id),
    )
    assert await _read_flow(db_session, no_node) == ({}, str(new.id))
    # A node without an entry still reads the old layer: the setting beside it
    # may mean that node's layer and stays.
    assert await _read_flow(db_session, unlinked) == (
        {"free": str(old.id)},
        str(old.id),
    )
    assert await _value(db_session, _REVISION, id=unlinked) == 1
    assert await _read_flow(db_session, elsewhere) == (
        {"first": str(old.id)},
        str(old.id),
    )
    assert await _value(db_session, _REVISION, id=elsewhere) == 1
    assert not await _recent(db_session, "layer", old.id)


async def test_a_node_left_on_an_older_version_moves_with_the_next_update(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_get_home_folder: dict[str, Any],
    catalog: tuple[Path, dict[str, UUID], AsyncMock],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A node of the entry still on an earlier version (a save of an editor
    opened before the last update) moves with the next update, and so do the
    tool settings that copied its id. The version the entry left starts its
    grace period: the next cleanup keeps it, while an unlinked version nothing
    names any more goes."""
    layers_dir, promoted, _ = catalog
    v1, v2, v3 = _catalog_versions("item-h", "1", "2", "3")
    db_session.add_all([v1, v2, v3])
    await db_session.commit()
    for layer in (v1, v2):
        (layers_dir / f"t_{layer.id.hex}.parquet").write_bytes(b"PAR1")
    promoted["item-h"] = v3.id
    monkeypatch.setattr(
        "goatlib.catalog.promote.read_items",
        lambda mirror, ids: {i: {"id": i, "version": "3"} for i in ids},
    )
    project = await _new_project(client, fixture_get_home_folder)
    linked = await client.post(
        f"{settings.API_V2_STR}/project/{project}/layer",
        params={"layer_ids": [str(v2.id)]},
    )
    assert linked.status_code == 200, linked.text
    link = int(linked.json()[0]["id"])
    flow = await _workflow(
        db_session, project, _dataset("node", link, v1.id), tool_layer=v1.id
    )
    for layer in (v1, v2):
        await _backdate(db_session, "layer", layer.id)
    from core.services import catalog_update

    touched_first: list[bool] = []
    repoint = catalog_update._repoint

    async def repoint_after_the_touch(*args: Any, **kwargs: Any) -> bool:
        # A cleanup run between the touch and the move must see the new time.
        touched_first.append(await _recent(db_session, "layer", v2.id))
        return await repoint(*args, **kwargs)

    monkeypatch.setattr(catalog_update, "_repoint", repoint_after_the_touch)

    assert (await _update(client, project, layer_project_id=link)).status_code == 200
    assert touched_first == [True]
    assert await _read_flow(db_session, flow) == ({"node": str(v3.id)}, str(v3.id))
    assert await _value(db_session, _REVISION, id=flow) == 2
    assert await _recent(db_session, "layer", v2.id)

    out = await _catalog_gc(layers_dir, monkeypatch)
    assert out.errors == []
    present = f"SELECT count(*) FROM {S}.layer WHERE id = :id"
    assert await _value(db_session, present, id=v2.id) == 1
    assert (layers_dir / f"t_{v2.id.hex}.parquet").exists()
    assert await _value(db_session, present, id=v1.id) == 0
    assert not (layers_dir / f"t_{v1.id.hex}.parquet").exists()


async def _one_entry_with_a_workflow(
    client: AsyncClient,
    db: AsyncSession,
    folder: dict[str, Any],
    promoted: dict[str, UUID],
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[str, int, UUID, Layer, Layer]:
    """A project with one entry on version 1 of a catalog item whose newest
    version is 2, and a workflow reading it: (project, entry, workflow, v1, v2)."""
    old, new = _catalog_versions(f"item-{uuid4().hex[:8]}", "1", "2")
    db.add_all([old, new])
    await db.commit()
    promoted[old.catalog_external_uid or ""] = new.id
    monkeypatch.setattr(
        "goatlib.catalog.promote.read_items",
        lambda mirror, ids: {i: {"id": i, "version": "2"} for i in ids},
    )
    project = await _new_project(client, folder)
    linked = await client.post(
        f"{settings.API_V2_STR}/project/{project}/layer",
        params={"layer_ids": [str(old.id)]},
    )
    assert linked.status_code == 200, linked.text
    link = int(linked.json()[0]["id"])
    flow = await _workflow(
        db, project, _dataset("node", link, old.id), tool_layer=old.id
    )
    return project, link, flow, old, new


async def test_a_save_made_while_the_workflows_are_rewritten_is_kept(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_get_home_folder: dict[str, Any],
    catalog: tuple[Path, dict[str, UUID], AsyncMock],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A save that lands between the rewrite's read and its write without a new
    revision (a pan, a run's state) is not overwritten: the rewrite reads the
    workflow again and applies itself on top."""
    from core.services import catalog_update

    _, promoted, _ = catalog
    project, link, flow, old, new = await _one_entry_with_a_workflow(
        client, db_session, fixture_get_home_folder, promoted, monkeypatch
    )
    write_over = catalog_update._write_over
    calls: list[int] = []

    async def pan_meanwhile(*args: Any) -> bool:
        if not calls:
            # The editor's in-place save of a pan, as `core.core.revision` writes it.
            await db_session.execute(
                text(
                    f"UPDATE {S}.workflow SET config = config || "
                    '\'{"viewport": {"x": 7, "y": 7, "zoom": 2}}\' WHERE id = :id'
                ),
                {"id": flow},
            )
            await db_session.commit()
        calls.append(1)
        return await write_over(*args)

    monkeypatch.setattr(catalog_update, "_write_over", pan_meanwhile)

    assert (await _update(client, project, layer_project_id=link)).status_code == 200
    assert await _read_flow(db_session, flow) == ({"node": str(new.id)}, str(new.id))
    viewport = f"SELECT config->'viewport' FROM {S}.workflow WHERE id = :id"
    assert await _value(db_session, viewport, id=flow) == {"x": 7, "y": 7, "zoom": 2}
    assert await _value(db_session, _REVISION, id=flow) == 2
    assert len(calls) == 2


async def test_a_failing_workflow_rewrite_leaves_the_update_done(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_get_home_folder: dict[str, Any],
    catalog: tuple[Path, dict[str, UUID], AsyncMock],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The rewrite runs after the entry moved: its failure is logged, the update
    answers 200, and the workflow keeps the old ids (which the cleanup spares)."""
    from core.services import catalog_update

    _, promoted, _ = catalog
    project, link, flow, old, new = await _one_entry_with_a_workflow(
        client, db_session, fixture_get_home_folder, promoted, monkeypatch
    )

    async def broken(*_: Any, **__: Any) -> None:
        raise RuntimeError("workflow table unavailable")

    monkeypatch.setattr(catalog_update, "_rewrite_workflows", broken)

    moved = await _update(client, project, layer_project_id=link)
    assert moved.status_code == 200, moved.text
    layer_of = f"SELECT layer_id FROM {S}.layer_project WHERE id = :l"
    assert await _value(db_session, layer_of, l=link) == new.id
    assert await _read_flow(db_session, flow) == ({"node": str(old.id)}, str(old.id))


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


async def _catalog_gc(
    layers_dir: Path, monkeypatch: pytest.MonkeyPatch, **params: Any
) -> Any:
    """One run of the nightly catalog cleanup against the test schema."""
    from goatlib.tasks.catalog_gc import CatalogGCParams, CatalogGCTask

    monkeypatch.setenv("CATALOG_LAYERS_DIR", str(layers_dir))
    monkeypatch.setenv("CATALOG_TILES_DIR", str(layers_dir.parent / "tiles"))
    task = CatalogGCTask()
    task.settings = SimpleNamespace(  # type: ignore[assignment]
        customer_schema=S,
        tiles_data_dir=str(layers_dir.parent / "user-tiles"),
        postgres_connect_args=lambda _name: {
            "host": settings.POSTGRES_SERVER,
            "port": settings.POSTGRES_PORT,
            "user": settings.POSTGRES_USER,
            "password": settings.POSTGRES_PASSWORD,
            "database": settings.POSTGRES_DB,
        },
    )
    # `run` opens an event loop of its own; the test already runs in one.
    return await task._run(CatalogGCParams(**params))


@pytest.mark.parametrize("spared_by", ["pick", "delete guard"])
async def test_the_catalog_cleanup_spares_what_a_published_map_or_workflow_names(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_get_home_folder: dict[str, Any],
    catalog: tuple[Path, dict[str, UUID], AsyncMock],
    monkeypatch: pytest.MonkeyPatch,
    spared_by: str,
) -> None:
    """A catalog layer that lost its project entries (an update moved them) may
    still be read by a published map, a workflow or a template: the cleanup keeps
    it and its file, and a plan's bundle with its members, while one of them
    names the bundle or a member. A layer nobody names goes once the grace period
    is over; one touched within it stays. Named layers never take a place under
    the run's limit. The DELETEs check again, for a document saved after the
    pick ("delete guard" picks as if nothing were named)."""
    from core.crud.crud_project import project as crud_project
    from core.db.models.template import Template, TemplatePayloadKind

    layers_dir, _, _ = catalog
    names = (
        "published",
        "in-workflow",
        "in-template",
        "in-template-config",
        "member-a",
        "member-b",
        "unnamed",
        "loose-member",
        "touched",
    )
    layers = {name: _table_layer(f"gc-{name}-{uuid4().hex[:8]}") for name in names}
    # `plan` is named in the snapshot, `via-member` only through its member
    # that the workflow names, `loose` not at all.
    plan, via_member, loose = (
        Bundle(
            name=name,
            bundle_type="xplan",
            catalog_external_uid=f"gc-{name}-{uuid4().hex[:8]}",
            catalog_version="1",
        )
        for name in ("plan", "via-member", "loose")
    )
    bundles = (plan, via_member, loose)
    db_session.add_all([*layers.values(), *bundles])
    await db_session.commit()
    for layer in layers.values():
        (layers_dir / f"t_{layer.id.hex}.parquet").write_bytes(b"PAR1")

    project = await _new_project(client, fixture_get_home_folder)
    linked = await client.post(
        f"{settings.API_V2_STR}/project/{project}/layer",
        params={
            "layer_ids": [
                str(layers[name].id) for name in ("published", "member-a", "member-b")
            ]
        },
    )
    assert linked.status_code == 200, linked.text
    group = LayerProjectGroup(name="Plan", project_id=UUID(project), bundle_id=plan.id)
    db_session.add(group)
    await db_session.commit()
    for bundle, role, name in (
        (plan, "a", "member-a"),
        (plan, "b", "member-b"),
        (via_member, "a", "in-workflow"),
        (loose, "a", "loose-member"),
    ):
        await db_session.execute(
            text(
                f"INSERT INTO {S}.bundle_layer (bundle_id, layer_id, role) "
                "VALUES (:b, :l, :r)"
            ),
            {"b": bundle.id, "l": layers[name].id, "r": role},
        )
    await db_session.execute(
        text(
            f"UPDATE {S}.layer_project SET layer_project_group_id = :g "
            "WHERE project_id = :p AND layer_id = ANY(:members)"
        ),
        {
            "g": group.id,
            "p": project,
            "members": [layers["member-a"].id, layers["member-b"].id],
        },
    )
    await db_session.commit()
    await crud_project.publish_project(
        async_session=db_session, project_id=UUID(project)
    )
    await _workflow(
        db_session,
        project,
        _dataset("dataset", None, layers["in-workflow"].id),
        tool_layer=layers["in-workflow"].id,
    )
    home = fixture_get_home_folder["id"]
    template = Template(
        id=uuid4(),
        name="gc",
        space_id=await _value(
            db_session, f"SELECT space_id FROM {S}.folder WHERE id = :f", f=home
        ),
        folder_id=home,
        payload_kind=TemplatePayloadKind.workflow,
        config={
            "nodes": [_dataset("frozen", None, layers["in-template-config"].id)],
            "edges": [],
        },
        inputs=[
            {
                "key": "node:d",
                "label": "Haltestellen",
                "mode": "ship",
                "layer_id": str(layers["in-template"].id),
            }
        ],
    )
    db_session.add(template)
    await db_session.commit()
    # The entries move away; only the documents still name them.
    for table in ("layer_project", "layer_project_group"):
        await db_session.execute(
            text(f"DELETE FROM {S}.{table} WHERE project_id = :p"), {"p": project}
        )
    await db_session.commit()
    spared = {
        "published",
        "in-workflow",
        "in-template",
        "in-template-config",
        "member-a",
        "member-b",
        "touched",
    }
    for name in names:
        if name != "touched":
            # The named layers are the oldest, first in line for the limit, and
            # these older than what other tests leave behind.
            days = 4 if name in spared else 3
            await _backdate(db_session, "layer", layers[name].id, days)
    for bundle in bundles:
        await _backdate(db_session, "bundle", bundle.id)
    if spared_by == "pick":
        out = await _catalog_gc(layers_dir, monkeypatch, limit=2)
    else:

        async def nothing_named(*_: Any) -> set[str]:
            return set()

        monkeypatch.setattr("goatlib.tasks.catalog_gc._named_ids", nothing_named)
        # Several DELETE statements, each checking its own rows.
        monkeypatch.setattr("goatlib.tasks.catalog_gc.DELETE_BATCH", 2)
        out = await _catalog_gc(layers_dir, monkeypatch)

    assert out.errors == []
    present = f"SELECT count(*) FROM {S}.layer WHERE id = :id"
    kept = {
        name for name in names if await _value(db_session, present, id=layers[name].id)
    }
    assert kept == spared
    with_file = {
        name
        for name in names
        if (layers_dir / f"t_{layers[name].id.hex}.parquet").exists()
    }
    assert with_file == spared
    bundle_present = f"SELECT count(*) FROM {S}.bundle WHERE id = :id"
    assert [await _value(db_session, bundle_present, id=b.id) for b in bundles] == [
        1,
        1,
        0,
    ]
    # The shared test user's template list stays as other tests expect it.
    await db_session.delete(template)
    await db_session.commit()


async def test_a_row_that_fails_to_delete_costs_only_that_row(
    db_session: AsyncSession,
    catalog: tuple[Path, dict[str, UUID], AsyncMock],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A DELETE of a batch that fails is retried row by row: the other rows of
    the batch go with their files, and only the failing row is an error."""
    from goatlib.tasks.catalog_gc import CatalogGCTask

    layers_dir, _, _ = catalog
    layers = [_table_layer(f"gc-batch-{uuid4().hex[:8]}") for _ in range(3)]
    db_session.add_all(layers)
    await db_session.commit()
    for layer in layers:
        (layers_dir / f"t_{layer.id.hex}.parquet").write_bytes(b"PAR1")
        await _backdate(db_session, "layer", layer.id)
    bad = layers[1].id
    delete_rows = CatalogGCTask._delete_rows

    async def failing_on_one(self: Any, conn: Any, ids: list[Any], grace: int) -> Any:
        if bad in ids:
            raise RuntimeError("row is locked")
        return await delete_rows(self, conn, ids, grace)

    monkeypatch.setattr(CatalogGCTask, "_delete_rows", failing_on_one)

    out = await _catalog_gc(layers_dir, monkeypatch)

    assert out.errors == [f"{bad}: row is locked"]
    present = f"SELECT count(*) FROM {S}.layer WHERE id = :id"
    assert [await _value(db_session, present, id=layer.id) for layer in layers] == [
        0,
        1,
        0,
    ]
    assert [
        (layers_dir / f"t_{layer.id.hex}.parquet").exists() for layer in layers
    ] == [False, True, False]
