"""Smoke tests for the synthetic catalog fixture generator itself.

These tests read the generated parquet directly with DuckDB (bypassing the
catalog service) to pin down the deterministic content contract that later
tasks (store + API) depend on verbatim.
"""

import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any

import duckdb
import pytest
from goatlib.tasks.sync_catalog import (
    REQUIRED_COLLECTION_COLUMNS,
    REQUIRED_ITEM_COLUMNS,
)

from catalog.config import CatalogSettings
from catalog.services import search as search_module
from catalog.services.search import SearchParams, search_items
from catalog.services.stac_build import collection_from_row, item_from_row
from catalog.store import _ITEM_COLUMNS_SQL, CatalogStore

from .fixtures.gen_catalog import write_catalog, write_nuts


def _read_all(parquet_path: Path) -> tuple[list[str], list[tuple[Any, ...]]]:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    result = con.execute(f"SELECT * FROM read_parquet('{parquet_path.as_posix()}')")
    rows = result.fetchall()
    columns = [d[0] for d in result.description]
    con.close()
    return columns, rows


def test_fixture_readable(tmp_path: Path) -> None:
    write_catalog(tmp_path)
    columns, rows = _read_all(tmp_path / "mirror_items.parquet")

    assert len(rows) == 199

    # A parquet has no inherent row order and the converter does not impose
    # one, so the pinned row is looked up rather than indexed.
    by_id = {r[columns.index("id")]: dict(zip(columns, r, strict=True)) for r in rows}
    row0 = by_id["radverkehrsnetz-dresden-0"]
    assert row0["id"] == "radverkehrsnetz-dresden-0"
    assert row0["title"] == "Radverkehrsnetz Dresden 2018"
    assert row0["license"] == "CC-BY-4.0"
    assert row0["category"] == "transportation"
    assert row0["language"] == {"code": "de"}
    assert row0["language_code"] == "de"
    assert row0["collection"] is None

    doc0 = item_from_row(row0)
    assert doc0["type"] == "Feature"
    assert doc0["properties"]["title"] == "Radverkehrsnetz Dresden 2018"
    # The mirror's internal columns must never reach a served document.
    assert "search_text" not in doc0["properties"]
    assert "member_count" not in doc0["properties"]

    bundle_members = [row for row in by_id.values() if row["collection"] == "src-1"]
    assert len(bundle_members) == 4
    assert {r["member_count"] for r in bundle_members} == {4}

    # Collections are their own relation now, not rows with a discriminator, and
    # the fixture publishes one per dataset — a Collection per single-layer
    # dataset plus the bundle — as the harvester does (0 of the real catalog's
    # 10,793 items are orphans; row 0 is the fixture's one deliberate exception).
    ccolumns, crows = _read_all(tmp_path / "mirror_collections.parquet")
    assert len(crows) > 1
    by_collection_id = {
        dict(zip(ccolumns, row, strict=True))["id"]: dict(
            zip(ccolumns, row, strict=True)
        )
        for row in crows
    }
    collection_row = by_collection_id["src-1"]
    collection_doc = collection_from_row(collection_row)
    assert collection_doc["type"] == "Collection"
    assert collection_doc["id"] == "src-1"


def test_fixture_deterministic(tmp_path: Path) -> None:
    dir_a = tmp_path / "a"
    dir_b = tmp_path / "b"
    dir_a.mkdir()
    dir_b.mkdir()

    write_catalog(dir_a)
    write_catalog(dir_b)

    columns_a, rows_a = _read_all(dir_a / "mirror_items.parquet")
    columns_b, rows_b = _read_all(dir_b / "mirror_items.parquet")

    assert columns_a == columns_b
    assert len(rows_a) == len(rows_b)
    # Sorted: determinism is about content, and row order is not part of it.
    assert sorted(rows_a, key=str) == sorted(rows_b, key=str)


def test_store_load_and_count(tmp_path: Path) -> None:
    write_catalog(tmp_path)
    write_nuts(tmp_path)

    store = CatalogStore(CatalogSettings(data_dir=tmp_path))

    rows = store.query(f"SELECT count(*) FROM {store.ITEMS}")
    assert rows[0][0] == 199
    assert store.version == "v-test-1"
    assert isinstance(store.loaded_at, datetime)

    nuts_rows = store.query(f"SELECT count(*) FROM {store.NUTS}")
    assert nuts_rows[0][0] == 17


