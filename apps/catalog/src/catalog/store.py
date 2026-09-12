"""DuckDB-backed catalog store.

Exposes ``mirror_items.parquet`` and ``mirror_collections.parquet`` as two
DuckDB **views** (plus ``nuts.parquet`` as a table), and watches the
``VERSION`` marker file for changes so a fresh sync is picked up without
restarting the service.

Views rather than materialised tables: at the 1M-item target a table costs the
pod its own copy of the data on every file swap, while parquet gives
projection and row-group pruning for free and the page cache does the rest.
There is no full-text index -- one would have to be rebuilt in every pod on
every swap, and cannot be built over a view at all; free-text scans the
mirror's precomputed ``search_text`` column instead.

Concurrency model:

- Reads run against a per-call cursor cloned from a connection reference
  snapshotted at call start (``con = self._state.con``; ``cur =
  con.cursor()``). A ``DuckDBPyConnection`` must not be driven from
  multiple threads at once, but ``cursor()`` is a cheap per-call clone that
  shares the in-memory database, so concurrent callers never contend on the
  same cursor object.
- Everything a reload replaces -- connection, both registries, ETag seed --
  lives in ONE ``CatalogState`` held as ``self._state``, so the swap is a single
  rebinding. A caller that needs the registry *and* the connection to agree
  (it compiles SQL from one and runs it on the other) takes ``snapshot()``
  once, instead of reading two attributes a reload can land between.
- Only one reload runs at a time (``_reload_lock``, acquired
  non-blocking): ``ensure_current`` runs on every request, so without it a
  sync landing under load starts a full rebuild in every concurrent
  request and discards all but one. A caller that loses the race returns
  at once and serves the current data.
- A reload builds a completely new connection (with freshly created
  views + NUTS table) OUTSIDE the lock, so concurrent requests are never
  blocked for the duration of a reload. The lock is
  only held to compare-and-swap ``self._state``/``self._marker``/
  ``self.version``. Because ``_reload_lock`` serialises builds, two of them
  can never be in flight at once, so a slow build cannot land after a
  faster, newer one and regress the store — the single-flight guard
  replaces the swap-generation counter that used to police that.
  Any query already in flight keeps running against the old connection
  object until it completes (dropped, not closed, so it isn't yanked out
  from under an in-flight cursor).
"""

import hashlib
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import duckdb
from goatlib.storage.ducklake import configure_baked_extensions

from catalog.config import CatalogSettings
from catalog.services.registry import QueryableRegistry, build_registry

#: Empty-relation fallbacks, used only when no mirror file exists yet. They
#: declare what the service's own SQL references -- the mirror carries more
#: (every published column, passed through), which is why these are a floor and
#: not the schema.
_ITEM_COLUMNS_SQL = """
    id VARCHAR,
    collection VARCHAR,
    title VARCHAR,
    description VARCHAR,
    license VARCHAR,
    category VARCHAR,
    language_code VARCHAR,
    publisher VARCHAR,
    search_text VARCHAR,
    geometry GEOMETRY,
    datetime TIMESTAMPTZ,
    datetime_start TIMESTAMPTZ,
    datetime_end TIMESTAMPTZ,
    created TIMESTAMPTZ,
    updated TIMESTAMPTZ,
    parquet_url VARCHAR,
    "goat:layerType" VARCHAR,
    "goat:geometryType" VARCHAR,
    "goat:geographical_code" VARCHAR,
    bbox_xmin DOUBLE,
    bbox_ymin DOUBLE,
    bbox_xmax DOUBLE,
    bbox_ymax DOUBLE,
    member_count BIGINT
"""

