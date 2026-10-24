"""The routes' half of generated columns: the write lock, and what the column
endpoints accept and store.

The SQL itself is covered by ``test_generated_fields.py`` against a real
DuckLake; here Postgres, DuckLake and the caches are stubbed, as in
``test_column_definitions.py``.
"""

from contextlib import asynccontextmanager
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID

import pytest
from fastapi import HTTPException
from goatlib.utils.layer_lock import layer_lock_key

from geoapi.dependencies import LayerInfo
from geoapi.models import BulkFeatureCreate, ColumnCreate, ColumnUpdate, FeatureCreate
from geoapi.routers.metadata import _apply_field_config_to_properties
from geoapi.services.layer_service import LayerMetadata, LayerService

OWNER = UUID("11111111-1111-1111-1111-111111111111")
LAYER_HEX = "abc123def456789012345678901234ab"

SERIAL = {"vorhaben_id": {"kind": "serial", "start": 1}}
UUIDS = {"uid": {"kind": "uuid"}}


@pytest.fixture()
def layer_info() -> LayerInfo:
    return LayerInfo(
        layer_id=LAYER_HEX,
        schema_name=f"user_{OWNER.hex}",
        table_name=f"t_{LAYER_HEX}",
    )


def _metadata() -> LayerMetadata:
    return LayerMetadata(
        layer_id=LAYER_HEX,
        name="Vorhaben",
        geometry_type="Point",
        bounds=[-180, -90, 180, 90],
        columns=[
            {"name": "vorhaben_id", "type": "BIGINT", "json_type": "integer"},
            {"name": "uid", "type": "VARCHAR", "json_type": "string"},
        ],
        user_id=OWNER.hex,
    )


class _RecordingPool:
    """An asyncpg pool that records advisory locks, when they are held, and
    what happens to the serial counter table (kept in ``marks``)."""

    def __init__(self, marks: dict[str, int] | None = None) -> None:
        self.events: list[str] = []
        self.held = False
        self.marks: dict[str, int] = dict(marks or {})

    @asynccontextmanager
    async def acquire(self) -> Any:
        pool = self
        depth = 0

        class _Conn:
            @asynccontextmanager
            async def transaction(self) -> Any:
                nonlocal depth
                depth += 1
                try:
                    yield
                finally:
                    depth -= 1
                    # Committing the outer transaction is what releases an
                    # xact lock; a nested one is a savepoint.
                    if depth == 0 and pool.held:
                        pool.events.append("unlock")
                        pool.held = False

            async def execute(self, sql: str, *args: Any) -> None:
                if "pg_advisory_xact_lock" in sql:
                    pool.events.append(f"lock:{args[0]}")
                    pool.held = True
                elif sql.startswith("DELETE FROM customer.layer_serial_counter"):
                    for name in args[1]:
                        pool.events.append(f"forget:{name}")
                        pool.marks.pop(name, None)
                elif sql.startswith("UPDATE customer.layer_serial_counter"):
                    pool.events.append(f"rename:{args[1]}->{args[2]}")
                    if args[1] in pool.marks:
                        pool.marks[args[2]] = pool.marks.pop(args[1])

            async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
                pool.events.append("read_marks")
                return [
                    {"field_name": n, "last_value": v}
                    for n, v in pool.marks.items()
                    if n in args[1]
                ]

            async def executemany(self, sql: str, rows: list[tuple]) -> None:
                for _, name, value in rows:
                    pool.events.append(f"advance:{name}={value}")
                    pool.marks[name] = max(pool.marks.get(name, value), value)

        yield _Conn()