def test_store_serves_the_payload_from_the_file(tmp_path: Path) -> None:
    """The catalog is a view over the parquet, with no full-text index.

    Materialising it cost 3.6 GB at the 1M-item target and the FTS index a
    further 1.8 GB, rebuilt on every harvest -- while a plain scan of the
    mirror's precomputed `search_text` column answers `q` faster. This asserts
    the shape that decision produced, since nothing else would notice if a
    future change quietly made the catalog resident again.
    """
    write_catalog(tmp_path)
    store = CatalogStore(CatalogSettings(data_dir=tmp_path))

    views = store.query(
        "SELECT view_name FROM duckdb_views() WHERE view_name = ?", [store.ITEMS]
    )
    assert views, "the catalog should be a view over the parquet"
    tables = store.query(
        "SELECT table_name FROM duckdb_tables() WHERE table_name = ?", [store.ITEMS]
    )
    assert not tables, "the catalog must not be materialised"
    assert not store.query(
        "SELECT * FROM duckdb_tables() WHERE schema_name LIKE 'fts%'"
    ), "no full-text index should exist"

    hits = store.query(
        f"SELECT id FROM {store.ITEMS} WHERE contains(search_text, 'radverkehrsnetz')"
    )
    assert len(hits) > 0


def test_store_ensure_current_noop_when_unchanged(tmp_path: Path) -> None:
    write_catalog(tmp_path)

    store = CatalogStore(CatalogSettings(data_dir=tmp_path))
    con_before = store.snapshot().con

    store.ensure_current()

    assert store.snapshot().con is con_before


def test_store_reload_on_marker_change(tmp_path: Path) -> None:
    write_catalog(tmp_path, n=200, version="v-test-1")

    store = CatalogStore(CatalogSettings(data_dir=tmp_path))
    con_before = store.snapshot().con
    assert store.query(f"SELECT count(*) FROM {store.ITEMS}")[0][0] == 199

    write_catalog(tmp_path, n=50, version="v-test-2")
    store.ensure_current()

    assert store.snapshot().con is not con_before
    assert store.version == "v-test-2"
    assert store.query(f"SELECT count(*) FROM {store.ITEMS}")[0][0] == 49


def test_store_absent_file_boot(tmp_path: Path) -> None:
    store = CatalogStore(CatalogSettings(data_dir=tmp_path))

    rows = store.query(f"SELECT count(*) FROM {store.ITEMS}")
    assert rows[0][0] == 0
    assert store.version in ("", None)


def test_empty_relations_carry_every_column_the_service_queries(
    tmp_path: Path,
) -> None:
    """The stand-in schema must be a superset of what the SQL names.

    The point of the empty relations is that a deployment with no mirror yet
    answers "no results" instead of failing — and a column the service names but
    the stand-in omits turns that into a binder error, i.e. a 400 on a query that
    is perfectly valid. It happened: the collections stand-in had no `datetime`,
    so `GET /stac/collections?datetime=…` reported "Referenced column
    datetime_start not found" against an empty catalog.

    Checked against the converter's own contract rather than a list repeated
    here, so a column added to the mirror cannot be forgotten in this schema.
    """
    store = CatalogStore(CatalogSettings(data_dir=tmp_path))

    for relation, required in (
        (store.ITEMS, REQUIRED_ITEM_COLUMNS),
        (store.COLLECTIONS, REQUIRED_COLLECTION_COLUMNS),
    ):
        present = {row[0] for row in store.query(f"DESCRIBE SELECT * FROM {relation}")}
        missing = set(required) - present
        assert not missing, f"{relation} stand-in is missing {sorted(missing)}"


def test_store_query_dicts(tmp_path: Path) -> None:
    write_catalog(tmp_path)

    store = CatalogStore(CatalogSettings(data_dir=tmp_path))

    rows = store.query_dicts(
        f"SELECT id, title FROM {store.ITEMS} WHERE id = ?",
        ["radverkehrsnetz-dresden-0"],
    )
    assert rows == [
        {"id": "radverkehrsnetz-dresden-0", "title": "Radverkehrsnetz Dresden 2018"}
    ]