_COLLECTION_COLUMNS_SQL = """
    id VARCHAR,
    title VARCHAR,
    description VARCHAR,
    license VARCHAR,
    category VARCHAR,
    language_code VARCHAR,
    publisher VARCHAR,
    search_text VARCHAR,
    geometry GEOMETRY,
    updated TIMESTAMPTZ,
    datetime TIMESTAMPTZ,
    datetime_start TIMESTAMPTZ,
    datetime_end TIMESTAMPTZ,
    "goat:geometryType" VARCHAR,
    "goat:topicRelevance" VARCHAR,
    "goat:topicRelevanceScore" BIGINT,
    thumbnail_item VARCHAR,
    bbox_xmin DOUBLE,
    bbox_ymin DOUBLE,
    bbox_xmax DOUBLE,
    bbox_ymax DOUBLE,
    member_count BIGINT
"""

_NUTS_COLUMNS_SQL = """
    nuts_id VARCHAR,
    nuts_name VARCHAR,
    level INTEGER,
    country VARCHAR,
    geometry GEOMETRY
"""

#: Reload trigger: the VERSION file's (mtime, stripped content) plus the
#: (mtime, size) of every file the store serves.
#:
#: The parquet stats are part of the marker because the served payload now *is*
#: those files (the relations are views over them, not resident copies). The
#: sync task replaces the files and only then writes VERSION, so keying the
#: reload on VERSION alone left a window in which a request read new bytes
#: while the store still stamped the old ETag onto the response -- the exact
#: body/tag mismatch `_content_digest` exists to prevent. A few extra `stat()`
#: calls per request close it.
#:
#: Never ``None``: an absent VERSION contributes ``(0.0, "")`` rather than
#: short-circuiting the whole marker. `nuts.parquet` has a *different producer*
#: (`goatlib.tasks.sync_nuts`), so a deployment where NUTS synced before the
#: first catalog sync would otherwise compare ``None == None`` forever and
#: never pick the NUTS file up.
_Marker = tuple[float, str, float, int]


@dataclass
class CatalogState:
    """One generation of the served catalog: the connection, what is queryable
    on it, and the ETag seed for the bytes behind it.

    Built from scratch by ``CatalogStore._build`` and applied under the lock on
    swap-in. Handed out whole by ``CatalogStore.snapshot()`` so a caller can pin
    a request to one generation."""

    con: duckdb.DuckDBPyConnection
    marker: _Marker
    version: str
    #: Queryables of the *items* relation -- what Item Search, `/queryables`
    #: and the facets are built from.
    registry: QueryableRegistry
    #: Queryables of the *collections* relation, for Collection Search.
    collection_registry: QueryableRegistry
    etag_seed: str