@asynccontextmanager
async def _routes(
    field_config: dict[str, Any],
    marks: dict[str, int] | None = None,
    fail: bool = False,
) -> Any:
    """The write routes with everything but the lock and counters stubbed.

    The stubbed writer behaves like the real one towards the counters: it hands
    out numbers after the high-water mark it was given (one per feature) and
    records them, so the lock stores them back.
    """
    pool = _RecordingPool(marks)
    service = MagicMock()
    # What field_config holds; the conversion writes update it.
    stored: dict[str, Any] = dict(field_config)

    def _record(name: str, result: Any, count: int = 0) -> Any:
        def call(*args: Any, **kwargs: Any) -> Any:
            pool.events.append(f"{name}:{'locked' if pool.held else 'unlocked'}")
            if fail:
                raise RuntimeError("DuckLake write failed")
            counters = kwargs.get("serial_counters") or (
                args[2] if len(args) > 2 else None
            )
            config = kwargs.get("field_config") or stored
            is_serial = (config.get("vorhaben_id") or {}).get("kind") == "serial"
            if counters is not None and count and (is_serial or name == "backfill"):
                last = counters.high_water.get("vorhaben_id", 0)
                for value in range(last + 1, last + 1 + count):
                    counters.record("vorhaben_id", value)
            return result

        return call

    service.create_feature = MagicMock(side_effect=_record("create", "1", 1))
    service.create_features_bulk = MagicMock(side_effect=_record("bulk", ["1", "2"], 2))
    service.add_column_with_sql = MagicMock(side_effect=_record("ddl", None))
    service.backfill_generated_column = MagicMock(
        side_effect=_record("backfill", None, 3)
    )
    service.delete_column = MagicMock(side_effect=_record("drop", None))

    def _convert(layer_info: Any, field: Any, counters: Any) -> dict[str, Any]:
        pool.events.append(f"convert:{'locked' if pool.held else 'unlocked'}")
        if fail:
            raise ValueError("'vorhaben_id' cannot become a serial number: duplicates")
        counters.record(field.name, 19)
        return {"filled": 0, "rebuilt": True, "max": 19}

    service.convert_to_serial = MagicMock(side_effect=_convert)
    service.rename_column = MagicMock(side_effect=_record("rename_column", None))
    service.get_column_types = MagicMock(return_value={"vorhaben_id": "BIGINT"})
    written: dict[str, Any] = {}

    async def _write(conn: Any, layer_id: str, config: dict[str, Any]) -> None:
        pool.events.append(f"field_config:{'locked' if pool.held else 'unlocked'}")
        written.update(config)
        stored.clear()
        stored.update(config)

    layer_service = MagicMock()
    layer_service._pool = pool
    layer_service._duckdb_to_json_type = LayerService._duckdb_to_json_type

    with (
        patch(
            "geoapi.routers.features_write._get_authorized_metadata",
            AsyncMock(return_value=_metadata()),
        ),
        patch(
            "geoapi.routers.features_write.get_write_authorized_metadata",
            AsyncMock(return_value=_metadata()),
        ),
        patch(
            "geoapi.routers.features_write.layer_is_bundle_member",
            AsyncMock(return_value=False),
        ),
        patch(
            "geoapi.routers.features_write._load_field_config",
            AsyncMock(return_value=dict(field_config)),
        ),
        patch("geoapi.routers.features_write.layer_service", layer_service),
        patch("geoapi.services.layer_write_lock.layer_service", layer_service),
        # Feature writes read the definitions under the lock, on its connection.
        patch(
            "geoapi.services.layer_write_lock.fetch_field_config",
            AsyncMock(side_effect=lambda conn, layer_id: dict(stored)),
        ),
        patch(
            "geoapi.routers.features_write.fetch_field_config",
            AsyncMock(return_value=dict(field_config)),
        ),
        patch("geoapi.routers.features_write.write_field_config", _write),
        patch("geoapi.routers.features_write.feature_write_service", service),
        patch(
            "geoapi.routers.features_write._invalidate_caches_and_pmtiles",
            AsyncMock(return_value=None),
        ),
        patch(
            "geoapi.routers.features_write._settle_schema_caches",
            AsyncMock(return_value=None),
        ),
    ):
        yield pool, service, written


# --- the write lock ------------------------------------------------------------


