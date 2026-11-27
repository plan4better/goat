"""Saving the Explorer's edits: ``POST /bundles/{id}/changes``.

The change set itself (typing, squashing, integrity) is goatlib's and tested
there. Here: the endpoint's protocol — who may save, the revision moved on
only from the one the client started from, a refused change set leaving
everything as it was — the lock taken before the revision moves, and one real
DuckDB transaction keeping a stop's derived columns in step and rolling back
whole.
"""

import asyncio
import threading
import time
from contextlib import asynccontextmanager, contextmanager
from typing import Any, Iterator
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID

import duckdb
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from goatlib.bundles.explorer.changeset import (
    Applied,
    ChangeSet,
    ChangeSetError,
    ChangeSetIntegrityError,
    Notice,
)

BUNDLE = "22222222-2222-2222-2222-222222222222"
USER = UUID("11111111-1111-1111-1111-111111111111")
URL = f"/bundles/{BUNDLE}/changes"
MEMBERS = {
    "stops": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "trips": "4fa85f64-5717-4562-b3fc-2c963f66afa6",
    "stop_times": "5fa85f64-5717-4562-b3fc-2c963f66afa6",
    "shape_lines": "6fa85f64-5717-4562-b3fc-2c963f66afa6",
}
RENAME = {
    "role": "stops",
    "op": "update",
    "key": {"stop_id": "S1"},
    "values": {"stop_name": "First"},
}


class Lock:
    """A stand-in for the locked revision claim: compare-and-swap on a
    revision held here, undone if the write raises — as the transaction is."""

    def __init__(self, revision: int = 3) -> None:
        self.revision = revision

    async def __call__(self, bundle_id: UUID, base: int, write: Any) -> Any:
        if base != self.revision:
            raise HTTPException(status_code=409, detail={"revision": self.revision})
        self.revision += 1
        try:
            return self.revision, await write()
        except BaseException:
            self.revision -= 1
            raise


@pytest.fixture
def save(mock_ducklake_manager):
    """The endpoint with its database edges replaced: ``save.apply`` is the
    DuckLake write, ``save.lock`` the revision, ``save.allowed`` the rule."""
    from geoapi import main
    from geoapi.deps.auth import get_user_id
    from geoapi.routers import pt_edits

    class S:
        lock = Lock()
        allowed = True
        apply = MagicMock()
        invalidated: list[str] = []

    s = S()
    s.invalidated = []

    def apply_sync(
        members: Any, changes: ChangeSet, configs: Any, guard: Any
    ) -> Applied:
        return s.apply(members, changes, configs, guard)

    async def invalidate(info: Any) -> None:
        s.invalidated.append(info.layer_id)

    async def allowed(bundle_id: Any, user_id: Any) -> bool:
        return s.allowed

    from geoapi.dependencies import LayerInfo

    main.app.dependency_overrides[get_user_id] = lambda: USER
    with (
        patch.object(main.layer_service, "init", AsyncMock()),
        patch.object(main.layer_service, "close", AsyncMock()),
        patch.object(main, "start_subscriber"),
        patch.object(main, "stop_subscriber"),
        patch.object(
            pt_edits,
            "_bundle",
            AsyncMock(return_value={"revision": 3, "members": MEMBERS}),
        ),
        patch.object(pt_edits.layer_service, "user_can_write_bundle", allowed),
        patch.object(
            pt_edits,
            "get_layer_info_sync",
            lambda layer_id: LayerInfo(
                layer_id=layer_id, schema_name="s", table_name="t"
            ),
        ),
        patch.object(pt_edits, "_load_field_config", AsyncMock(return_value={})),
        patch.object(pt_edits, "_within_lock", s.lock),
        patch.object(pt_edits, "_apply_sync", apply_sync),
        patch.object(pt_edits, "_invalidate_caches_and_pmtiles", invalidate),
        patch.object(pt_edits, "dispatch_rebuild", AsyncMock(return_value="job-1")),
        patch.object(pt_edits, "dispatch_dependent_rebuilds", AsyncMock()),
        TestClient(main.app) as client,
    ):
        s.client = client  # type: ignore[attr-defined]
        yield s
    main.app.dependency_overrides.pop(get_user_id, None)


