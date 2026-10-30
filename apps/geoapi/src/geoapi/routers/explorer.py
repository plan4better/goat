"""The PT network Explorer's data: a GTFS bundle as the browser loads it.

The Explorer runs DuckDB-WASM in the browser over the whole bundle. What it
loads is a snapshot (``goatlib.bundles.explorer.snapshot``): the bundle's
member tables as compact, indexed Parquet, built here on the first request
for a bundle revision and kept on the data volume, so every later open just
downloads files.

- ``GET /bundles/{id}/explorer`` returns the manifest of the bundle's current
  revision: 200 with the files when the snapshot is there, 202 while it is
  being built (poll again; ``Retry-After``), 500 if the build failed (kept
  for a few minutes, then tried again; ``?retry=true`` tries again at once).
- ``GET /bundles/{id}/explorer/r{rev}/s{schema}/{name}.parquet`` returns one
  file. The URL names the revision and schema version, so a file never
  changes; browsers keep it for a month (``FILE_MAX_AGE_SECONDS``).

A build reads the revision and the DuckLake snapshot id together, under the
bundle's advisory lock taken shared (``goatlib.bundles.locks``), and then
reads every table at that snapshot: whatever is written meanwhile, the files
are the data of the revision they are named for.

Builds run one at a time per pod, on their own thread and DuckLake
connection, bounded in memory and spilling to disk, so a large feed neither
blocks the request that asked for it nor the tile and feature pools. Across
pods, a marker file keeps a second pod from building the same revision.
"""

import asyncio
import json
import logging
import os
import shutil
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from goatlib.bundles.explorer.snapshot import (
    FILES,
    ROLES,
    SCHEMA_VERSION,
    build_snapshot,
    write_manifest,
)
from goatlib.bundles.locks import bundle_layers_lock_key_sql
from goatlib.storage import BaseDuckLakeManager
from goatlib.utils.layer import layer_id_to_table_name, resolve_layer_schema

from geoapi.config import settings
from geoapi.deps.auth import get_optional_user_id
from geoapi.deps.authz import enforce_layer_read
from geoapi.services.layer_service import layer_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/bundles", tags=["Explorer"])

#: Where snapshots live: DATA_DIR/explorer/<bundle id>/r<rev>.s<schema>/.
#: Derived from DATA_DIR like the catalog's directories, not a setting of its
#: own. On the data volume every geoapi pod mounts.
EXPLORER_DIR = Path(os.getenv("DATA_DIR", "/app/data")) / "explorer"

#: How long a browser keeps a snapshot file: it never changes under its URL,
#: but a month bounds what a device holds for a bundle it no longer opens.
FILE_MAX_AGE_SECONDS = 30 * 24 * 3600

_GTFS = "pt_network_gtfs"
#: How long a failed build is reported before a request tries again.
_FAILURE_TTL_SECONDS = 300
#: A marker older than this belongs to a build that died with its pod.
_MARKER_TTL_SECONDS = 600
#: A superseded revision is kept this long, so downloads in flight finish.
_KEEP_PREVIOUS_SECONDS = 3600
#: Bounds of one build: a 16 M-row feed takes about 20 s and stays inside.
_BUILD_MEMORY = "512MB"
_BUILD_THREADS = 2

_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="explorer-build")
_builds: dict[tuple[str, int], asyncio.Task[None]] = {}
_failures: dict[tuple[str, int], tuple[float, str]] = {}


def _snapshot_dir(bundle_id: str, revision: int) -> Path:
    return EXPLORER_DIR / bundle_id / f"r{revision}.s{SCHEMA_VERSION}"


def _file_url(bundle_id: str, revision: int, name: str) -> str:
    return f"/bundles/{bundle_id}/explorer/r{revision}/s{SCHEMA_VERSION}/{name}.parquet"


async def _bundle(bundle_id: UUID) -> dict[str, Any]:
    """The bundle's type, revision and members, or 404."""
    pool = layer_service._pool
    if not pool:
        raise HTTPException(status_code=503, detail="Database pool not initialized")
    row = await pool.fetchrow(
        """
        SELECT b.bundle_type, b.layers_revision,
               coalesce(
                   json_object_agg(bl.role, bl.layer_id::text)
                       FILTER (WHERE bl.role IS NOT NULL),
                   '{}'::json
               ) AS members
        FROM customer.bundle b
        LEFT JOIN customer.bundle_layer bl ON bl.bundle_id = b.id
        WHERE b.id = $1 AND b.deleted_at IS NULL
        GROUP BY b.id
        """,
        bundle_id,
    )
    if row is None or row["bundle_type"] != _GTFS:
        raise HTTPException(status_code=404, detail="No public transport bundle")
    members = row["members"]
    if isinstance(members, str):
        members = json.loads(members)
    if "stops" not in members:
        raise HTTPException(status_code=404, detail="The bundle has no stops layer")
    return {"revision": int(row["layers_revision"]), "members": members}