async def test_a_create_into_a_serial_layer_runs_under_the_layers_lock(
    layer_info,
) -> None:
    from geoapi.routers.features_write import create_features

    async with _routes(SERIAL) as (pool, _, _):
        await create_features(layer_info, OWNER, FeatureCreate(properties={}))
        await create_features(
            layer_info,
            OWNER,
            BulkFeatureCreate(features=[FeatureCreate(), FeatureCreate()]),
        )

    key = layer_lock_key(LAYER_HEX)
    assert pool.events == [
        f"lock:{key}",
        "read_marks",
        "create:locked",
        "advance:vorhaben_id=1",
        "unlock",
        f"lock:{key}",
        "read_marks",
        "bulk:locked",
        # A batch moves the mark by its size, in the same transaction.
        "advance:vorhaben_id=3",
        "unlock",
    ]
    assert pool.marks == {"vorhaben_id": 3}


async def test_the_stored_mark_is_what_the_writer_counts_from(layer_info) -> None:
    """The highest number ever handed out — say 41, its feature since deleted —
    reaches the writer, so the next feature gets 42, not a reused 41."""
    from geoapi.routers.features_write import create_features

    async with _routes(SERIAL, marks={"vorhaben_id": 41}) as (pool, service, _):
        await create_features(layer_info, OWNER, FeatureCreate(properties={}))

    counters = service.create_feature.call_args.kwargs["serial_counters"]
    assert counters.high_water == {"vorhaben_id": 41}
    assert pool.marks == {"vorhaben_id": 42}


async def test_a_failed_write_does_not_move_the_mark(layer_info) -> None:
    from geoapi.routers.features_write import create_features

    async with _routes(SERIAL, marks={"vorhaben_id": 7}, fail=True) as (pool, _, _):
        with pytest.raises(HTTPException):
            await create_features(layer_info, OWNER, FeatureCreate(properties={}))

    assert pool.marks == {"vorhaben_id": 7}
    assert not any(e.startswith("advance") for e in pool.events)
    assert pool.events[-1] == "unlock"


@pytest.mark.parametrize("config", [{}, UUIDS, {"name": {"kind": "string"}}])
async def test_every_create_takes_the_lock_but_only_serials_read_marks(
    layer_info, config
) -> None:
    """Any number column may become a serial at any moment, so every create
    is serialized against that conversion; only a layer with a serial column
    reads and stores marks."""
    from geoapi.routers.features_write import create_features

    async with _routes(config) as (pool, _, _):
        await create_features(layer_info, OWNER, FeatureCreate(properties={}))

    assert pool.events == [
        f"lock:{layer_lock_key(LAYER_HEX)}",
        "create:locked",
        "unlock",
    ]


async def test_updates_take_the_lock_and_read_the_definitions_under_it(
    layer_info,
) -> None:
    from geoapi.models import FeatureReplace, FeatureUpdate
    from geoapi.routers.features_write import replace_feature, update_feature

    async with _routes(SERIAL) as (pool, service, _):
        service.update_feature_properties = MagicMock(return_value=True)
        service.replace_feature = MagicMock(return_value=True)
        await update_feature(
            layer_info, OWNER, FeatureUpdate(properties={"t": 1}), itemId="1"
        )
        await replace_feature(layer_info, OWNER, FeatureReplace(), itemId="1")

    assert pool.events.count(f"lock:{layer_lock_key(LAYER_HEX)}") == 2
    assert pool.events.count("unlock") == 2
    # The definitions the writer got are the ones read under the lock.
    kwargs = service.update_feature_properties.call_args.kwargs
    assert kwargs["field_config"] == SERIAL


def test_the_lock_key_does_not_depend_on_how_the_id_is_spelled() -> None:
    dashed = "ABC123DE-F456-7890-1234-5678901234AB"
    assert layer_lock_key(dashed) == layer_lock_key(dashed.replace("-", "").lower())
    assert layer_lock_key(dashed).startswith("goat.layer_serial:")


# --- adding a generated column -------------------------------------------------