def stopped(guard: Any, timeout: float = 5) -> bool:
    """Wait for ``guard`` to be stopped; whether it was."""
    end = time.monotonic() + timeout
    while not guard.stopped and time.monotonic() < end:
        time.sleep(0.01)
    return guard.stopped


def post(s: Any, base: int = 3, ops: Any = None) -> Any:
    return s.client.post(
        URL, json={"base_revision": base, "changes": {"ops": ops or [RENAME]}}
    )


def test_a_save_moves_the_bundle_on_and_rebuilds_it(save) -> None:
    save.apply.return_value = Applied(
        rows={"stops": {"inserted": 0, "updated": 1, "deleted": 0}},
        warnings=[Notice("unusable_trip", "WARNING", "trips", (("trip_id", "T9"),))],
    )
    response = post(save)
    assert response.status_code == 200
    assert response.json() == {
        "revision": 4,
        "rows": {"stops": {"inserted": 0, "updated": 1, "deleted": 0}},
        "warnings": [
            {
                "code": "unusable_trip",
                "severity": "WARNING",
                "role": "trips",
                "key": {"trip_id": "T9"},
                "field": None,
            }
        ],
        "rebuild_job_id": "job-1",
    }
    assert save.lock.revision == 4
    # The written layer, and the lines the map draws, are redrawn.
    assert sorted(save.invalidated) == sorted(
        [MEMBERS["stops"], MEMBERS["shape_lines"]]
    )
    members, changes, _, _ = save.apply.call_args.args
    assert set(members) == set(MEMBERS)
    assert changes.ops[0].values == {"stop_name": "First"}


def test_only_those_who_may_write_the_bundle_save(save) -> None:
    save.allowed = False
    assert post(save).status_code == 403
    assert save.apply.call_count == 0
    assert save.lock.revision == 3


def test_a_save_from_an_old_revision_is_refused(save) -> None:
    response = post(save, base=2)
    assert response.status_code == 409
    assert response.json()["detail"]["revision"] == 3
    assert save.apply.call_count == 0


def test_a_change_set_that_breaks_the_network_changes_nothing(save) -> None:
    save.apply.side_effect = ChangeSetIntegrityError(
        [
            Notice(
                "foreign_key_violation",
                "ERROR",
                "stop_times",
                (("trip_id", "T1"), ("stop_sequence", 2)),
                "stop_id",
            )
        ]
    )
    response = post(save)
    assert response.status_code == 422
    assert response.json()["detail"]["notices"] == [
        {
            "code": "foreign_key_violation",
            "severity": "ERROR",
            "role": "stop_times",
            "key": {"trip_id": "T1", "stop_sequence": 2},
            "field": "stop_id",
        }
    ]
    assert save.lock.revision == 3
    assert save.invalidated == []


def test_a_malformed_change_set_is_a_bad_request(save) -> None:
    save.apply.side_effect = ChangeSetError("stops has no column flavour")
    response = post(save)
    assert response.status_code == 400
    assert response.json()["detail"] == "stops has no column flavour"
    assert save.lock.revision == 3


def test_a_change_set_must_name_its_rows_by_gtfs_key(save) -> None:
    bad = {**RENAME, "key": {"stop_idx": 4}}
    assert post(save, ops=[bad]).status_code == 422
    assert save.apply.call_count == 0


# --------------------------------------------------------------------------
# The lock


class FakeConn:
    def __init__(self, revision: int | None) -> None:
        self.sql: list[str] = []
        self.revision = revision
        self.rolled_back = False

    async def execute(self, sql: str, *args: Any) -> None:
        self.sql.append(sql)

    async def fetchval(self, sql: str, *args: Any) -> Any:
        self.sql.append(sql)
        return self.revision

    def transaction(self) -> Any:
        conn = self

        @asynccontextmanager
        async def tx() -> Any:
            try:
                yield
            except BaseException:
                conn.rolled_back = True
                raise

        return tx()


