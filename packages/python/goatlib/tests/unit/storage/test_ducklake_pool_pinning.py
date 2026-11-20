"""Pool swap/generation logic tests with stubbed connections (no DuckDB).

Pinned pools use the shared-instance cursor model: one warmed base
connection per generation, pool_size cursors drawn from it. The catalog
metadata cache lives on the base, so a rebuild costs ONE metadata load
per pod instead of one per pooled connection.
"""

import queue
import time
from typing import Any, Generator

import pytest
from goatlib.storage.ducklake import DuckLakePool, is_connection_error

# What DuckDB answers on every connection of a database after an internal
# error in one of its queries.
INVALIDATED = (
    "FATAL Error: Failed: database has been invalidated because of a previous "
    "fatal error. The database must be restarted prior to being used again."
)


class FakeCursor:
    def __init__(self, base: "FakeBase") -> None:
        self.base = base
        self.closed = False

    def close(self) -> None:
        self.closed = True

    def execute(self, *_: Any) -> "FakeCursor":
        if self.closed or self.base.closed:
            # Matches CONNECTION_ERROR_PATTERNS, like a real dead libpq link
            raise RuntimeError("connection error: cursor or base closed")
        if self.base.invalidated:
            raise RuntimeError(INVALIDATED)
        return self

    def fetchall(self) -> list[tuple[int]]:
        return [(1,)]

    def fetchone(self) -> tuple[int]:
        return (1,)


class FakeBase:
    def __init__(self, snapshot: int | None) -> None:
        self.snapshot = snapshot
        self.closed = False
        # A DuckDB database invalidated by an internal error: cursors can
        # still be drawn, every query fails.
        self.invalidated = False
        self.cursors: list[FakeCursor] = []

    def cursor(self) -> FakeCursor:
        if self.closed:
            raise RuntimeError("base closed")
        c = FakeCursor(self)
        self.cursors.append(c)
        return c

    def close(self) -> None:
        self.closed = True

    def execute(self, *_: Any) -> "FakeBase":
        if self.closed:
            raise RuntimeError("closed")
        return self

    def fetchone(self) -> tuple[int]:
        return (1,)

    def fetchall(self) -> list[tuple[int]]:
        return [(1,)]


@pytest.fixture()
def pool(monkeypatch: pytest.MonkeyPatch) -> DuckLakePool:
    p = DuckLakePool(pool_size=2, pin_snapshot=True)
    bases: list[FakeBase] = []

    def fake_base(snapshot_version: int | None = None) -> FakeBase:
        b = FakeBase(snapshot_version)
        bases.append(b)
        return b

    monkeypatch.setattr(
        p,
        "_create_base_with_retry",
        lambda snapshot_version=None: fake_base(snapshot_version),
    )
    monkeypatch.setattr(p, "_warm_connection", lambda con: None)
    monkeypatch.setattr(p, "_fetch_latest_snapshot_id", lambda: 10)
    p._test_bases = bases
    # Simulate pinned init(): one base at snapshot 10, generation 0, 2 cursors
    base = fake_base(10)
    p._register_base(0, base)
    for _ in range(2):
        p._pool.put((base.cursor(), time.time(), 0))
    p._initialized = True
    return p


def pool_entries(p: DuckLakePool) -> list[tuple[Any, float, int]]:
    items = []
    while True:
        try:
            items.append(p._pool.get_nowait())
        except queue.Empty:
            break
    for it in items:
        p._pool.put(it)
    return items


def bases(p: DuckLakePool) -> list[Any]:
    result: list[Any] = p._test_bases
    return result


def test_apply_snapshot_single_base_swap(pool: DuckLakePool) -> None:
    old_base = bases(pool)[0]
    pool._apply_snapshot(11)
    entries = pool_entries(pool)
    assert len(entries) == 2
    new_base = bases(pool)[-1]
    assert new_base.snapshot == 11
    assert len(bases(pool)) == 2  # exactly ONE new base built (not one per cursor)
    assert all(e[0].base is new_base for e in entries)
    assert all(e[2] == pool._generation for e in entries)
    assert old_base.closed  # no outstanding cursors -> base closed
    assert all(c.closed for c in old_base.cursors)