async def test_adding_a_serial_column(layer_info) -> None:
    from geoapi.routers.features_write import add_column

    async with _routes({}) as (pool, service, written):
        await add_column(
            layer_info, OWNER, ColumnCreate(name="vorhaben_id", kind="serial", start=5)
        )

    assert service.add_column_with_sql.call_args.kwargs["duckdb_type"] == "BIGINT"
    assert service.add_column_with_sql.call_args.kwargs["compute_sql"] is None
    entry = written["vorhaben_id"]
    assert entry["kind"] == "serial"
    assert entry["start"] == 5
    assert entry["is_computed"] is False
    field = service.backfill_generated_column.call_args.args[1]
    assert (field.name, field.kind, field.start) == ("vorhaben_id", "serial", 5)
    # The entry exists before the rows are numbered, the numbering holds the
    # layer's lock, a mark a dropped column of the same name left is forgotten
    # first, and the backfill's last number becomes the new column's mark.
    assert pool.events == [
        "ddl:unlocked",
        "field_config:unlocked",
        f"lock:{layer_lock_key(LAYER_HEX)}",
        "forget:vorhaben_id",
        "read_marks",
        "backfill:locked",
        "advance:vorhaben_id=3",
        "unlock",
    ]


async def test_re_adding_a_serial_column_starts_over(layer_info) -> None:
    """A stale mark under the same name — the column was dropped outside the
    column endpoints — must not make the new column count on from it."""
    from geoapi.routers.features_write import add_column

    async with _routes({}, marks={"vorhaben_id": 500}) as (pool, service, _):
        await add_column(
            layer_info, OWNER, ColumnCreate(name="vorhaben_id", kind="serial")
        )

    counters = service.backfill_generated_column.call_args.args[2]
    assert counters.high_water == {}
    assert pool.marks == {"vorhaben_id": 3}


async def test_dropping_a_column_forgets_its_mark(layer_info) -> None:
    from geoapi.routers.features_write import delete_column

    async with _routes(SERIAL, marks={"vorhaben_id": 9, "other": 4}) as (pool, _, _):
        await delete_column(layer_info, OWNER, columnName="vorhaben_id")

    assert pool.marks == {"other": 4}


async def test_renaming_a_serial_column_keeps_its_mark(layer_info) -> None:
    """A rename is the same column, so it keeps counting; the old name is free
    for a new column that starts over."""
    from geoapi.routers.features_write import update_column

    async with _routes(SERIAL, marks={"vorhaben_id": 9}) as (pool, _, _):
        await update_column(
            layer_info, OWNER, ColumnUpdate(new_name="nr"), columnName="vorhaben_id"
        )

    assert pool.marks == {"nr": 9}
    assert "rename:vorhaben_id->nr" in pool.events


async def test_a_serial_starts_at_one_by_default(layer_info) -> None:
    from geoapi.routers.features_write import add_column

    async with _routes({}) as (_, _, written):
        await add_column(layer_info, OWNER, ColumnCreate(name="nr", kind="serial"))

    assert written["nr"]["start"] == 1


async def test_adding_a_uuid_column(layer_info) -> None:
    from geoapi.routers.features_write import add_column

    async with _routes({}) as (pool, service, written):
        await add_column(layer_info, OWNER, ColumnCreate(name="uid", kind="uuid"))

    assert service.add_column_with_sql.call_args.kwargs["duckdb_type"] == "VARCHAR"
    assert written["uid"]["kind"] == "uuid"
    assert "start" not in written["uid"]
    field = service.backfill_generated_column.call_args.args[1]
    assert (field.name, field.kind) == ("uid", "uuid")
    assert "backfill:unlocked" in pool.events


@pytest.mark.parametrize(
    ("body", "message"),
    [
        (
            ColumnCreate(name="n", kind="serial", allowed_values=[1, 2]),
            "allowed values",
        ),
        (ColumnCreate(name="n", kind="uuid", default_value="x"), "default value"),
        (ColumnCreate(name="n", kind="serial", start=-1), "between 0"),
        (ColumnCreate(name="n", kind="uuid", start=3), "no start"),
        (ColumnCreate(name="n", kind="number", start=3), "Only a serial"),
    ],
)
async def test_a_refused_generated_column_creates_nothing(
    layer_info, body: ColumnCreate, message: str
) -> None:
    from geoapi.routers.features_write import add_column

    async with _routes({}) as (_, service, written):
        with pytest.raises(HTTPException) as raised:
            await add_column(layer_info, OWNER, body)

    assert raised.value.status_code == 400
    assert message in str(raised.value.detail)
    service.add_column_with_sql.assert_not_called()
    assert written == {}