async def _authorize(bundle_id: UUID, user_id: UUID | None) -> dict[str, Any]:
    """The bundle, if the caller may read it.

    Reading a bundle is reading its layers: member layers carry the bundle's
    grants, and a project that holds the bundle shares them with its members
    — the same two ways core lets a bundle be read. So the rule geoapi
    applies to every layer read decides, on the bundle's stops layer."""
    bundle = await _bundle(bundle_id)
    await enforce_layer_read(bundle["members"]["stops"], user_id)
    return bundle


async def _revision_and_snapshot(
    bundle_id: str, manager: BaseDuckLakeManager
) -> tuple[int, int]:
    """The bundle's revision and the DuckLake snapshot holding its data.

    Read together under the bundle's advisory lock, taken shared: a writer
    holds it from claiming a revision until its data is committed."""
    pool = layer_service._pool
    assert pool is not None
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                f"SELECT pg_advisory_xact_lock_shared({bundle_layers_lock_key_sql('$1')})",
                bundle_id,
            )
            revision = await conn.fetchval(
                "SELECT layers_revision FROM customer.bundle WHERE id = $1::uuid",
                bundle_id,
            )
            snapshot = await asyncio.get_running_loop().run_in_executor(
                None, manager.latest_snapshot_id
            )
    return int(revision), int(snapshot)


def _build_sync(
    bundle_id: str,
    revision: int,
    snapshot: int,
    members: dict[str, str],
    manager: BaseDuckLakeManager,
) -> None:
    """Build and publish one snapshot. Runs on the build thread."""
    bundle_dir = EXPLORER_DIR / bundle_id
    bundle_dir.mkdir(parents=True, exist_ok=True)
    target = _snapshot_dir(bundle_id, revision)
    tmp = bundle_dir / f".tmp-r{revision}-{uuid.uuid4().hex}"
    tmp.mkdir()
    spill = tmp / ".spill"
    spill.mkdir()
    started = time.time()
    try:
        with manager.connection() as con:
            con.execute(f"SET memory_limit='{_BUILD_MEMORY}'")
            con.execute(f"SET threads={_BUILD_THREADS}")
            con.execute("SET preserve_insertion_order=false")
            con.execute(f"SET temp_directory='{spill}'")

            tables: dict[str, str] = {}
            for role in ROLES:
                layer_id = members.get(role)
                if not layer_id:
                    continue
                schema = resolve_layer_schema(
                    con,
                    layer_id,
                    settings.DUCKLAKE_CATALOG_SCHEMA,
                    settings.DUCKLAKE_POSTGRES_DATABASE_URI,
                )
                if schema is None:
                    continue
                tables[role] = (
                    # A subquery, so the converter can alias it: DuckDB takes
                    # no alias right after an AT clause.
                    f'(SELECT * FROM lake."{schema}".'
                    f'"{layer_id_to_table_name(layer_id)}" '
                    f"AT (VERSION => {snapshot}))"
                )
            manifest = build_snapshot(con, tables.get, str(tmp))
        shutil.rmtree(spill, ignore_errors=True)
        manifest.update(
            layers_revision=revision,
            snapshot_id=snapshot,
            built_at=time.time(),
            build_seconds=round(time.time() - started, 1),
        )
        write_manifest(str(tmp), manifest)
        try:
            os.rename(tmp, target)
        except OSError:
            # Another pod published this revision first; its files are the same.
            shutil.rmtree(tmp, ignore_errors=True)
        logger.info(
            "Explorer snapshot of bundle %s r%d built in %.1f s",
            bundle_id,
            revision,
            time.time() - started,
        )
        _prune(bundle_id, revision)
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise


def _prune(bundle_id: str, current: int) -> None:
    """Remove superseded snapshots: older revisions, and any revision's of an
    older schema. The one just superseded stays for an hour, for downloads in
    flight."""
    bundle_dir = EXPLORER_DIR / bundle_id
    now = time.time()
    for entry in bundle_dir.iterdir():
        name = entry.name
        if not name.startswith("r") or not entry.is_dir():
            continue
        try:
            rev_text, schema_text = name[1:].split(".s", 1)
            rev, schema = int(rev_text), int(schema_text)
        except ValueError:
            continue
        if rev >= current and schema == SCHEMA_VERSION:
            continue
        recent = now - entry.stat().st_mtime <= _KEEP_PREVIOUS_SECONDS
        if rev < current - 1 or not recent:
            shutil.rmtree(entry, ignore_errors=True)


def _marker(bundle_id: str, revision: int) -> Path:
    return EXPLORER_DIR / bundle_id / f".building-r{revision}"