class CatalogStore:
    """Owns the DuckDB connection serving catalog + nuts queries."""

    #: Items and collections are separate relations, as they are published and
    #: as pgstac stores them: an Item Search never scans collection rows, and
    #: no column has to mean two things depending on which kind a row is.
    ITEMS = "items"
    COLLECTIONS = "collections"
    NUTS = "nuts"

    def __init__(self, settings: CatalogSettings) -> None:
        self._settings = settings
        self._lock = threading.Lock()
        #: Single-flight guard: held for the duration of a rebuild so that N
        #: concurrent requests seeing a changed marker produce one build, not
        #: N. Separate from `_lock`, which is only ever held for the swap.
        self._reload_lock = threading.Lock()
        self.version: str = ""
        self.loaded_at: datetime = datetime.now(timezone.utc)
        self._marker: _Marker = (0.0, "", 0.0, 0)
        #: The whole swappable generation in ONE attribute, so a reload is a
        #: single rebinding and no reader can see half of it.
        self._state: CatalogState = self._build()
        self._marker = self._state.marker
        self.version = self._state.version
        self.loaded_at = datetime.now(timezone.utc)

    def _content_digest(self) -> str:
        """A digest of the files this store serves, for use as the ETag seed.

        Deliberately NOT the upstream ``VERSION`` marker. That marker
        identifies the harvester's published file, but the mirror is *derived*
        from it (see ``goatlib.tasks.catalog_mirror``), so the same upstream
        version can yield different served bytes whenever the converter
        changes -- and it has. Seeding the ETag from the upstream version made
        a client that cached a stale body revalidate into a 304 forever,
        because the tag it presented still matched.

        A digest of the local files changes if and only if what we serve
        changes, and -- unlike an mtime or a process-local counter -- is
        identical across replicas holding the same file, so it does not
        needlessly break cache hits when a pod restarts or a second pod
        answers. Read in chunks and computed once per load, never per request.
        """
        digest = hashlib.sha256()
        for path in (
            self._settings.items_path,
            self._settings.collections_path,
            self._settings.nuts_path,
        ):
            try:
                with path.open("rb") as handle:
                    digest.update(path.name.encode())
                    while chunk := handle.read(1024 * 1024):
                        digest.update(chunk)
            except FileNotFoundError:
                # An absent file is itself part of the served state: no NUTS
                # file means /stac/nuts answers empty, and that answer must
                # get a different tag than one served with NUTS present.
                digest.update(f"{path.name}:absent".encode())
        return digest.hexdigest()[:32]

    def _read_marker(self) -> _Marker:
        version_path = self._settings.version_path
        version_mtime, version_text = 0.0, ""
        try:
            # stat + read as one guarded step: they are two syscalls against a
            # file the sync task replaces, and this runs on the request path,
            # so a swap landing between them must not raise out of a handler.
            version_mtime = version_path.stat().st_mtime
            version_text = version_path.read_text().strip()
        except OSError:
            pass
        mtime, size = 0.0, 0
        # NUTS is in here with the two mirror files because it has its own
        # producer (`goatlib.tasks.sync_nuts`, a Eurostat release rather than a
        # harvest) and therefore its own swap. Watching only the catalog files
        # meant a fresh nuts.parquet was not picked up until something else
        # changed or the pod restarted.
        for path in (
            self._settings.items_path,
            self._settings.collections_path,
            self._settings.nuts_path,
        ):
            try:
                mirror = path.stat()
            except FileNotFoundError:
                continue
            # Summed rather than tupled per file: the marker only has to
            # *change* when any of them does, and one pair keeps the type flat.
            mtime = max(mtime, mirror.st_mtime)
            size += mirror.st_size
        return (version_mtime, version_text, mtime, size)

    def _load_extensions(self, con: duckdb.DuckDBPyConnection) -> None:
        """Load the ``spatial`` extension this store needs.

        ``configure_baked_extensions`` (shared with the other services --
        see ``goatlib.storage.ducklake``) points the connection at the
        image's baked ``DUCKDB_EXTENSION_DIRECTORY`` when it's set: in that
        case the extension is already on local disk (see the Dockerfile's
        bake step) and only needs ``LOAD``, never ``INSTALL`` -- an ``INSTALL``
        here would otherwise reach out to extensions.duckdb.org on every
        single store build (every process start AND every catalog reload),
        defeating the whole point of baking them in. Unset (local dev),
        this falls back to the normal download-on-INSTALL path.
        """
        try:
            baked = configure_baked_extensions(con)
            if baked:
                con.execute("LOAD spatial;")
            else:
                con.execute("INSTALL spatial;")
                con.execute("LOAD spatial;")
        except duckdb.Error as exc:
            raise RuntimeError(
                "Failed to install/load the DuckDB 'spatial' extension. "
                "It is cached under ~/.duckdb after the first successful "
                "install; on an offline host, point DuckDB at a local "
                "extension repository (custom_extension_repository setting) "
                "instead of the network default."
            ) from exc

    def _configure(self, con: duckdb.DuckDBPyConnection) -> None:
        """Connection settings that shape memory behaviour.

        The catalog view is scanned per request, so parquet footers must not be
        re-read every time: the object cache keeps them. ``temp_directory`` is
        what lets DuckDB spill instead of raising ``OutOfMemoryException`` --
        an in-memory database has no spill target by default, so a heavy
        concurrent moment is a hard failure rather than a slow query.
        ``memory_limit`` and ``threads`` stay unset unless configured, so the
        defaults (80% of RAM, one thread per core) still apply.
        """
        con.execute("SET enable_object_cache=true")
        temp_dir = self._settings.duckdb_temp_dir
        temp_dir.mkdir(parents=True, exist_ok=True)
        con.execute(f"SET temp_directory='{temp_dir.as_posix()}'")
        if self._settings.duckdb_memory_limit:
            con.execute(f"SET memory_limit='{self._settings.duckdb_memory_limit}'")
        if self._settings.duckdb_threads:
            con.execute(f"SET threads={self._settings.duckdb_threads}")

    def _build(self) -> CatalogState:
        """Build a brand-new connection, catalog view and NUTS table.

        Deliberately does NOT touch ``self`` — this runs outside the lock
        (see ``ensure_current``), so mutating shared state here would race
        with a concurrent build. The caller decides, under the lock,
        whether to swap this result in or discard it.
        """
        con = duckdb.connect()
        self._load_extensions(con)
        self._configure(con)

        marker = self._read_marker()
        version = marker[1]

        # VIEWs, not materialized tables: the mirror stays on disk and DuckDB
        # reads only the columns a query projects. Loading it resident cost
        # 3.6 GB at the 1M-item target (plus another 1.8 GB for the full-text
        # index that used to be built here, and a second copy during every
        # reload, since a build runs while the old connection still serves).
        # Scanning the files instead costs tens of milliseconds per query and
        # nothing at rest -- `q` is answered by the mirror's precomputed
        # `search_text` column, so no index needs to exist. Parquet metadata is
        # cached between queries via the object cache in `_configure`.
        for relation, path, fallback in (
            (self.ITEMS, self._settings.items_path, _ITEM_COLUMNS_SQL),
            (
                self.COLLECTIONS,
                self._settings.collections_path,
                _COLLECTION_COLUMNS_SQL,
            ),
        ):
            if marker is not None and path.exists():
                # The path is inlined rather than bound: DuckDB cannot prepare a
                # parameter inside CREATE VIEW ("Unexpected prepared
                # parameter"). Doubling quotes is the only escape a
                # single-quoted DuckDB string literal needs.
                literal = path.as_posix().replace("'", "''")
                con.execute(
                    f"CREATE VIEW {relation} AS SELECT * FROM read_parquet('{literal}')"
                )
            else:
                con.execute(f"CREATE TABLE {relation} ({fallback})")
                version = ""

        nuts_path = self._settings.nuts_path
        if nuts_path.exists():
            # `ST_SetCRS`, not `ST_Transform`: the coordinates are already
            # lon/lat degrees and must not move. Only the *declared* CRS is
            # changed, because the two producers label the same thing
            # differently -- Eurostat GISCO's NUTS file says `EPSG:4326` while
            # the harvester's GeoParquet says `OGC:CRS84` -- and DuckDB refuses
            # `ST_Intersects` across mismatched declarations. Without this, the
            # spatial filter fails with a binder error (`?nuts=`, i.e. every
            # catalog-page request).
            con.execute(
                f"""
                CREATE TABLE {self.NUTS} AS
                SELECT * REPLACE (ST_SetCRS(geometry, 'OGC:CRS84') AS geometry)
                FROM read_parquet(?)
                """,
                [nuts_path.as_posix()],
            )
        else:
            con.execute(f"CREATE TABLE {self.NUTS} ({_NUTS_COLUMNS_SQL})")

        # One registry per relation, derived from the relation that was just
        # built, so neither can describe a schema other than the one loaded.
        # They differ for real -- a collection has no `parquet_url` and no
        # `created` -- and advertising the item ones as filterable for Collection
        # Search would be a small lie. The relation is passed because two columns
        # of the same name are not always the same queryable: a collection's
        # `goat:geometryType` describes the dataset for display and must not
        # shadow the member semi-join a geometry *filter* needs.
        def registry_for(relation: str) -> QueryableRegistry:
            columns = {
                row[0]: row[1]
                for row in con.execute(f"DESCRIBE SELECT * FROM {relation}").fetchall()
            }
            return build_registry(
                columns,
                relation="collections" if relation == self.COLLECTIONS else "items",
            )

        return CatalogState(
            con=con,
            marker=marker,
            version=version,
            registry=registry_for(self.ITEMS),
            collection_registry=registry_for(self.COLLECTIONS),
            etag_seed=self._content_digest(),
        )

    def ensure_current(self) -> None:
        """Reload if the marker changed; otherwise a cheap no-op."""
        marker = self._read_marker()
        if marker == self._marker:
            return

        # Single-flight, and deliberately non-blocking. A rebuild opens a
        # connection, recreates the views, materialises NUTS and SHA-256s
        # every served file; without this guard a sync landing under load
        # started that work in *every* concurrent request and threw all but
        # one result away. A caller that loses the race returns immediately
        # and serves the current data -- correct, because a reload never
        # blocks reads by design, and this request was already going to
        # answer from the old connection while the build ran.
        if not self._reload_lock.acquire(blocking=False):
            return
        try:
            self._reload()
        finally:
            self._reload_lock.release()

    def _reload(self) -> None:
        """Build a new connection and swap it in.

        The caller must hold ``_reload_lock``, which is what makes this safe
        without a swap-generation counter: builds are serialised, so the
        result being swapped in here is always the newest one attempted.
        """
        # Build entirely OUTSIDE `_lock`: this is the expensive part
        # (extension load + NUTS materialisation + digest) and must not block
        # readers for its duration.
        built = self._build()

        with self._lock:
            if built.marker == self._marker:
                # Nothing actually changed between the check in
                # `ensure_current` and the build -- discard the redundant
                # connection rather than swapping an identical one in.
                built.con.close()
                return
            self._state = built
            self._marker = built.marker
            self.version = built.version
            self.loaded_at = datetime.now(timezone.utc)

    @property
    def settings(self) -> CatalogSettings:
        """The settings this store was built from, for handlers that need them."""
        return self._settings

    @property
    def etag_seed(self) -> str:
        """Seed for response ETags: a digest of the files currently served.

        Swapped with the connection under the same lock, so a caller cannot
        stamp a tag from one generation onto a body built from another.
        """
        return self._state.etag_seed

    @property
    def registry(self) -> QueryableRegistry:
        """What is filterable/sortable/facetable in the currently loaded table.

        A convenience read of ``snapshot().registry`` for callers that only
        need the queryables (``/queryables``, the conformance classes, MCP's
        tool descriptions). A caller that goes on to *run* SQL built from it
        should take ``snapshot()`` and pass its connection, so the schema it
        compiled against is the one it executes on.
        """
        return self._state.registry

    @property
    def collection_registry(self) -> QueryableRegistry:
        """What is filterable/sortable in the *collections* relation.

        Read the same way as :attr:`registry`, and separate from it because the
        two relations genuinely differ: a collection has no ``parquet_url``,
        no ``goat:geometryType`` and no bundle representative.
        """
        return self._state.collection_registry

    def snapshot(self) -> CatalogState:
        """The current generation, as one object.

        A caller that reads the registry, builds SQL from it and then runs that
        SQL is doing two things a reload sits between: taking a snapshot first
        pins both to the same generation, so it cannot compile against a new
        schema and execute against the old connection (or the reverse). The
        connection a snapshot holds stays usable afterwards -- a reload
        replaces the store's reference, it does not close the connection.
        """
        return self._state

    def query(
        self,
        sql: str,
        params: list[Any] | None = None,
        con: duckdb.DuckDBPyConnection | None = None,
    ) -> list[tuple[Any, ...]]:
        con = con or self._state.con
        cur = con.cursor()
        try:
            result = (
                cur.execute(sql, params) if params is not None else cur.execute(sql)
            )
            return result.fetchall()
        finally:
            cur.close()

    def query_dicts(
        self,
        sql: str,
        params: list[Any] | None = None,
        con: duckdb.DuckDBPyConnection | None = None,
    ) -> list[dict[str, Any]]:
        con = con or self._state.con
        cur = con.cursor()
        try:
            result = (
                cur.execute(sql, params) if params is not None else cur.execute(sql)
            )
            rows = result.fetchall()
            columns = [d[0] for d in result.description]
            return [dict(zip(columns, row, strict=True)) for row in rows]
        finally:
            cur.close()