def test_checked_out_stale_cursor_keeps_old_base_alive_until_return(
    pool: DuckLakePool,
) -> None:
    old_base = bases(pool)[0]
    with pool.connection() as con:
        pool._apply_snapshot(11)  # rebuild while one cursor is checked out
        assert not old_base.closed  # in-flight query must keep its base alive
        held = con
    assert held.closed  # stale cursor closed on return
    assert old_base.closed  # last outstanding cursor returned -> base closed
    entries = pool_entries(pool)
    assert len(entries) == 2
    assert all(e[0].base.snapshot == 11 for e in entries)


def test_apply_snapshot_build_failure_leaves_pool_untouched(
    pool: DuckLakePool, monkeypatch: pytest.MonkeyPatch
) -> None:
    def failing_base(snapshot_version: int | None = None) -> FakeBase:
        raise RuntimeError("create failed")

    monkeypatch.setattr(pool, "_create_base_with_retry", failing_base)
    before = [e[0] for e in pool_entries(pool)]
    gen_before = pool._generation
    old_base = bases(pool)[0]

    with pytest.raises(RuntimeError, match="create failed"):
        pool._apply_snapshot(11)

    assert pool._generation == gen_before
    entries = pool_entries(pool)
    assert [e[0] for e in entries] == before
    assert not old_base.closed