class FakePool:
    def __init__(self, conn: FakeConn) -> None:
        self.conn = conn

    def acquire(self) -> Any:
        conn = self.conn

        @asynccontextmanager
        async def acq() -> Any:
            yield conn

        return acq()


@pytest.mark.asyncio
async def test_the_lock_is_held_before_the_revision_moves() -> None:
    from geoapi.routers import pt_edits

    conn = FakeConn(revision=4)
    order: list[str] = []

    async def write() -> str:
        order.append("write")
        return "done"

    with patch.object(pt_edits.layer_service, "_pool", FakePool(conn)):
        revision, result = await pt_edits._within_lock(UUID(BUNDLE), 3, write)
    assert (revision, result) == (4, "done")
    assert "pg_advisory_xact_lock(" in conn.sql[0]
    assert "_shared" not in conn.sql[0]
    assert conn.sql[1].lstrip().startswith("UPDATE customer.bundle")
    assert order == ["write"]
    assert not conn.rolled_back


@pytest.mark.asyncio
async def test_a_failed_write_rolls_the_revision_back() -> None:
    from geoapi.routers import pt_edits

    conn = FakeConn(revision=4)

    async def write() -> None:
        raise HTTPException(status_code=422, detail="no")

    with patch.object(pt_edits.layer_service, "_pool", FakePool(conn)):
        with pytest.raises(HTTPException):
            await pt_edits._within_lock(UUID(BUNDLE), 3, write)
    assert conn.rolled_back


# --------------------------------------------------------------------------
# One real transaction


@pytest.fixture
def lake() -> Iterator[duckdb.DuckDBPyConnection]:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial")
    con.execute(
        """
        CREATE TABLE stops (stop_id VARCHAR, stop_name VARCHAR, stop_lat DOUBLE,
            stop_lon DOUBLE, location_type INTEGER, geometry GEOMETRY,
            bbox STRUCT(xmin DOUBLE, ymin DOUBLE, xmax DOUBLE, ymax DOUBLE));
        INSERT INTO stops VALUES
            ('S1', 'First', 52.5, 13.4, 0, ST_Point(13.4, 52.5), NULL),
            ('S2', 'Second', 52.5, 13.41, 0, ST_Point(13.41, 52.5), NULL);
        CREATE TABLE trips (trip_id VARCHAR, route_id VARCHAR, service_id VARCHAR);
        CREATE TABLE stop_times (trip_id VARCHAR, stop_sequence INTEGER, stop_id VARCHAR,
            arrival_time INTERVAL, departure_time INTERVAL);
        INSERT INTO stop_times VALUES ('T1', 1, 'S1', INTERVAL 8 HOUR, INTERVAL 8 HOUR),
            ('T1', 2, 'S2', INTERVAL 8 HOUR + INTERVAL 2 MINUTE,
             INTERVAL 8 HOUR + INTERVAL 2 MINUTE);
        """
    )

    @contextmanager
    def connection() -> Iterator[duckdb.DuckDBPyConnection]:
        yield con

    from geoapi.routers import pt_edits

    with patch.object(pt_edits.ducklake_write_manager, "connection", connection):
        yield con


def members(*roles: str) -> dict[str, Any]:
    from geoapi.dependencies import LayerInfo

    class Info(LayerInfo):
        @property
        def full_table_name(self) -> str:  # type: ignore[override]
            return self.table_name

    return {r: Info(layer_id=r, schema_name="main", table_name=r) for r in roles}


def test_a_moved_stop_keeps_its_bbox(lake: duckdb.DuckDBPyConnection) -> None:
    from geoapi.routers import pt_edits

    changes = ChangeSet(
        ops=[
            {
                "role": "stops",
                "op": "update",
                "key": {"stop_id": "S2"},
                "values": {"stop_lon": 13.5, "stop_lat": 52.6},
            }
        ]
    )
    pt_edits._apply_sync(
        members("stops", "trips", "stop_times"), changes, {}, pt_edits._Guard()
    )
    assert lake.execute(
        "SELECT ST_AsText(geometry), bbox.xmin, bbox.ymax FROM stops WHERE stop_id = 'S2'"
    ).fetchone() == ("POINT (13.5 52.6)", 13.5, 52.6)


