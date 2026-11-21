"""The data snapshot tracker (spec 12) against Postgres: a scratch schema holds the
DuckLake catalog tables it reads (`ducklake_snapshot`, `ducklake_snapshot_changes`,
`ducklake_table`), core's schema the layers it moves."""

from uuid import UUID, uuid4

import pytest
from core.core.config import settings
from core.db.models.layer import Layer
from goatlib.style.fingerprint import advance_data_snapshots_sql
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.styles.conftest import LAKE, StyleWorld

S = settings.SCHEMA


async def layers(db: AsyncSession, world: StyleWorld, count: int) -> list[UUID]:
    """`count` more layers of the world's user, each with a DuckLake table id 11, 12, ..."""
    first = await db.get(Layer, world.layer_id)
    assert first is not None
    ids = []
    for i in range(count):
        layer_id = uuid4()
        db.add(
            Layer(
                id=layer_id,
                user_id=world.user_id,
                folder_id=first.folder_id,
                space_id=first.space_id,
                name=f"l{i}",
                type="feature",
                feature_layer_type="standard",
                feature_layer_geometry_type="polygon",
            )
        )
        ids.append(layer_id)
    await db.commit()
    for i, layer_id in enumerate(ids):
        await db.execute(
            text(f"INSERT INTO {LAKE}.ducklake_table VALUES (:id, :name)"),
            {"id": 11 + i, "name": f"t_{layer_id.hex}"},
        )
    await db.commit()
    return ids


async def log(db: AsyncSession, changes: dict[int, str]) -> None:
    for snapshot_id, made in changes.items():
        await db.execute(
            text(f"INSERT INTO {LAKE}.ducklake_snapshot VALUES (:s)"),
            {"s": snapshot_id},
        )
        await db.execute(
            text(f"INSERT INTO {LAKE}.ducklake_snapshot_changes VALUES (:s, :m)"),
            {"s": snapshot_id, "m": made},
        )
    await db.commit()


async def track(db: AsyncSession) -> int:
    moved = (await db.execute(text(advance_data_snapshots_sql(S, LAKE)))).scalar_one()
    await db.commit()
    return moved


async def snapshots(db: AsyncSession, ids: list[UUID]) -> list[int | None]:
    rows = dict(
        (
            await db.execute(
                text(f"SELECT id, data_snapshot FROM {S}.layer WHERE id = ANY(:ids)"),
                {"ids": ids},
            )
        ).all()
    )
    return [rows[i] for i in ids]


@pytest.mark.asyncio
async def test_inserts_deletes_inlined_changes_and_altered_tables_advance_the_layer_compaction_does_not(
    db_session: AsyncSession, style_world: StyleWorld, lake: str
) -> None:
    ids = await layers(db_session, style_world, 5)
    await log(
        db_session,
        {
            1: "inserted_into_table:11",
            2: "deleted_from_table:12",
            3: 'created_table:"main"."t_new",inlined_insert:13',
            4: "altered_table:14",
            5: "merge_adjacent:15",
            6: "inlined_delete:11",
        },
    )
    assert await track(db_session) == 4
    assert await snapshots(db_session, ids) == [6, 2, 3, 4, None]


@pytest.mark.asyncio
async def test_running_the_tracker_twice_changes_nothing(
    db_session: AsyncSession, style_world: StyleWorld, lake: str
) -> None:
    ids = await layers(db_session, style_world, 2)
    await log(db_session, {1: "inserted_into_table:11", 2: "inserted_into_table:12"})
    assert await track(db_session) == 2
    assert await track(db_session) == 0
    assert await snapshots(db_session, ids) == [1, 2]
    await log(db_session, {3: "inserted_into_table:12"})
    assert await track(db_session) == 1
    assert await snapshots(db_session, ids) == [1, 3]


@pytest.mark.asyncio
async def test_a_cursor_older_than_the_kept_log_resets_every_layer_once(
    db_session: AsyncSession, style_world: StyleWorld, lake: str
) -> None:
    ids = await layers(db_session, style_world, 2)
    await db_session.execute(
        text(f"INSERT INTO {S}.data_snapshot_cursor (id, snapshot_id) VALUES (1, 2)")
    )
    await db_session.commit()
    # Snapshots 3 to 9 expired unseen; the log keeps 10 to 12.
    await log(
        db_session, {10: "merge_adjacent:12", 11: "inserted_into_table:11", 12: ""}
    )
    assert await track(db_session) >= 2
    assert await snapshots(db_session, ids) == [11, 10]
    assert await track(db_session) == 0


async def cursor_version(db: AsyncSession) -> str:
    return (
        await db.execute(
            text(f"SELECT xmin::text FROM {S}.data_snapshot_cursor WHERE id = 1")
        )
    ).scalar_one()


@pytest.mark.asyncio
async def test_a_run_with_nothing_new_writes_nothing(
    db_session: AsyncSession, style_world: StyleWorld, lake: str
) -> None:
    """The map request runs the tracker on every load: with no new log rows it
    must not rewrite the cursor (or scan the layers)."""
    await layers(db_session, style_world, 1)
    await log(db_session, {1: "inserted_into_table:11"})
    await track(db_session)
    before = await cursor_version(db_session)
    assert await track(db_session) == 0
    assert await cursor_version(db_session) == before


@pytest.mark.asyncio
async def test_without_a_catalog_the_tracker_moves_nothing_and_keeps_loaded_rows(
    db_session: AsyncSession, style_world: StyleWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A fresh install has no DuckLake catalog until geoapi creates it. The map
    request then skips the tracker without expiring what the caller loaded, so
    reading a loaded row afterwards needs no IO."""
    from core.services.map_document import track_data_snapshots
    from sqlalchemy import inspect

    monkeypatch.setattr(settings, "DUCKLAKE_CATALOG_SCHEMA", "no_ducklake_here")
    layer = await db_session.get(Layer, style_world.layer_id)
    assert layer is not None
    await track_data_snapshots(db_session)
    assert not inspect(layer).expired_attributes
    assert layer.id == style_world.layer_id
