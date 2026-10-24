"""The per-layer advisory lock and the serial high-water marks, against a real
Postgres.

Two pools stand in for two geoapi pods. The counter table lives in a scratch
schema created for the run and dropped afterwards (the module's table name is
pointed at it), so no table of the database is touched; the advisory locks
themselves touch nothing.

The last test also writes a real DuckLake from two DuckDB cursors at once —
two pods with no in-process lock between them — so the only thing keeping
their numbers apart is the advisory lock and the mark.

Requires Postgres (local compose stack). Run with:
``uv run pytest apps/geoapi/tests/integration -m integration``
"""

from __future__ import annotations

import asyncio
import os
import random
from pathlib import Path
from typing import Any, AsyncGenerator
from unittest.mock import patch

import asyncpg
import duckdb
import pytest
import pytest_asyncio
from goatlib.utils.generated_fields import GeneratedValues, generated_fields
from goatlib.utils.layer_lock import layer_lock_key

from geoapi.config import settings
from geoapi.services import layer_write_lock as lock_module
from geoapi.services.layer_write_lock import (
    forget_serial_counter,
    layer_write_lock,
    rename_serial_counter,
)

pytestmark = pytest.mark.integration

LAYER = "abc123de-f456-7890-1234-5678901234ab"
OTHER_LAYER = "abc123de-f456-7890-1234-5678901234ac"
SERIAL = {"nr": {"kind": "serial", "start": 1}}
SCRATCH = f"geoapi_serial_test_{os.getpid()}"


def _connect_kwargs() -> dict[str, Any]:
    return {
        "host": settings.POSTGRES_SERVER,
        "port": settings.POSTGRES_PORT,
        "user": settings.POSTGRES_USER,
        "password": settings.POSTGRES_PASSWORD,
        "database": settings.POSTGRES_DB,
        "timeout": 5,
    }


@pytest_asyncio.fixture()
async def pods() -> AsyncGenerator[tuple[Any, Any], None]:
    """Two pods' pools, and a scratch counter table both of them use."""
    try:
        first = await asyncpg.create_pool(min_size=1, max_size=4, **_connect_kwargs())
        second = await asyncpg.create_pool(min_size=1, max_size=4, **_connect_kwargs())
    except (OSError, asyncpg.PostgresError) as exc:
        pytest.skip(f"Postgres not reachable: {exc}")
    await first.execute(f"CREATE SCHEMA {SCRATCH}")
    # The shape of core's model, without the FK: there is no layer row here.
    await first.execute(
        f"CREATE TABLE {SCRATCH}.layer_serial_counter ("
        "layer_id uuid NOT NULL, field_name text NOT NULL, "
        "last_value bigint NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), "
        "PRIMARY KEY (layer_id, field_name))"
    )
    try:
        with patch.object(
            lock_module, "COUNTER_TABLE", f"{SCRATCH}.layer_serial_counter"
        ):
            yield first, second
    finally:
        await first.execute(f"DROP SCHEMA {SCRATCH} CASCADE")
        await first.close()
        await second.close()


async def _marks(pool: Any) -> dict[str, int]:
    rows = await pool.fetch(
        f"SELECT field_name, last_value FROM {SCRATCH}.layer_serial_counter "
        "WHERE layer_id = $1::uuid",
        LAYER,
    )
    return {r["field_name"]: r["last_value"] for r in rows}


async def _hold(pool: Any, layer_id: str, log: list[str], name: str) -> None:
    async with layer_write_lock(layer_id, SERIAL, pool=pool):
        log.append(f"{name}:in")
        await asyncio.sleep(0.2)
        log.append(f"{name}:out")


# --- the lock -------------------------------------------------------------------


async def test_two_pods_never_write_the_same_layer_at_once(pods) -> None:
    first, second = pods
    log: list[str] = []
    await asyncio.gather(
        _hold(first, LAYER, log, "a"),
        _hold(second, LAYER, log, "b"),
        _hold(first, LAYER, log, "c"),
    )
    # Every writer leaves before the next one enters.
    for i in range(0, len(log), 2):
        assert log[i].endswith(":in")
        assert log[i + 1] == log[i].replace(":in", ":out")


async def test_different_layers_do_not_wait_for_each_other(pods) -> None:
    first, second = pods
    log: list[str] = []
    await asyncio.gather(
        _hold(first, LAYER, log, "a"),
        _hold(second, OTHER_LAYER, log, "b"),
    )
    assert log[:2] in (["a:in", "b:in"], ["b:in", "a:in"])