def test_warm_failure_closes_new_base_and_keeps_pool(
    pool: DuckLakePool, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Use the REAL _create_base_with_retry (the fixture stubs it out) with a
    # fake connection factory, so the create->warm->close-on-failure path is
    # exercised for real.
    monkeypatch.setattr(
        pool,
        "_create_base_with_retry",
        DuckLakePool._create_base_with_retry.__get__(pool),
    )

    def fake_conn(
        max_retries: int = 3,
        retry_delay: float = 1.0,
        snapshot_version: int | None = None,
    ) -> FakeBase:
        b = FakeBase(snapshot_version)
        bases(pool).append(b)
        return b

    monkeypatch.setattr(pool, "_create_connection_with_retry", fake_conn)

    def bad_warm(con: Any) -> None:
        raise RuntimeError("warm failed")

    monkeypatch.setattr(pool, "_warm_connection", bad_warm)
    old_base = bases(pool)[0]
    n_before = len(bases(pool))

    with pytest.raises(RuntimeError, match="warm failed"):
        pool._apply_snapshot(11)

    new_bases = bases(pool)[n_before:]
    assert len(new_bases) == 1
    assert new_bases[0].closed  # failed base not leaked
    assert not old_base.closed
    assert len(pool_entries(pool)) == 2


def test_miss_triggers_force_refresh_and_retry(
    pool: DuckLakePool, monkeypatch: pytest.MonkeyPatch
) -> None:
    from goatlib.storage.snapshot_pin import SnapshotPin

    pool._pin = SnapshotPin(
        pool._fetch_latest_snapshot_id, pool._apply_snapshot, min_refresh_gap=0.0
    )
    pool._pin._current = 9  # behind: latest is 10

    calls = {"n": 0}

    class MissThenOk:
        def execute(self, *_: Any) -> "MissThenOk":
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("Catalog Error: Table with name t_x does not exist!")
            return self

        def fetchall(self) -> list[tuple[int]]:
            return [(42,)]

        def fetchone(self) -> tuple[int]:
            return (42,)

        def close(self) -> None:
            pass

    import contextlib

    @contextlib.contextmanager
    def fake_conn() -> Generator[Any, None, None]:
        yield MissThenOk()

    monkeypatch.setattr(pool, "connection", fake_conn)
    result = pool.execute_with_retry("SELECT 1", fetch_all=True)
    assert result == [(42,)]
    assert calls["n"] == 2
    assert pool._pin.current == 10


def test_genuine_missing_table_still_raises(
    pool: DuckLakePool, monkeypatch: pytest.MonkeyPatch
) -> None:
    from goatlib.storage.snapshot_pin import SnapshotPin

    pool._pin = SnapshotPin(
        pool._fetch_latest_snapshot_id, pool._apply_snapshot, min_refresh_gap=0.0
    )
    pool._pin._current = 10

    import contextlib

    class AlwaysMiss:
        def execute(self, *_: Any) -> "AlwaysMiss":
            raise RuntimeError("Catalog Error: Table with name t_gone does not exist!")

        def close(self) -> None:
            pass

    @contextlib.contextmanager
    def fake_conn() -> Generator[Any, None, None]:
        yield AlwaysMiss()

    monkeypatch.setattr(pool, "connection", fake_conn)
    with pytest.raises(RuntimeError, match="does not exist"):
        pool.execute_with_retry("SELECT 1")


def test_unpinned_pool_behaves_as_before(monkeypatch: pytest.MonkeyPatch) -> None:
    p = DuckLakePool(pool_size=1)  # pin_snapshot defaults to False
    assert p.force_pin_refresh() is False

    class PlainCon:
        closed = False

        def close(self) -> None:
            self.closed = True

    con = PlainCon()
    p._pool.put((con, time.time(), 0))
    p._initialized = True
    with p.connection() as c:
        assert c is con
    entries = pool_entries(p)
    assert len(entries) == 1 and entries[0][0] is con


def test_unpinned_init_does_not_warm(monkeypatch: pytest.MonkeyPatch) -> None:
    p = DuckLakePool(pool_size=2)
    warm_calls = {"n": 0}
    created: list[Any] = []

    class PlainCon:
        def __init__(self, snapshot: int | None) -> None:
            self.snapshot = snapshot

        def close(self) -> None:
            pass

    def fake_create(
        max_retries: int = 3,
        retry_delay: float = 1.0,
        snapshot_version: int | None = None,
    ) -> Any:
        c = PlainCon(snapshot_version)
        created.append(c)
        return c

    def spy_warm(con: Any) -> None:
        warm_calls["n"] += 1

    monkeypatch.setattr(p, "_create_connection_with_retry", fake_create)
    monkeypatch.setattr(p, "_warm_connection", spy_warm)
    monkeypatch.setattr(
        p, "_fetch_latest_snapshot_id", lambda: pytest.fail("unpinned must not poll")
    )

    class Settings:
        POSTGRES_DATABASE_URI = "postgresql://u:p@localhost/db"
        DUCKLAKE_CATALOG_SCHEMA = "ducklake"

    p.init(Settings())
    assert warm_calls["n"] == 0
    entries = pool_entries(p)
    assert len(entries) == 2
    assert all(e[0].snapshot is None for e in entries)


def test_recycle_aged_rebuilds_base_at_current_pin(pool: DuckLakePool) -> None:
    from goatlib.storage.snapshot_pin import SnapshotPin

    pool.MAX_CONNECTION_AGE_SECONDS = 0  # everything is "old"
    pool._pin = SnapshotPin(pool._fetch_latest_snapshot_id, pool._apply_snapshot)
    pool._pin._current = 10
    old_base = bases(pool)[0]
    pool._recycle_aged()
    entries = pool_entries(pool)
    assert len(entries) == 2
    new_base = bases(pool)[-1]
    assert new_base.snapshot == 10  # same pin, fresh base
    assert all(e[0].base is new_base for e in entries)
    assert old_base.closed


def test_recycle_aged_noop_when_young(pool: DuckLakePool) -> None:
    from goatlib.storage.snapshot_pin import SnapshotPin

    pool._pin = SnapshotPin(pool._fetch_latest_snapshot_id, pool._apply_snapshot)
    pool._pin._current = 10
    n_before = len(bases(pool))
    pool._recycle_aged()
    assert len(bases(pool)) == n_before  # no rebuild
    assert len(pool_entries(pool)) == 2


def test_error_recreate_draws_cursor_from_current_base(pool: DuckLakePool) -> None:
    base = bases(pool)[0]
    n_cursors_before = len(base.cursors)
    with pytest.raises(RuntimeError, match="connection reset"):
        with pool.connection():
            raise RuntimeError("connection reset")  # triggers recreate path
    entries = pool_entries(pool)
    assert len(entries) == 2  # replacement cursor pooled
    assert len(base.cursors) == n_cursors_before + 1  # cheap cursor, no new base
    assert all(e[0].base is base for e in entries)


def test_error_recreate_racing_rebuild_skips_replacement(
    pool: DuckLakePool, monkeypatch: pytest.MonkeyPatch
) -> None:
    raced = {"done": False}
    orig_replace = pool._replace_failed_cursor

    def racing_replace(gen: int) -> None:
        if not raced["done"]:
            raced["done"] = True
            pool._apply_snapshot(11)  # rebuild lands before the slot refill
        orig_replace(gen)

    monkeypatch.setattr(pool, "_replace_failed_cursor", racing_replace)
    with pytest.raises(RuntimeError, match="connection reset"):
        with pool.connection():
            raise RuntimeError("connection reset")
    entries = pool_entries(pool)
    assert len(entries) == 2  # exactly pool_size entries, all current gen
    assert all(e[2] == pool._generation for e in entries)
    new_base = bases(pool)[-1]
    assert all(e[0].base is new_base for e in entries)


def test_rebuild_with_all_cursors_checked_out(pool: DuckLakePool) -> None:
    """The general form of the base-lifetime invariant: a rebuild while
    EVERY cursor is checked out keeps the old base alive until the LAST
    return, and the pool converges to exactly pool_size fresh cursors."""
    old_base = bases(pool)[0]
    with pool.connection():
        with pool.connection():
            pool._apply_snapshot(11)  # rebuild with BOTH cursors checked out
            assert not old_base.closed
        assert not old_base.closed  # one stale cursor still out
    assert old_base.closed  # last outstanding cursor returned

    entries = pool_entries(pool)
    assert len(entries) == 2
    assert all(e[0].base is bases(pool)[-1] for e in entries)


def test_apply_snapshot_skips_stale_target(pool: DuckLakePool) -> None:
    """A racing recycle/reconnect must never regress the pool behind the
    snapshot it already serves (the pin would report a newer snapshot than
    the data, disabling miss-heal and poisoning ETags)."""
    pool._apply_snapshot(11)
    n_bases = len(bases(pool))
    pool._apply_snapshot(10, allow_same=True)  # stale request: must no-op
    assert len(bases(pool)) == n_bases
    assert pool._applied_snapshot == 11
    entries = pool_entries(pool)
    assert all(e[0].base is bases(pool)[-1] for e in entries)


def test_apply_snapshot_same_target_deduped_within_window(
    pool: DuckLakePool,
) -> None:
    """Reconnect storms (many concurrently-failing requests) coalesce onto
    one rebuild via the dedup window; outside the window an allow_same
    re-apply (aged recycle, genuine second heal) does rebuild."""
    pool._apply_snapshot(11, allow_same=True)
    n_bases = len(bases(pool))
    pool._apply_snapshot(11, allow_same=True)  # within window: no-op
    assert len(bases(pool)) == n_bases
    pool._applied_at -= pool.REBUILD_DEDUP_SECONDS + 1  # age the watermark
    pool._apply_snapshot(11, allow_same=True)  # outside window: rebuilds
    assert len(bases(pool)) == n_bases + 1


def test_connection_error_triggers_pinned_reconnect(
    pool: DuckLakePool, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A dead base breaks all cursors; the pool method must rebuild it
    instead of redrawing doomed cursors until the next snapshot advance."""
    from goatlib.storage.snapshot_pin import SnapshotPin

    pool._pin = SnapshotPin(pool._fetch_latest_snapshot_id, pool._apply_snapshot)
    pool._pin._current = 10
    reconnects = {"n": 0}
    orig_reconnect = pool.reconnect

    def spy_reconnect() -> None:
        reconnects["n"] += 1
        orig_reconnect()

    monkeypatch.setattr(pool, "reconnect", spy_reconnect)
    bases(pool)[0].close()  # kill the base -> every cursor errors
    result = pool.execute_with_retry("SELECT 1", fetch_all=False)
    assert result == (1,)  # healed within the retry budget
    assert reconnects["n"] >= 1
    entries = pool_entries(pool)
    assert all(not e[0].base.closed for e in entries)


def test_an_invalidated_database_is_a_connection_error() -> None:
    assert is_connection_error(RuntimeError(INVALIDATED))


@pytest.mark.parametrize("just_rebuilt", [False, True])
def test_an_invalidated_base_is_rebuilt(pool: DuckLakePool, just_rebuilt: bool) -> None:
    """After an internal error DuckDB invalidates the database, and every cursor
    of the shared base fails: the next query rebuilds the base and answers,
    also when the base was built moments ago (within the dedup window that
    coalesces reconnect storms)."""
    from goatlib.storage.snapshot_pin import SnapshotPin

    pool._pin = SnapshotPin(pool._fetch_latest_snapshot_id, pool._apply_snapshot)
    pool._pin._current = 10
    if just_rebuilt:
        pool._apply_snapshot(10, allow_same=True)
    poisoned = bases(pool)[-1]
    poisoned.invalidated = True
    assert pool.execute_with_retry("SELECT 1", fetch_all=False) == (1,)
    entries = pool_entries(pool)
    assert len(entries) == 2
    assert all(e[0].base is not poisoned for e in entries)
    # Later queries answer too.
    assert pool.execute_with_retry("SELECT 1", fetch_all=False) == (1,)


def test_reconnect_within_the_window_keeps_a_base_that_answers(
    pool: DuckLakePool,
) -> None:
    """Reconnect storms still coalesce onto one rebuild while the new base answers."""
    from goatlib.storage.snapshot_pin import SnapshotPin

    pool._pin = SnapshotPin(pool._fetch_latest_snapshot_id, pool._apply_snapshot)
    pool._pin._current = 10
    pool.reconnect()
    n_bases = len(bases(pool))
    pool.reconnect()
    pool.reconnect()
    assert len(bases(pool)) == n_bases


def test_transient_data_error_retries_without_rebuild(
    pool: DuckLakePool, monkeypatch: pytest.MonkeyPatch
) -> None:
    """S3/object-store blips ('failed to get data file list') must retry on
    the same base instead of tearing it down with a full catalog rebuild."""
    from goatlib.storage.snapshot_pin import SnapshotPin

    pool._pin = SnapshotPin(pool._fetch_latest_snapshot_id, pool._apply_snapshot)
    pool._pin._current = 10
    reconnects = {"n": 0}
    monkeypatch.setattr(
        pool, "reconnect", lambda: reconnects.__setitem__("n", reconnects["n"] + 1)
    )
    calls = {"n": 0}

    class BlipThenOk:
        def execute(self, *_: Any) -> "BlipThenOk":
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("IO Error: Failed to get data file list from s3")
            return self

        def fetchone(self) -> tuple[int]:
            return (7,)

        def fetchall(self) -> list[tuple[int]]:
            return [(7,)]

        def close(self) -> None:
            pass

    import contextlib

    @contextlib.contextmanager
    def fake_conn() -> Generator[Any, None, None]:
        yield BlipThenOk()

    monkeypatch.setattr(pool, "connection", fake_conn)
    assert pool.execute_with_retry("SELECT 1", fetch_all=False) == (7,)
    assert calls["n"] == 2  # retried
    assert reconnects["n"] == 0  # no base rebuild for a transient blip


def test_scaled_memory_limit() -> None:
    p = DuckLakePool(pool_size=4, pin_snapshot=True)
    p._memory_limit = "1.5GB"
    assert p._scaled_memory_limit() == "6GB"
    p._memory_limit = "512MB"
    assert p._scaled_memory_limit() == "2048MB"
    p._memory_limit = "80%"  # DuckDB-valid but unscalable: keep per-conn value
    assert p._scaled_memory_limit() is None
    p._memory_limit = None
    assert p._scaled_memory_limit() is None


def test_fetch_latest_snapshot_id_installs_postgres_before_load(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fresh containers have no preinstalled extensions: the lazily created
    poll connection must INSTALL postgres before LOAD or first boot fails."""
    import duckdb as duckdb_module

    p = DuckLakePool(pool_size=1, pin_snapshot=True)
    p._catalog_schema = "ducklake"
    p._postgres_uri = "postgresql://u:p@localhost/db"
    executed: list[str] = []

    class SpyCon:
        def execute(self, sql: str, *a: Any) -> "SpyCon":
            executed.append(sql)
            return self

        def fetchall(self) -> list[tuple[int]]:
            return [(5,)]

        def close(self) -> None:
            pass

    monkeypatch.setattr(duckdb_module, "connect", lambda: SpyCon())
    assert p._fetch_latest_snapshot_id() == 5
    install_idx = executed.index("INSTALL postgres")
    load_idx = executed.index("LOAD postgres")
    assert install_idx < load_idx


def test_fetch_latest_snapshot_id_holds_poll_lock() -> None:
    p = DuckLakePool(pool_size=1, pin_snapshot=True)
    p._catalog_schema = "ducklake"
    observed: dict[str, bool] = {}

    class FakePollCon:
        def execute(self, *_: Any) -> "FakePollCon":
            observed["locked"] = p._poll_lock.locked()
            return self

        def fetchall(self) -> list[tuple[int]]:
            return [(7,)]

        def close(self) -> None:
            pass

    p._poll_con = FakePollCon()
    assert p._fetch_latest_snapshot_id() == 7
    assert observed["locked"] is True
    assert not p._poll_lock.locked()