def test_a_refused_change_set_rolls_back_whole(lake: duckdb.DuckDBPyConnection) -> None:
    from geoapi.routers import pt_edits

    changes = ChangeSet(
        ops=[
            {
                "role": "stops",
                "op": "update",
                "key": {"stop_id": "S1"},
                "values": {"stop_name": "Renamed"},
            },
            {"role": "stops", "op": "delete", "key": {"stop_id": "S2"}},
        ]
    )
    with pytest.raises(ChangeSetIntegrityError):
        pt_edits._apply_sync(
            members("stops", "trips", "stop_times"), changes, {}, pt_edits._Guard()
        )
    assert lake.execute(
        "SELECT stop_id, stop_name FROM stops ORDER BY 1"
    ).fetchall() == [
        ("S1", "First"),
        ("S2", "Second"),
    ]


def test_a_save_out_of_time_is_stopped_and_undone(
    lake: duckdb.DuckDBPyConnection,
) -> None:
    """Stopped (out of time), the write refuses its next statement and rolls
    back: nothing of it stays."""
    from geoapi.routers import pt_edits

    guard = pt_edits._Guard()
    assert guard.stop()
    changes = ChangeSet(
        ops=[
            {
                "role": "stops",
                "op": "update",
                "key": {"stop_id": "S1"},
                "values": {"stop_name": "Renamed"},
            }
        ]
    )
    with pytest.raises(pt_edits._SaveStopped):
        pt_edits._apply_sync(
            members("stops", "trips", "stop_times"), changes, {}, guard
        )
    assert lake.execute(
        "SELECT stop_name FROM stops WHERE stop_id = 'S1'"
    ).fetchone() == ("First",)


def test_a_save_out_of_time_says_nothing_was_saved(save) -> None:
    """Past its time the save is stopped, waited for while it rolls back, and
    answered as not made: a 504 that says so, the revision not moved on."""
    from geoapi.routers import pt_edits

    seen: dict[str, Any] = {}

    def slow(members: Any, changes: Any, configs: Any, guard: Any) -> Any:
        seen["stopped"] = stopped(guard)
        raise pt_edits._SaveStopped()

    save.apply.side_effect = slow
    with patch.object(pt_edits, "SAVE_TIMEOUT_S", 0.2):
        response = post(save)
    assert response.status_code == 504
    assert "nothing was saved" in response.json()["detail"]
    assert seen["stopped"] is True


def test_a_save_committing_as_time_runs_out_is_saved(save) -> None:
    """Time runs out while the write commits: DuckLake has the change, so
    it is let finish and answered as saved, the revision moved on with it."""
    from geoapi.routers import pt_edits

    def committing(members: Any, changes: Any, configs: Any, guard: Any) -> Any:
        guard.commit()
        time.sleep(0.5)
        return Applied(rows={"stops": {"inserted": 0, "updated": 1, "deleted": 0}})

    save.apply.side_effect = committing
    with patch.object(pt_edits, "SAVE_TIMEOUT_S", 0.1):
        response = post(save)
    assert response.status_code == 200
    assert response.json()["revision"] == 4
    assert save.lock.revision == 4


def _save_in_task(save: Any, cancel_when: threading.Event) -> Any:
    """``save_changes`` run as its own task, cancelled once ``cancel_when``
    is set: what it answers, or the CancelledError it raises."""
    from geoapi.routers import pt_edits

    async def run() -> Any:
        task = asyncio.ensure_future(
            pt_edits.save_changes(
                UUID(BUNDLE),
                pt_edits.ChangesRequest(
                    base_revision=3, changes=ChangeSet(ops=[RENAME])
                ),
                MagicMock(),
                USER,
            )
        )
        await asyncio.get_running_loop().run_in_executor(None, cancel_when.wait, 5)
        task.cancel()
        try:
            return await task
        except asyncio.CancelledError as e:
            return e

    return asyncio.run(run())