def test_store_query_survives_slow_rebuild(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A query must complete while a reload's ``_build()`` is in flight on
    another thread -- proving ``_build()`` runs OUTSIDE the lock and never
    blocks concurrent readers.

    Note what is deliberately *not* asserted: that the in-flight query still
    sees the pre-reload row count. The catalog is a view over the parquet, so
    replacing that file is visible to the old connection immediately; only the
    connection swap and the ETag stamping are serialised by the lock. Reload is
    keyed on the parquet's stat as well as VERSION (see ``_read_marker``) so a
    request never mixes new content with an old tag."""
    write_catalog(tmp_path, n=200, version="v-test-1")
    store = CatalogStore(CatalogSettings(data_dir=tmp_path))
    con_before = store.snapshot().con

    build_started = threading.Event()
    release_build = threading.Event()
    original_build = store._build

    def slow_build() -> Any:
        build_started.set()
        assert release_build.wait(timeout=5), "test deadlocked waiting for release"
        return original_build()

    monkeypatch.setattr(store, "_build", slow_build)
    write_catalog(tmp_path, n=50, version="v-test-2")

    reload_thread = threading.Thread(target=store.ensure_current)
    reload_thread.start()
    assert build_started.wait(timeout=5), "rebuild never started"

    # The rebuild thread is parked inside _build(), holding no lock at all, so
    # a query must complete immediately rather than block on the store's lock.
    rows = store.query(f"SELECT count(*) FROM {store.ITEMS}")
    assert rows[0][0] > 0
    assert store.snapshot().con is con_before  # swap hasn't happened yet

    release_build.set()
    reload_thread.join(timeout=5)
    assert not reload_thread.is_alive()

    assert store.version == "v-test-2"
    assert store.snapshot().con is not con_before
    assert store.query(f"SELECT count(*) FROM {store.ITEMS}")[0][0] == 49


def test_concurrent_ensure_current_builds_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A sync landing under load must cost one rebuild, not one per request.

    `ensure_current` runs on *every* request, and a rebuild opens a
    connection, recreates the views, materialises NUTS and digests every
    served file. Without the single-flight guard, ten in-flight requests all
    saw the changed marker and all rebuilt, and nine of those results were
    closed and thrown away.

    The losers do not block: they return at once and answer from the
    connection they already had, which is what a request during a reload
    does anyway.
    """
    write_catalog(tmp_path, n=200, version="v-test-1")
    store = CatalogStore(CatalogSettings(data_dir=tmp_path))
    real_build = store._build

    write_catalog(tmp_path, n=50, version="v-test-2")

    in_build = threading.Event()
    release = threading.Event()
    builds = {"n": 0}
    lock = threading.Lock()

    def counting_build() -> Any:
        with lock:
            builds["n"] += 1
        in_build.set()
        # Hold the winner inside the build so the others are guaranteed to
        # arrive while it is still running -- the exact overlap the guard is
        # for, rather than a hopeful race.
        assert release.wait(timeout=5), "test deadlocked waiting for release"
        return real_build()

    monkeypatch.setattr(store, "_build", counting_build)

    winner = threading.Thread(target=store.ensure_current)
    winner.start()
    assert in_build.wait(timeout=5), "the first build never started"

    losers = [threading.Thread(target=store.ensure_current) for _ in range(5)]
    for thread in losers:
        thread.start()
    for thread in losers:
        thread.join(timeout=5)
        assert not thread.is_alive(), "a losing caller blocked on the rebuild"

    # They returned without rebuilding, and still serve the old data.
    assert builds["n"] == 1
    assert store.version == "v-test-1"

    release.set()
    winner.join(timeout=5)
    assert not winner.is_alive()

    assert builds["n"] == 1
    assert store.version == "v-test-2"
    assert store.query(f"SELECT count(*) FROM {store.ITEMS}")[0][0] == 49


def test_a_caller_that_skipped_reloads_on_its_next_call(tmp_path: Path) -> None:
    """Losing the single-flight race delays a reload; it never skips one.

    The guard is only safe because `ensure_current` runs per request: a
    caller that returned early still sees the new marker next time.
    """
    write_catalog(tmp_path, n=200, version="v-test-1")
    store = CatalogStore(CatalogSettings(data_dir=tmp_path))

    write_catalog(tmp_path, n=50, version="v-test-2")
    store._reload_lock.acquire()  # somebody else is "already rebuilding"
    store.ensure_current()
    assert store.version == "v-test-1"

    store._reload_lock.release()
    store.ensure_current()
    assert store.version == "v-test-2"


def test_nuts_swap_is_picked_up_without_a_catalog_version(tmp_path: Path) -> None:
    """`nuts.parquet` has its own producer, so it must move the marker itself.

    `sync_nuts` and `sync_catalog` are separate tasks: NUTS can land first,
    on a volume where no catalog VERSION exists yet. The marker used to
    short-circuit to `None` in that case, so `None == None` held forever and
    a freshly synced NUTS file was invisible until the pod restarted.
    """
    write_catalog(tmp_path, n=20, version="v-test-1")
    (tmp_path / "VERSION").unlink()
    (tmp_path / "nuts.parquet").unlink(missing_ok=True)

    store = CatalogStore(CatalogSettings(data_dir=tmp_path))
    assert store.query(f"SELECT count(*) FROM {store.NUTS}")[0][0] == 0

    write_nuts(tmp_path)
    store.ensure_current()

    assert store.query(f"SELECT count(*) FROM {store.NUTS}")[0][0] > 0


# --------------------------------------------------------------------------
# Extension loading: the shared goatlib helper (baked dir or INSTALL first)
# --------------------------------------------------------------------------


def test_load_extensions_uses_the_shared_helper(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The store loads ``spatial`` through goatlib's ``load_extensions``, which
    only loads from the image's baked directory and never downloads there
    (its own tests cover both branches)."""
    write_catalog(tmp_path)
    store = CatalogStore(CatalogSettings(data_dir=tmp_path))

    calls: list[tuple[Any, ...]] = []
    monkeypatch.setattr(
        "catalog.store.load_extensions", lambda con, *ext: calls.append(ext)
    )
    store._load_extensions(object())  # type: ignore[arg-type]

    assert calls == [("spatial",)]


def test_store_query_concurrent_threads(tmp_path: Path) -> None:
    """Many threads hammering query() concurrently must all succeed with
    the same result -- guards against sharing one DuckDBPyConnection
    across threads without per-call cursors."""
    write_catalog(tmp_path)
    store = CatalogStore(CatalogSettings(data_dir=tmp_path))

    def run(_: int) -> int:
        rows = store.query(f"SELECT count(*) FROM {store.ITEMS}")
        return int(rows[0][0])

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(run, range(50)))

    assert len(results) == 50
    assert all(r == 199 for r in results)


def test_fixture_matches_the_schema_the_store_declares(tmp_path: Path) -> None:
    """The fixture must carry every column ``_ITEM_COLUMNS_SQL`` declares.

    That constant is what the store creates when no mirror exists -- this app's
    statement of what its own SQL references. The fixture is a *superset*: it is
    built by the real converter, which passes every published column through, so
    extra columns are expected and only a missing one is a fault.

    The fixture used to be a copy of the converter's SQL rather than a call to
    it, and the copy drifted: the suite stayed
    green while production 400'd.
    """
    write_catalog(tmp_path)
    con = duckdb.connect()
    con.execute("LOAD spatial;")
    fixture_columns = [
        row[0]
        for row in con.execute(
            f"DESCRIBE SELECT * FROM read_parquet('{(tmp_path / 'mirror_items.parquet').as_posix()}')"
        ).fetchall()
    ]
    declared = [
        line.strip().split()[0].strip('"')
        for line in _ITEM_COLUMNS_SQL.strip().splitlines()
        if line.strip()
    ]
    con.close()
    missing = set(declared) - set(fixture_columns)
    assert not missing, f"the fixture is missing declared columns: {sorted(missing)}"


def test_a_search_that_straddles_a_reload_stays_on_one_generation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The WHERE clause is compiled from the registry and then run — a reload
    landing in between used to leave the query on a connection the registry did
    not describe, so a column added or dropped by the new file surfaced as a
    binder error on one unlucky request.

    Reproduced by swapping the store mid-call: `build_filters` is where the
    registry has been read and the SQL not yet executed, which is exactly the
    window. What the snapshot pins is the *schema* — the relations and NUTS
    table that connection was built for — not the data: both generations' views
    read the same paths, so the rows a pinned connection returns are whatever is
    on disk when the query runs.
    """
    write_catalog(tmp_path, n=200, version="v-test-1")
    store = CatalogStore(CatalogSettings(data_dir=tmp_path))
    pinned = store.snapshot().con

    ran_on: list[object] = []
    original_query = store.query
    original_dicts = store.query_dicts

    def recording(sql, params=None, con=None):  # type: ignore[no-untyped-def]
        ran_on.append(con)
        return original_query(sql, params, con=con)

    def recording_dicts(sql, params=None, con=None):  # type: ignore[no-untyped-def]
        ran_on.append(con)
        return original_dicts(sql, params, con=con)

    monkeypatch.setattr(store, "query", recording)
    monkeypatch.setattr(store, "query_dicts", recording_dicts)

    original_filters = search_module.build_filters

    def reload_then_filter(*args, **kwargs):  # type: ignore[no-untyped-def]
        write_catalog(tmp_path, n=50, version="v-test-2")
        store.ensure_current()
        return original_filters(*args, **kwargs)

    monkeypatch.setattr(search_module, "build_filters", reload_then_filter)

    rows, matched = search_items(store, SearchParams(limit=5))

    assert store.snapshot().con is not pinned, "the reload did happen mid-call"
    assert len(ran_on) == 2, "count and page"
    assert all(con is pinned for con in ran_on)
    assert len(rows) == 5 and matched > 0


def test_the_etag_changes_when_the_served_documents_change(
    catalog_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Same mirror files, new document shape (an asset the API now announces):
    the tag must change, or browsers keep the old answer through 304s."""
    import catalog.services.stac_build as stac_build

    before = CatalogStore(CatalogSettings(data_dir=catalog_dir))
    before.ensure_current()
    monkeypatch.setattr(stac_build, "DOCUMENT_VERSION", stac_build.DOCUMENT_VERSION + 1)
    after = CatalogStore(CatalogSettings(data_dir=catalog_dir))
    after.ensure_current()
    assert before.etag_seed != after.etag_seed