async def _build(bundle_id: str, revision: int, members: dict[str, str]) -> None:
    """Build the bundle's current revision (``revision`` as the request saw
    it; the build reads it again under the lock)."""
    loop = asyncio.get_running_loop()
    # Its own connection, for the duration of the build: every DuckLake
    # connection holds the catalog in memory, and builds are rare.
    manager = BaseDuckLakeManager(
        read_only=True, application_name="goat-geoapi-explorer"
    )
    marker: Path | None = None
    try:
        await loop.run_in_executor(_executor, manager.init, settings)
        revision, snapshot = await _revision_and_snapshot(bundle_id, manager)
        marker = _marker(bundle_id, revision)
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(f"{os.uname().nodename} {os.getpid()} {time.time()}")
        await loop.run_in_executor(
            _executor, _build_sync, bundle_id, revision, snapshot, members, manager
        )
    except Exception as e:
        logger.exception("Explorer snapshot of bundle %s failed", bundle_id)
        _failures[(bundle_id, revision)] = (time.time(), str(e))
    finally:
        manager.close()
        if marker is not None:
            marker.unlink(missing_ok=True)


def _building_elsewhere(bundle_id: str, revision: int) -> bool:
    marker = _marker(bundle_id, revision)
    try:
        return time.time() - marker.stat().st_mtime < _MARKER_TTL_SECONDS
    except FileNotFoundError:
        return False


def _start_build(bundle_id: str, revision: int, members: dict[str, str]) -> None:
    key = (bundle_id, revision)
    running = _builds.get(key)
    if running is not None and not running.done():
        return
    if _building_elsewhere(bundle_id, revision):
        return
    task = asyncio.create_task(_build(bundle_id, revision, members))
    _builds[key] = task
    task.add_done_callback(lambda _t: _builds.pop(key, None))


@router.get("/{bundle_id}/explorer", summary="Explorer snapshot manifest")
async def get_explorer_manifest(
    bundle_id: UUID,
    user_id: UUID | None = Depends(get_optional_user_id),
    retry: bool = Query(
        False,
        description="Forget a failed build and build again (the Explorer's Try again).",
    ),
) -> JSONResponse:
    bundle = await _authorize(bundle_id, user_id)
    bid, revision = str(bundle_id), bundle["revision"]
    headers = {"Cache-Control": "no-cache"}

    manifest_path = _snapshot_dir(bid, revision) / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        for f in manifest["files"]:
            f["url"] = _file_url(bid, revision, f["name"])
        return JSONResponse({"status": "ready", **manifest}, headers=headers)

    failure = None if retry else _failures.get((bid, revision))
    if failure and time.time() - failure[0] < _FAILURE_TTL_SECONDS:
        return JSONResponse(
            {"status": "failed", "layers_revision": revision, "detail": failure[1]},
            status_code=500,
            headers=headers,
        )
    _failures.pop((bid, revision), None)
    _start_build(bid, revision, bundle["members"])
    return JSONResponse(
        {"status": "building", "layers_revision": revision},
        status_code=202,
        headers={**headers, "Retry-After": "2"},
    )


@router.get(
    "/{bundle_id}/explorer/r{revision}/s{schema}/{name}.parquet",
    summary="Explorer snapshot file",
)
async def get_explorer_file(
    bundle_id: UUID,
    revision: int,
    schema: int,
    name: str,
    user_id: UUID | None = Depends(get_optional_user_id),
) -> FileResponse:
    await _authorize(bundle_id, user_id)
    if name not in FILES or schema != SCHEMA_VERSION:
        raise HTTPException(status_code=404, detail="No such file")
    path = _snapshot_dir(str(bundle_id), revision) / f"{name}.parquet"
    if not path.is_file():
        # Pruned: the client fetches the manifest again for the current files.
        raise HTTPException(status_code=404, detail="No such file")
    return FileResponse(
        path,
        media_type="application/vnd.apache.parquet",
        headers={
            "Cache-Control": f"private, max-age={FILE_MAX_AGE_SECONDS}, immutable"
        },
    )


def cleanup_explorer_dir() -> int:
    """Remove what no build will finish or nobody reads: temp folders and
    markers older than an hour, folders untouched for 30 days. Returns how
    many entries went. Run at startup and hourly (``main.py``)."""
    if not EXPLORER_DIR.exists():
        return 0
    now = time.time()
    removed = 0
    for bundle_dir in EXPLORER_DIR.iterdir():
        if not bundle_dir.is_dir():
            continue
        for entry in bundle_dir.iterdir():
            age = now - entry.stat().st_mtime
            stale = (entry.name.startswith((".tmp-", ".building-")) and age > 3600) or (
                entry.name.startswith("r") and age > 30 * 86400
            )
            if stale:
                if entry.is_dir():
                    shutil.rmtree(entry, ignore_errors=True)
                else:
                    entry.unlink(missing_ok=True)
                removed += 1
        if not any(bundle_dir.iterdir()):
            bundle_dir.rmdir()
    return removed