async def test_a_pod_that_dies_holding_the_lock_releases_it(pods) -> None:
    """The lock is transaction-scoped, so a connection that goes away mid-write
    — a killed pod — takes it with it instead of locking the layer for good."""
    _, second = pods
    conn = await asyncpg.connect(**_connect_kwargs())
    transaction = conn.transaction()
    await transaction.start()
    await conn.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", layer_lock_key(LAYER)
    )
    conn.terminate()

    log: list[str] = []
    await asyncio.wait_for(_hold(second, LAYER, log, "b"), timeout=5)
    assert log == ["b:in", "b:out"]


async def test_a_layer_without_a_serial_takes_no_lock(pods) -> None:
    first, second = pods
    log: list[str] = []

    async def plain(pool: Any, name: str) -> None:
        async with layer_write_lock(LAYER, {"uid": {"kind": "uuid"}}, pool=pool):
            log.append(f"{name}:in")
            await asyncio.sleep(0.2)
            log.append(f"{name}:out")

    await asyncio.gather(plain(first, "a"), plain(second, "b"))
    assert log[:2] in (["a:in", "b:in"], ["b:in", "a:in"])


# --- the high-water mark ---------------------------------------------------------


async def test_the_mark_is_read_under_the_lock_and_only_moves_up(pods) -> None:
    first, second = pods
    async with layer_write_lock(LAYER, SERIAL, pool=first) as counters:
        assert counters.high_water == {}
        counters.record("nr", 10)
    assert await _marks(first) == {"nr": 10}

    async with layer_write_lock(LAYER, SERIAL, pool=second) as counters:
        assert counters.high_water == {"nr": 10}
        # A lower number (a copy's own max, a repaired row) never lowers it.
        counters.record("nr", 4)
    assert await _marks(first) == {"nr": 10}


async def test_a_failed_write_leaves_the_mark_alone(pods) -> None:
    first, _ = pods
    async with layer_write_lock(LAYER, SERIAL, pool=first) as counters:
        counters.record("nr", 5)
    with pytest.raises(RuntimeError):
        async with layer_write_lock(LAYER, SERIAL, pool=first) as counters:
            counters.record("nr", 6)
            raise RuntimeError("DuckLake write failed")
    assert await _marks(first) == {"nr": 5}


async def test_drop_rename_and_re_add_reset_the_mark(pods) -> None:
    first, _ = pods
    async with layer_write_lock(LAYER, SERIAL, pool=first) as counters:
        counters.record("nr", 7)

    with patch.object(lock_module.layer_service, "_pool", first):
        await rename_serial_counter(LAYER, "nr", "lfd_nr")
        assert await _marks(first) == {"lfd_nr": 7}
        await forget_serial_counter(LAYER, "lfd_nr")
        assert await _marks(first) == {}

    async with layer_write_lock(LAYER, SERIAL, pool=first) as counters:
        counters.record("nr", 99)
    # Adding a column of that name again starts it over.
    async with layer_write_lock(LAYER, SERIAL, reset=["nr"], pool=first) as counters:
        assert counters.high_water == {}
        counters.record("nr", 3)
    assert await _marks(first) == {"nr": 3}


async def test_two_pods_writing_and_deleting_never_reuse_a_number(
    pods, tmp_path: Path
) -> None:
    """Two pods, each with its own DuckDB connection to one DuckLake and no
    in-process lock between them, create features in parallel and delete the
    highest one every so often. Every number handed out is new."""
    first, second = pods
    lake = duckdb.connect(":memory:")
    lake.execute("INSTALL ducklake; LOAD ducklake;")
    lake.execute(
        f"ATTACH 'ducklake:{tmp_path}/meta.ducklake' AS lake "
        f"(DATA_PATH '{tmp_path}/data')"
    )
    lake.execute("CREATE TABLE lake.main.t (name VARCHAR, nr BIGINT)")
    table = "lake.main.t"
    fields = generated_fields(SERIAL)
    handed_out: list[int] = []

    def write(cursor: duckdb.DuckDBPyConnection, counters: Any, drop_top: bool) -> int:
        value = GeneratedValues(cursor, table, fields, counters).next_row()["nr"]
        cursor.execute(f"INSERT INTO {table} VALUES (?, ?)", ["x", value])
        if drop_top:
            cursor.execute(f"DELETE FROM {table} WHERE nr = ?", [value])
        return value

    async def pod(pool: Any, cursor: duckdb.DuckDBPyConnection, writes: int) -> None:
        for _ in range(writes):
            async with layer_write_lock(LAYER, SERIAL, pool=pool) as counters:
                value = await asyncio.to_thread(
                    write, cursor, counters, random.random() < 0.5
                )
            handed_out.append(value)

    await asyncio.gather(
        pod(first, lake.cursor(), 25),
        pod(second, lake.cursor(), 25),
    )
    assert sorted(handed_out) == list(range(1, 51))
    assert await _marks(first) == {"nr": 50}
    lake.close()