def test_a_cancelled_save_is_stopped_and_undone(save) -> None:
    """The request cancelled mid-write: the write is stopped, waited for
    while it rolls back, and the revision is not moved on."""
    from geoapi.routers import pt_edits

    started = threading.Event()
    seen: dict[str, Any] = {}

    def slow(members: Any, changes: Any, configs: Any, guard: Any) -> Any:
        started.set()
        seen["stopped"] = stopped(guard)
        time.sleep(0.2)  # rolling back
        seen["done"] = True
        raise pt_edits._SaveStopped()

    save.apply.side_effect = slow
    assert isinstance(_save_in_task(save, started), asyncio.CancelledError)
    assert seen == {"stopped": True, "done": True}
    assert save.lock.revision == 3


def test_a_save_cancelled_while_committing_is_saved(save) -> None:
    """The request cancelled once the write commits: DuckLake has the
    change, so the revision moves on with it."""
    committing = threading.Event()

    def commit(members: Any, changes: Any, configs: Any, guard: Any) -> Any:
        guard.commit()
        committing.set()
        time.sleep(0.2)
        return Applied(rows={"stops": {"inserted": 0, "updated": 1, "deleted": 0}})

    save.apply.side_effect = commit
    response = _save_in_task(save, committing)
    assert response.revision == 4
    assert save.lock.revision == 4


def test_a_write_stopped_before_its_commit_commits_nothing(
    lake: duckdb.DuckDBPyConnection,
) -> None:
    """Stopped after its last statement and before its COMMIT, the write
    rolls back: it never commits once the request has answered 504."""
    from geoapi.routers import pt_edits

    guard = pt_edits._Guard()
    real = pt_edits.apply_changeset

    def then_stopped(*args: Any, **kwargs: Any) -> Any:
        applied = real(*args, **kwargs)
        assert guard.stop()
        return applied

    with patch.object(pt_edits, "apply_changeset", then_stopped):
        with pytest.raises(pt_edits._SaveStopped):
            pt_edits._apply_sync(
                members("stops", "trips", "stop_times"),
                ChangeSet(ops=[{**RENAME, "values": {"stop_name": "Renamed"}}]),
                {},
                guard,
            )
    assert lake.execute(
        "SELECT stop_name FROM stops WHERE stop_id = 'S1'"
    ).fetchone() == ("First",)


def test_only_the_running_write_is_interrupted() -> None:
    """The write connection is shared: the request interrupts it only while
    its write runs on it, never once the write is done."""
    from geoapi.routers import pt_edits

    con = MagicMock()

    @contextmanager
    def connection() -> Iterator[Any]:
        yield con

    guard = pt_edits._Guard()
    with (
        patch.object(pt_edits.ducklake_write_manager, "connection", connection),
        patch.object(pt_edits, "apply_changeset", return_value=Applied()),
    ):
        pt_edits._apply_sync({}, ChangeSet(ops=[RENAME]), {}, guard)
    assert not guard.stop()  # it committed: nothing left to stop
    con.interrupt.assert_not_called()

    guard = pt_edits._Guard()

    def stopped_midway(*args: Any, **kwargs: Any) -> Any:
        assert guard.stop()
        return Applied()

    with (
        patch.object(pt_edits.ducklake_write_manager, "connection", connection),
        patch.object(pt_edits, "apply_changeset", stopped_midway),
    ):
        with pytest.raises(pt_edits._SaveStopped):
            pt_edits._apply_sync({}, ChangeSet(ops=[RENAME]), {}, guard)
    con.interrupt.assert_called_once()
    assert [c.args[0] for c in con.execute.call_args_list][-1] == "ROLLBACK"
    guard.stop()
    con.interrupt.assert_called_once()