@pytest.mark.parametrize(
    "update",
    [ColumnUpdate(default_value=3), ColumnUpdate(allowed_values=[1, 2])],
)
async def test_a_generated_column_takes_no_default_or_vocabulary_later(
    layer_info, update: ColumnUpdate
) -> None:
    from geoapi.routers.features_write import update_column

    async with _routes(SERIAL) as (_, _, written):
        with pytest.raises(HTTPException) as raised:
            await update_column(layer_info, OWNER, update, columnName="vorhaben_id")

    assert raised.value.status_code == 400
    assert written == {}


# --- what editors are told ------------------------------------------------------


def test_queryables_mark_generated_columns() -> None:
    properties: dict[str, dict[str, Any]] = {
        "vorhaben_id": {"type": "integer"},
        "uid": {"type": "string"},
        "name": {"type": "string"},
    }
    _apply_field_config_to_properties(
        properties, {"vorhaben_id": {"kind": "serial", "start": 100}, **UUIDS}
    )
    assert properties["vorhaben_id"]["kind"] == "serial"
    assert properties["vorhaben_id"]["is_generated"] is True
    assert properties["vorhaben_id"]["start"] == 100
    assert properties["uid"]["kind"] == "uuid"
    assert properties["uid"]["is_generated"] is True
    assert "start" not in properties["uid"]
    assert properties["name"]["is_generated"] is False


# --- turning an existing column into a serial -------------------------------------

BONN_ENTRY = {
    "vorhaben_id": {
        "kind": "number",
        "is_computed": False,
        "depends_on": [],
        "display_config": {"decimals": 0},
        "label": "Vorhaben-Nr.",
        "allowed_values": [1, 2],
        "allow_other": True,
    }
}


async def test_converting_a_number_column_keeps_its_entry_and_sets_the_mark(
    layer_info,
) -> None:
    from geoapi.routers.features_write import update_column

    async with _routes(BONN_ENTRY, marks={"vorhaben_id": 500}) as (
        pool,
        service,
        written,
    ):
        response = await update_column(
            layer_info, OWNER, ColumnUpdate(kind="serial"), columnName="vorhaben_id"
        )

    assert response.type == "serial"
    entry = written["vorhaben_id"]
    assert entry["kind"] == "serial"
    assert entry["start"] == 1
    # What described the column stays; what fights the numbering goes.
    assert entry["label"] == "Vorhaben-Nr."
    assert entry["display_config"] == {"decimals": 0}
    assert "allowed_values" not in entry and "allow_other" not in entry
    field = service.convert_to_serial.call_args.args[1]
    assert (field.name, field.kind, field.start) == ("vorhaben_id", "serial", 1)
    # A stale mark is forgotten first; the highest value becomes the mark; the
    # new definition is stored before the lock is released.
    assert pool.events == [
        f"lock:{layer_lock_key(LAYER_HEX)}",
        "forget:vorhaben_id",
        "convert:locked",
        "field_config:locked",
        "advance:vorhaben_id=19",
        "unlock",
    ]
    assert pool.marks == {"vorhaben_id": 19}


async def test_a_start_travels_with_the_conversion(layer_info) -> None:
    from geoapi.routers.features_write import update_column

    async with _routes(BONN_ENTRY) as (_, service, written):
        await update_column(
            layer_info,
            OWNER,
            ColumnUpdate(kind="serial", start=1000),
            columnName="vorhaben_id",
        )
    assert service.convert_to_serial.call_args.args[1].start == 1000
    assert written["vorhaben_id"]["start"] == 1000