# --- a create while a column is being turned into a serial -----------------------


async def test_a_create_during_a_conversion_waits_and_gets_the_next_number(
    pods, tmp_path: Path
) -> None:
    """Pod A converts Bonn's ``vorhaben_id`` (1-17 and 19) while pod B creates
    a feature with a hand-typed 5 — a duplicate the moment the column is a
    serial. B's write takes the same lock and reads the column definition
    under it, so it waits for A, sees the serial, and gets 20."""
    import json
    import threading
    from contextlib import contextmanager

    from goatlib.utils.generated_fields import GeneratedField

    from geoapi.dependencies import LayerInfo
    from geoapi.services.feature_write_service import FeatureWriteService
    from geoapi.services.layer_write_lock import locked_layer_write

    first, second = pods
    await first.execute(
        f"CREATE TABLE {SCRATCH}.layer_config (id uuid PRIMARY KEY, config jsonb)"
    )
    await first.execute(
        f"INSERT INTO {SCRATCH}.layer_config VALUES ($1::uuid, $2::jsonb)",
        LAYER,
        json.dumps({"vorhaben_id": {"kind": "number"}}),
    )

    async def fetch_config(conn: Any, layer_id: Any) -> dict[str, Any]:
        raw = await conn.fetchval(
            f"SELECT config FROM {SCRATCH}.layer_config WHERE id = $1::uuid",
            str(layer_id),
        )
        return json.loads(raw)

    lake = duckdb.connect(":memory:")
    lake.execute("INSTALL spatial; LOAD spatial; INSTALL ducklake; LOAD ducklake;")
    lake.execute(
        f"ATTACH 'ducklake:{tmp_path}/meta.ducklake' AS lake "
        f"(DATA_PATH '{tmp_path}/data')"
    )
    lake.execute("CREATE SCHEMA lake.s")
    lake.execute("CREATE TABLE lake.s.t (geometry GEOMETRY, vorhaben_id DOUBLE)")
    for value in [*range(1, 18), 19]:
        lake.execute(
            "INSERT INTO lake.s.t VALUES (ST_Point(7.1, 50.7), ?)", [float(value)]
        )

    class _Manager:
        def __init__(self) -> None:
            self._lock = threading.Lock()

        @contextmanager
        def connection(self) -> Any:
            with self._lock:
                yield lake

    layer = LayerInfo(layer_id=LAYER, schema_name="s", table_name="t")
    service = FeatureWriteService()
    order: list[str] = []
    seen: dict[str, Any] = {}

    async def convert() -> None:
        async with locked_layer_write(LAYER, reset=["vorhaben_id"], pool=first) as w:
            order.append("convert:in")
            await asyncio.to_thread(
                service.convert_to_serial,
                layer,
                GeneratedField("vorhaben_id", "serial", 1),
                w.counters,
            )
            # Widen the window for the create to slip in, if it could.
            await asyncio.sleep(0.3)
            await w.conn.execute(
                f"UPDATE {SCRATCH}.layer_config SET config = $2::jsonb "
                "WHERE id = $1::uuid",
                LAYER,
                json.dumps({"vorhaben_id": {"kind": "serial", "start": 1}}),
            )
            order.append("convert:out")

    async def create() -> None:
        await asyncio.sleep(0.05)
        async with locked_layer_write(LAYER, pool=second) as w:
            order.append("create:in")
            seen["kind"] = w.field_config["vorhaben_id"]["kind"]
            seen["id"] = await asyncio.to_thread(
                service.create_feature,
                layer,
                POINT_GEOJSON,
                {"vorhaben_id": 5},
                ["geometry", "vorhaben_id"],
                "geometry",
                w.field_config,
                w.counters,
            )

    with (
        patch.object(lock_module, "fetch_field_config", fetch_config),
        patch(
            "geoapi.services.feature_write_service.ducklake_write_manager", _Manager()
        ),
    ):
        await asyncio.gather(convert(), create())

    assert order == ["convert:in", "convert:out", "create:in"]
    assert seen["kind"] == "serial"
    values = sorted(
        r[0] for r in lake.execute("SELECT vorhaben_id FROM lake.s.t").fetchall()
    )
    assert values == [*range(1, 18), 19, 20]
    assert await _marks(first) == {"vorhaben_id": 20}
    lake.close()


POINT_GEOJSON = {"type": "Point", "coordinates": [7.1, 50.7]}