async def test_a_refused_conversion_changes_nothing(layer_info) -> None:
    from geoapi.routers.features_write import update_column

    async with _routes(BONN_ENTRY, marks={}, fail=True) as (pool, _, written):
        with pytest.raises(HTTPException) as refused:
            await update_column(
                layer_info, OWNER, ColumnUpdate(kind="serial"), columnName="vorhaben_id"
            )
    assert refused.value.status_code == 400
    assert "duplicates" in refused.value.detail
    assert written == {}
    assert pool.marks == {}
    assert pool.events[-1] == "unlock"


@pytest.mark.parametrize(
    ("stored", "update", "status", "fragment"),
    [
        (SERIAL, ColumnUpdate(kind="serial"), 400, "already a serial"),
        (
            {"vorhaben_id": {"kind": "formula", "is_computed": True}},
            ColumnUpdate(kind="serial"),
            400,
            "calculated",
        ),
        (
            {"vorhaben_id": {"kind": "number", "is_locked": True}},
            ColumnUpdate(kind="serial"),
            400,
            "cannot become",
        ),
        (BONN_ENTRY, ColumnUpdate(kind="uuid"), 400, "not supported"),
        (BONN_ENTRY, ColumnUpdate(kind="string"), 400, "not supported"),
        (BONN_ENTRY, ColumnUpdate(kind="serial", new_name="x"), 400, "on its own"),
        (BONN_ENTRY, ColumnUpdate(kind="serial", start=-1), 400, "between 0"),
        (BONN_ENTRY, ColumnUpdate(kind="number"), 400, "not a serial"),
        (SERIAL, ColumnUpdate(kind="number", start=3), 400, "Only a serial"),
        (SERIAL, ColumnUpdate(start=3), 400, "Only a number column"),
    ],
)
async def test_conversions_that_are_refused(
    layer_info, stored, update, status, fragment
) -> None:
    from geoapi.routers.features_write import update_column

    async with _routes(stored) as (_, service, written):
        with pytest.raises(HTTPException) as refused:
            await update_column(layer_info, OWNER, update, columnName="vorhaben_id")
    assert refused.value.status_code == status
    assert fragment in refused.value.detail
    service.convert_to_serial.assert_not_called()
    assert written == {}


async def test_a_bundle_members_column_cannot_be_converted(layer_info) -> None:
    from geoapi.routers.features_write import update_column

    async with _routes(BONN_ENTRY) as (_, service, _):
        with (
            patch(
                "geoapi.routers.features_write.layer_is_bundle_member",
                AsyncMock(return_value=True),
            ),
            pytest.raises(HTTPException) as refused,
        ):
            await update_column(
                layer_info, OWNER, ColumnUpdate(kind="serial"), columnName="vorhaben_id"
            )
    assert refused.value.status_code == 403
    service.convert_to_serial.assert_not_called()


async def test_an_unknown_column_is_not_found(layer_info) -> None:
    from geoapi.routers.features_write import update_column

    async with _routes(BONN_ENTRY) as _:
        with pytest.raises(HTTPException) as refused:
            await update_column(
                layer_info, OWNER, ColumnUpdate(kind="serial"), columnName="nope"
            )
    assert refused.value.status_code == 404


async def test_converting_back_to_a_number_drops_the_mark_and_keeps_values(
    layer_info,
) -> None:
    from geoapi.routers.features_write import update_column

    stored = {
        "vorhaben_id": {
            "kind": "serial",
            "start": 1,
            "is_computed": False,
            "display_config": {"decimals": 0},
            "label": "Vorhaben-Nr.",
        }
    }
    async with _routes(stored, marks={"vorhaben_id": 19}) as (pool, service, written):
        await update_column(
            layer_info, OWNER, ColumnUpdate(kind="number"), columnName="vorhaben_id"
        )
    entry = written["vorhaben_id"]
    assert entry["kind"] == "number"
    assert "start" not in entry
    assert entry["label"] == "Vorhaben-Nr."
    assert entry["display_config"] == {"decimals": 0}
    assert pool.marks == {}
    # No data is touched: the values and the BIGINT storage stay.
    service.convert_to_serial.assert_not_called()
    service.add_column_with_sql.assert_not_called()
    service.delete_column.assert_not_called()
