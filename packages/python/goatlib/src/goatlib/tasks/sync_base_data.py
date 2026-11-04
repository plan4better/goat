"""Keep GOAT's base data on the shared volume current.

The routing and public-transport tools read global data sets from fixed paths
under ``${DATA_DIR}``: the street network (``street_network/{edges,nodes}``),
the GTFS extract and PT network (``gtfs/``, ``pt_network/``), and, for the
legacy heatmaps, the travel-time matrices. Nothing in a fresh install
produces them. This task fetches them from a published source and keeps them
current.

**Source layout.** A source is a folder, served over HTTPS (the default,
``https://goat-base-data.plan4better.de/``), from S3 (``s3://bucket/prefix/``)
or from disk (``file:///path/``)::

    channels.json                       which version of each data set is current
    <dataset>/<version>/manifest.json   every file with its size and sha256
    <dataset>/<version>/<files...>

Versions are immutable, and each data set is versioned on its own, so a new
GTFS feed ships as a new ``public_transport`` version without touching the
20 GB street network. ``manifest.json`` is uploaded last, so its presence means
the version is complete; it also states the ``data_schema`` the files follow
(the C++ routing loader reads columns at fixed widths, so data built for
another schema would read as garbage, not fail) and any other data set
version it was ``requires``-built against.

**On the volume.** Versions land in ``${DATA_DIR}/.base/<dataset>/<version>/``
and the paths the tools read become *relative* symlinks into it (relative, so
they resolve however the volume is mounted), e.g.
``street_network -> .base/street_network/2026-09-17``. A version is downloaded
into ``.base/.staging/`` (resumable: ``*.part`` files continue with a range
request), every file is checked against its sha256, and only then are the
links switched -- each one with a single rename, so a running job sees either
the old version or the new one. The previous version is kept for rollback
(``pin``); older ones are removed. A path that already holds real data (a
volume filled by hand before this task existed) is left alone unless
``adopt`` is set, which moves it into ``.base/<dataset>/adopted/``.

**Regions.** Partitioned data sets (street network, matrices) are split by
H3 resolution-3 cell. ``bbox`` or ``h3_3`` limits the download to the cells a
deployment needs; unpartitioned files (the PT timetable) are always fetched.

**Offline deployments.** Point ``sources`` at an internal copy, built on any
machine with internet access with the ``mirror`` command::

    python -m goatlib.tasks.sync_base_data mirror --to ./goat-base-data \\
        --datasets street_network,public_transport --bbox 6.9,50.6,7.3,50.8

A CDN serves no directory listings, so a generic copy tool cannot do this;
the mirror follows ``channels.json`` and the manifests.

**Publishing.** A new version goes up with ``publish``: the files, then the
manifest it writes for them, then the version's entry in ``channels.json``
(and the channel moved to it, if asked)::

    python -m goatlib.tasks.sync_base_data publish --from ./public_transport \
        --to s3://goat-base-data/ --dataset public_transport \
        --version 2026-11-02 --requires street_network=2026-10-07

A ``public_transport`` version holds the feed (``gtfs/``), its timetable
(``pt_network/gtfs.bin``) and access/egress tables, and the feed as GTFS
tables a cut is made from (``pt_network/gtfs_tables/``). The
``build_pt_network`` task builds and publishes the ``pt_network/`` part from
the combined feed.

Windmill deployment: registered in `goatlib.tasks.registry` as
`f/goat/tasks/sync_base_data`, worker tag ``"tools"``, weekly and created
switched off -- turning it on (and choosing data sets, region, source) is a
per-deployment decision.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import shutil
import sys
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

from botocore.exceptions import BotoCoreError, ClientError
from pydantic import BaseModel, Field, field_validator

logger = logging.getLogger(__name__)

__all__ = [
    "DATASETS",
    "BaseDataSource",
    "SyncBaseDataParams",
    "h3_3_cells_for_bbox",
    "installed_version",
    "main",
    "open_source",
    "mirror",
    "publish",
    "sync",
]

DEFAULT_SOURCE_URL = "https://goat-base-data.plan4better.de/"
BASE_DIRNAME = ".base"
_STAGING = ".staging"
_ADOPTED = "adopted"
_USER_AGENT = "GOAT/1.0 (+https://plan4better.de)"


def default_source_url() -> str:
    """``GOAT_BASE_DATA_URL``, else ``DEFAULT_SOURCE_URL``; read on every call."""
    return os.environ.get("GOAT_BASE_DATA_URL") or DEFAULT_SOURCE_URL


#: The routing code's short H3 key: the resolution-3 digits of a cell,
#: ``(cell & mask) >> 36`` (packages/cpp/routing/src/data/h3_util.cpp).
_H3_3_MASK = 0x000FFFF000000000


@dataclass(frozen=True)
class DatasetSpec:
    """A data set this goatlib can install.

    ``links`` maps each path the tools read (relative to ``DATA_DIR``) to the
    path inside a version it resolves to ("" = the version folder itself).
    """

    data_schema: int
    links: dict[str, str]


#: In install order: public_transport is built against a street network.
DATASETS: dict[str, DatasetSpec] = {
    "street_network": DatasetSpec(1, {"street_network": ""}),
    "public_transport": DatasetSpec(1, {"gtfs": "gtfs", "pt_network": "pt_network"}),
    "traveltime_matrices": DatasetSpec(1, {"traveltime_matrices": ""}),
    "nuts": DatasetSpec(1, {"catalog/nuts.parquet": "nuts.parquet"}),
    "geoip": DatasetSpec(1, {"geoip": ""}),
}


class BaseDataSource(BaseModel):
    """Where to fetch from: ``https://``, ``s3://bucket/prefix/`` or ``file:///path/``."""

    url: str
    datasets: list[str] | None = Field(
        default=None, description="Data sets served here. Empty = all of them."
    )
    s3_endpoint_url: str | None = Field(
        default=None, description="s3:// only. Empty = ${S3_ENDPOINT_URL}."
    )
    s3_access_key_id: str | None = Field(
        default=None, description="s3:// only. Empty = ${S3_ACCESS_KEY_ID}."
    )
    s3_secret_access_key: str | None = Field(
        default=None, description="s3:// only. Empty = ${S3_SECRET_ACCESS_KEY}."
    )
    s3_region: str | None = Field(
        default=None, description="s3:// only. Empty = ${S3_REGION}."
    )


class SyncBaseDataParams(BaseModel):
    """Inputs for the base data sync."""

    datasets: list[str] = Field(
        default=["street_network", "public_transport"],
        description=(
            "Data sets to keep current: street_network, public_transport, "
            "traveltime_matrices (legacy heatmaps only), nuts, geoip."
        ),
    )
    sources: list[BaseDataSource] = Field(
        # A factory, so the source is read from the env when the params are
        # built on the worker: the Windmill script is generated from the
        # field's default, and a plain default would be baked into it.
        default_factory=lambda: [{"url": default_source_url()}],
        validate_default=True,
        description=(
            "Where to fetch from, first match per data set. Replace with an "
            "internal mirror when this cluster has no internet access."
        ),
    )
    channel: str = Field(default="stable", description="Channel in channels.json.")
    pin: dict[str, str] = Field(
        default={},
        description="Data set -> version, overriding the channel (e.g. to roll back).",
    )
    bbox: list[float] | None = Field(
        default=None,
        description=(
            "[min_lon, min_lat, max_lon, max_lat]: fetch only the H3 res-3 cells "
            "covering it, plus `ring` rings around them. Empty = everything."
        ),
    )
    h3_3: list[int] | None = Field(
        default=None,
        description="Explicit short H3 res-3 cells to fetch (instead of bbox).",
    )
    ring: int = Field(default=1, description="Rings of neighbour cells around bbox.")
    adopt: bool = Field(
        default=False,
        description=(
            "Take over paths that already hold real data by moving them into "
            ".base/<dataset>/adopted/. Without it they are left alone."
        ),
    )
    data_dir: str | None = Field(default=None, description="Empty = ${DATA_DIR}.")
    workers: int = Field(default=4, description="Parallel downloads.")
    dry_run: bool = Field(default=False, description="Report only, write nothing.")

    @field_validator("datasets")
    @classmethod
    def _known(cls, value: list[str]) -> list[str]:
        unknown = sorted(set(value) - set(DATASETS))
        if unknown:
            raise ValueError(f"unknown data sets: {unknown}; known: {list(DATASETS)}")
        return value


class _RefusalError(Exception):
    """A data set that must not be installed as published; others continue."""


# ─── sources ───────────────────────────────────────────────────────────────


class _Source(Protocol):
    def read(self, rel: str) -> bytes: ...

    def fetch(self, rel: str, part: Path) -> None:
        """Append the rest of ``rel`` to ``part``, from its current size on."""
        ...


def _offset(part: Path) -> int:
    return part.stat().st_size if part.exists() else 0


class _HttpSource:
    def __init__(self, url: str) -> None:
        self.base = url.rstrip("/") + "/"

    def _request(self, rel: str, offset: int = 0) -> urllib.request.Request:
        headers = {"User-Agent": _USER_AGENT}
        if offset:
            headers["Range"] = f"bytes={offset}-"
        return urllib.request.Request(
            self.base + urllib.parse.quote(rel, safe="/="), headers=headers
        )

    def read(self, rel: str) -> bytes:
        with urllib.request.urlopen(self._request(rel), timeout=60) as r:  # noqa: S310
            data: bytes = r.read()
            return data

    def fetch(self, rel: str, part: Path) -> None:
        offset = _offset(part)
        try:
            response = urllib.request.urlopen(  # noqa: S310
                self._request(rel, offset), timeout=600
            )
        except urllib.error.HTTPError as exc:
            if exc.code == 416 and offset:  # nothing left: the part is whole
                return
            raise
        with response:
            # 206 continues the part; a server ignoring Range answers 200 with
            # the whole file, which must replace the part, not extend it.
            mode = "ab" if response.status == 206 else "wb"
            with part.open(mode) as handle:
                shutil.copyfileobj(response, handle, length=1024 * 1024)


class _FileSource:
    def __init__(self, url: str) -> None:
        self.root = Path(urllib.parse.unquote(urllib.parse.urlparse(url).path))

    def read(self, rel: str) -> bytes:
        return (self.root / rel).read_bytes()

    def fetch(self, rel: str, part: Path) -> None:
        with (self.root / rel).open("rb") as src, part.open("ab") as dst:
            src.seek(_offset(part))
            shutil.copyfileobj(src, dst, length=1024 * 1024)

    def exists(self, rel: str) -> bool:
        return (self.root / rel).is_file()

    def put(self, rel: str, path: Path) -> None:
        (self.root / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, self.root / rel)

    def put_bytes(self, rel: str, data: bytes) -> None:
        (self.root / rel).parent.mkdir(parents=True, exist_ok=True)
        (self.root / rel).write_bytes(data)


class _S3Source:
    def __init__(self, source: BaseDataSource) -> None:
        import boto3
        from botocore.config import Config

        parsed = urllib.parse.urlparse(source.url)
        self.bucket = parsed.netloc
        self.prefix = parsed.path.strip("/")
        self.prefix = f"{self.prefix}/" if self.prefix else ""
        self.client = boto3.client(
            "s3",
            endpoint_url=source.s3_endpoint_url
            or os.environ.get("S3_ENDPOINT_URL")
            or None,
            aws_access_key_id=source.s3_access_key_id
            or os.environ.get("S3_ACCESS_KEY_ID"),
            aws_secret_access_key=source.s3_secret_access_key
            or os.environ.get("S3_SECRET_ACCESS_KEY"),
            region_name=source.s3_region or os.environ.get("S3_REGION") or "us-east-1",
            config=Config(s3={"addressing_style": "path"}),
        )

    def read(self, rel: str) -> bytes:
        body = self.client.get_object(Bucket=self.bucket, Key=self.prefix + rel)["Body"]
        data: bytes = body.read()
        return data

    def fetch(self, rel: str, part: Path) -> None:
        from botocore.exceptions import ClientError

        offset = _offset(part)
        kwargs: dict[str, Any] = {"Bucket": self.bucket, "Key": self.prefix + rel}
        if offset:
            kwargs["Range"] = f"bytes={offset}-"
        try:
            body = self.client.get_object(**kwargs)["Body"]
        except ClientError as exc:
            if offset and exc.response.get("Error", {}).get("Code") == "InvalidRange":
                return
            raise
        with part.open("ab") as handle:
            shutil.copyfileobj(body, handle, length=1024 * 1024)

    def exists(self, rel: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=self.prefix + rel)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in ("404", "NoSuchKey"):
                return False
            raise
        return True

    def put(self, rel: str, path: Path) -> None:
        # Multipart for large files (a timetable is over a gigabyte).
        self.client.upload_file(str(path), self.bucket, self.prefix + rel)

    def put_bytes(self, rel: str, data: bytes) -> None:
        self.client.put_object(Bucket=self.bucket, Key=self.prefix + rel, Body=data)


class _Target(_Source, Protocol):
    """A source that can also be published to."""

    def exists(self, rel: str) -> bool: ...

    def put(self, rel: str, path: Path) -> None: ...

    def put_bytes(self, rel: str, data: bytes) -> None: ...


def _open(source: BaseDataSource) -> _Source:
    scheme = urllib.parse.urlparse(source.url).scheme
    if scheme in ("http", "https"):
        return _HttpSource(source.url)
    if scheme == "file":
        return _FileSource(source.url)
    if scheme == "s3":
        return _S3Source(source)
    raise ValueError(f"unsupported source {source.url!r} (https://, s3://, file://)")


def _source_for(params: SyncBaseDataParams, dataset: str) -> BaseDataSource:
    for source in params.sources:
        if source.datasets is None or dataset in source.datasets:
            return source
    raise _RefusalError("no source serves it")


# ─── regions ───────────────────────────────────────────────────────────────


def h3_3_cells_for_bbox(bbox: list[float], ring: int = 1) -> set[int]:
    """Short H3 res-3 keys of the cells covering ``bbox``, plus ``ring`` rings.

    H3's polygon fill only returns cells whose centre lies inside, which is
    nothing for an area smaller than one cell (~12,000 km²), so the cells of
    the corners and centre are added before growing the rings.
    """
    import duckdb

    min_lon, min_lat, max_lon, max_lat = (float(v) for v in bbox)
    points = [
        (min_lat, min_lon),
        (min_lat, max_lon),
        (max_lat, min_lon),
        (max_lat, max_lon),
        ((min_lat + max_lat) / 2, (min_lon + max_lon) / 2),
    ]
    wkt = (
        f"POLYGON(({min_lon} {min_lat}, {max_lon} {min_lat}, {max_lon} {max_lat}, "
        f"{min_lon} {max_lat}, {min_lon} {min_lat}))"
    )
    values = ", ".join(f"({lat}, {lon})" for lat, lon in points)
    con = duckdb.connect()
    try:
        # Baked into the GOAT images, so INSTALL is a no-op there.
        con.execute("INSTALL h3 FROM community; LOAD h3;")
        rows = con.execute(
            f"""
            WITH seeds AS (
                SELECT unnest(h3_polygon_wkt_to_cells(?, 3)) AS cell
                UNION
                SELECT h3_latlng_to_cell(lat, lng, 3) FROM (VALUES {values}) p(lat, lng)
            )
            SELECT DISTINCT unnest(h3_grid_disk(cell, ?)) FROM seeds
            """,
            [wkt, int(ring)],
        ).fetchall()
    finally:
        con.close()
    return {(int(cell) & _H3_3_MASK) >> 36 for (cell,) in rows}


def _region(
    h3_3: list[int] | None, bbox: list[float] | None, ring: int
) -> set[int] | None:
    if h3_3:
        return set(h3_3)
    if bbox:
        return h3_3_cells_for_bbox(bbox, ring)
    return None


def _select(
    files: list[dict[str, Any]], cells: set[int] | None
) -> list[dict[str, Any]]:
    if cells is None:
        return files
    return [f for f in files if "h3_3" not in f or f["h3_3"] in cells]


# ─── manifests ─────────────────────────────────────────────────────────────


def _resolve_version(
    channels: dict[str, Any], dataset: str, channel: str, pin: dict[str, str]
) -> str:
    if dataset in pin:
        return pin[dataset]
    try:
        return str(channels["channels"][channel][dataset])
    except KeyError:
        raise _RefusalError(f"not in channel {channel!r}") from None


def _published_schema(
    channels: dict[str, Any], dataset: str, version: str
) -> int | None:
    for entry in channels.get("versions", {}).get(dataset, []):
        if entry.get("version") == version:
            schema = entry.get("data_schema")
            return int(schema) if schema is not None else None
    return None


def _check_schema(dataset: str, version: str, schema: int | None) -> None:
    supported = DATASETS[dataset].data_schema
    if schema is not None and schema != supported:
        raise _RefusalError(
            f"{dataset} {version} has data_schema {schema}; this goatlib reads "
            f"{supported} (update GOAT, or pin an older version)"
        )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _stage_file(
    source: _Source, prefix: str, entry: dict[str, Any], dest: Path, reuse: Path | None
) -> bool:
    """Put one verified file at ``dest``. Returns whether it was downloaded."""
    rel = entry["path"]
    dest.parent.mkdir(parents=True, exist_ok=True)
    if (
        dest.exists()
        and dest.stat().st_size == entry["bytes"]
        and _sha256(dest) == entry["sha256"]
    ):
        return False
    if reuse is not None and reuse.is_file() and reuse.stat().st_size == entry["bytes"]:
        dest.unlink(missing_ok=True)
        os.link(reuse, dest)  # same volume: no copy, and the old version keeps its file
        if _sha256(dest) == entry["sha256"]:
            return False
        dest.unlink()
    part = dest.with_name(dest.name + ".part")
    source.fetch(f"{prefix}/{rel}", part)
    size = part.stat().st_size
    if size != entry["bytes"] or _sha256(part) != entry["sha256"]:
        part.unlink(missing_ok=True)
        raise _RefusalError(
            f"{prefix}/{rel}: sha256 or size does not match the manifest "
            f"({size} of {entry['bytes']} bytes) -- refusing to install it"
        )
    os.replace(part, dest)
    return True


def _stage_version(
    source: _Source,
    prefix: str,
    files: list[dict[str, Any]],
    stage: Path,
    reuse_dir: Path | None,
    workers: int,
) -> int:
    def one(entry: dict[str, Any]) -> bool:
        reuse = reuse_dir / entry["path"] if reuse_dir is not None else None
        return _stage_file(source, prefix, entry, stage / entry["path"], reuse)

    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        return sum(pool.map(one, files))


# ─── links ─────────────────────────────────────────────────────────────────

_UNMANAGED = "<unmanaged>"


def _link_version(data_dir: Path, dataset: str, link_rel: str) -> str | None:
    """The version a tool path resolves to; _UNMANAGED for real data, None if absent."""
    link = data_dir / link_rel
    if link.is_symlink():
        if not link.exists():
            return None  # dangling: its version folder is gone, re-install
        target = Path(os.path.normpath(link.parent / os.readlink(link)))
        try:
            return target.relative_to(data_dir / BASE_DIRNAME / dataset).parts[0]
        except (ValueError, IndexError):
            return _UNMANAGED
    if link.exists():
        return _UNMANAGED
    return None


def _current(data_dir: Path, dataset: str) -> str | None:
    """The installed version, when every tool path agrees on it."""
    versions = {
        _link_version(data_dir, dataset, rel) for rel in DATASETS[dataset].links
    }
    if _UNMANAGED in versions:
        return _UNMANAGED
    if len(versions) == 1:
        return versions.pop()
    return None  # half-switched (an interrupted run): re-link


def installed_version(data_dir: Path | str, dataset: str) -> str | None:
    """The version of ``dataset`` this task installed under ``data_dir``; None
    when there is none, or what is there was not installed by it."""
    version = _current(Path(data_dir), dataset)
    return None if version in (None, _UNMANAGED, _ADOPTED) else version


def open_source(url: str) -> _Source:
    """A base data source to read from: ``https://``, ``s3://`` (keys from the
    environment) or ``file://``."""
    return _open(BaseDataSource(url=url))


def _switch(link: Path, target: Path) -> None:
    """Point ``link`` at ``target`` in one rename, relative so any mount resolves."""
    link.parent.mkdir(parents=True, exist_ok=True)
    tmp = link.with_name(f".{link.name}.new-{os.getpid()}")
    tmp.unlink(missing_ok=True)
    os.symlink(os.path.relpath(target, link.parent), tmp)
    os.replace(tmp, link)


def _adopt(data_dir: Path, dataset: str) -> None:
    adopted = data_dir / BASE_DIRNAME / dataset / _ADOPTED
    for link_rel, inner in DATASETS[dataset].links.items():
        link = data_dir / link_rel
        if link.exists() and not link.is_symlink():
            dest = adopted / inner if inner else adopted
            if dest.exists():
                raise _RefusalError(f"{dest} already exists, cannot adopt {link}")
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(link), str(dest))
            logger.info("adopted %s -> %s", link, dest)


def _prune(dataset_dir: Path, keep: set[str]) -> None:
    for child in dataset_dir.iterdir():
        if child.is_dir() and child.name not in keep:
            shutil.rmtree(child)
            logger.info("removed old version %s", child)


# ─── sync ──────────────────────────────────────────────────────────────────


def _sync_dataset(
    params: SyncBaseDataParams,
    dataset: str,
    data_dir: Path,
    cells: set[int] | None,
    activated: dict[str, str],
) -> dict[str, Any]:
    source_def = _source_for(params, dataset)
    source = _open(source_def)
    channels = json.loads(source.read("channels.json"))
    version = _resolve_version(channels, dataset, params.channel, params.pin)
    _check_schema(dataset, version, _published_schema(channels, dataset, version))

    current = _current(data_dir, dataset)
    if current == _UNMANAGED and not params.adopt:
        return {
            "status": "unmanaged",
            "version": version,
            "detail": "tool paths hold data not installed by this task; set adopt to take them over",
        }

    base = data_dir / BASE_DIRNAME
    installed = base / dataset / version
    region = sorted(cells) if cells is not None else None
    if current == version and _installed_region(installed) == region:
        return {"status": "up_to_date", "version": version}

    manifest = json.loads(source.read(f"{dataset}/{version}/manifest.json"))
    _check_schema(dataset, version, manifest.get("data_schema"))
    for dep, dep_version in manifest.get("requires", {}).items():
        have = activated.get(dep) or _current(data_dir, dep)
        if have != dep_version:
            raise _RefusalError(
                f"{dataset} {version} requires {dep} {dep_version}, have {have or 'none'}"
            )

    files = _select(manifest["files"], cells)
    fresh = current in (None, _UNMANAGED)
    if params.dry_run:
        # Data sets later in the order check their requirements against this one.
        activated[dataset] = version
        return {
            "status": "would_install" if fresh else "would_update",
            "version": version,
            "files": len(files),
            "bytes": sum(f["bytes"] for f in files),
        }

    stage = base / _STAGING / dataset / version
    downloaded = _stage_version(
        source,
        f"{dataset}/{version}",
        files,
        stage,
        installed if installed.is_dir() else None,
        params.workers,
    )
    (stage / "manifest.json").write_text(
        json.dumps({**manifest, "files": files, "region_h3_3": region}, indent=1) + "\n"
    )

    if current == _UNMANAGED:
        _adopt(data_dir, dataset)
        current = _ADOPTED
    if installed.exists():
        # Same version, different region: the stage holds it all, hardlinked.
        shutil.rmtree(installed)
    installed.parent.mkdir(parents=True, exist_ok=True)
    os.replace(stage, installed)
    for link_rel, inner in DATASETS[dataset].links.items():
        _switch(data_dir / link_rel, installed / inner if inner else installed)
    _prune(base / dataset, {version} | ({current} if current else set()))
    activated[dataset] = version
    return {
        "status": "installed" if fresh else "updated",
        "version": version,
        "previous": current if current != version else None,
        "files": len(files),
        "downloaded": downloaded,
        "bytes": sum(f["bytes"] for f in files),
        "source": source_def.url,
    }


def _installed_region(installed: Path) -> list[int] | None:
    try:
        region = json.loads((installed / "manifest.json").read_text()).get(
            "region_h3_3"
        )
        return [int(c) for c in region] if region is not None else None
    except (OSError, ValueError):
        return None


def _write_state(data_dir: Path, results: dict[str, Any]) -> None:
    state_path = data_dir / BASE_DIRNAME / "state.json"
    try:
        state = json.loads(state_path.read_text())
    except (OSError, ValueError):
        state = {}
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    for dataset, result in results.items():
        if result["status"] in ("installed", "updated"):
            state.setdefault("datasets", {})[dataset] = {**result, "activated_at": now}
    state_path.write_text(json.dumps(state, indent=1) + "\n")


def sync(params: SyncBaseDataParams) -> dict[str, Any]:
    """Bring every selected data set to its channel (or pinned) version."""
    data_dir = Path(params.data_dir or os.environ.get("DATA_DIR") or "/app/data")
    cells = _region(params.h3_3, params.bbox, params.ring)
    results: dict[str, Any] = {}
    activated: dict[str, str] = {}
    for dataset in (d for d in DATASETS if d in params.datasets):
        try:
            results[dataset] = _sync_dataset(
                params, dataset, data_dir, cells, activated
            )
        except (
            _RefusalError,
            OSError,
            urllib.error.URLError,
            ValueError,
            BotoCoreError,
            ClientError,
        ) as exc:
            logger.error("%s: %s", dataset, exc)
            results[dataset] = {"status": "failed", "error": str(exc)}
        logger.info("%s: %s", dataset, results[dataset])
    if not params.dry_run and any(
        r["status"] in ("installed", "updated") for r in results.values()
    ):
        _write_state(data_dir, results)
    failed = [
        f"{d}: {r['error']}" for d, r in results.items() if r["status"] == "failed"
    ]
    if failed:
        raise RuntimeError("; ".join(failed))
    return results


def mirror(
    source_url: str,
    dest: Path | str,
    *,
    datasets: list[str],
    channel: str = "stable",
    pin: dict[str, str] | None = None,
    bbox: list[float] | None = None,
    h3_3: list[int] | None = None,
    ring: int = 1,
    workers: int = 4,
) -> dict[str, Any]:
    """Copy the current versions into ``dest`` as a self-contained source.

    The copy has the source's layout, restricted to the chosen data sets,
    versions and region, with manifests listing exactly what it holds -- so
    it can be uploaded to an internal S3 bucket or used as a ``file://``
    source by a deployment that cannot reach the original.
    """
    dest = Path(dest)
    source = _open(BaseDataSource(url=source_url))
    channels = json.loads(source.read("channels.json"))
    cells = _region(h3_3, bbox, ring)
    out_channels: dict[str, Any] = {
        "format": 1,
        "channels": {channel: {}},
        "versions": {},
    }
    copied: dict[str, Any] = {}
    for dataset in (d for d in DATASETS if d in datasets):
        version = _resolve_version(channels, dataset, channel, pin or {})
        manifest = json.loads(source.read(f"{dataset}/{version}/manifest.json"))
        files = _select(manifest["files"], cells)
        root = dest / dataset / version
        downloaded = _stage_version(
            source, f"{dataset}/{version}", files, root, None, workers
        )
        (root / "manifest.json").write_text(
            json.dumps({**manifest, "files": files}, indent=1) + "\n"
        )
        out_channels["channels"][channel][dataset] = version
        out_channels["versions"][dataset] = [
            {"version": version, "data_schema": manifest.get("data_schema")}
        ]
        copied[dataset] = {
            "version": version,
            "files": len(files),
            "downloaded": downloaded,
        }
        logger.info("mirrored %s %s: %s", dataset, version, copied[dataset])
    (dest / "channels.json").write_text(json.dumps(out_channels, indent=1) + "\n")
    return copied


def _target(url: str) -> _Target:
    scheme = urllib.parse.urlparse(url).scheme
    if scheme == "file":
        return _FileSource(url)
    if scheme == "s3":
        return _S3Source(BaseDataSource(url=url))
    raise ValueError(f"cannot publish to {url!r} (s3://, file://)")


def publish(
    src: Path | str,
    dest_url: str,
    *,
    dataset: str,
    version: str,
    coverage: dict[str, Any] | None = None,
    requires: dict[str, str] | None = None,
    channel: str | None = None,
    workers: int = 4,
) -> dict[str, Any]:
    """Publish the folder ``src`` as ``dataset``'s ``version`` at ``dest_url``.

    The counterpart of ``sync``: every file goes up, then ``manifest.json``
    listing each with its size and sha256 -- last, as its presence is what
    tells a sync the version is complete -- then ``channels.json`` lists the
    version, and points ``channel`` at it if one is given. A version is
    immutable, so one already published is refused. ``src`` holds what the
    data set's links point into (``gtfs/`` and ``pt_network/`` for
    public_transport), nothing else.
    """
    if dataset not in DATASETS:
        raise ValueError(f"unknown data set {dataset!r}")
    src = Path(src)
    files = sorted(
        p for p in src.rglob("*") if p.is_file() and p.name != "manifest.json"
    )
    if not files:
        raise ValueError(f"{src} holds no files")
    roots = {inner for inner in DATASETS[dataset].links.values() if inner}
    if roots and "" not in DATASETS[dataset].links.values():
        rels = [p.relative_to(src).as_posix() for p in files]

        def under(rel: str, root: str) -> bool:
            return rel == root or rel.startswith(root + "/")

        stray = [rel for rel in rels if not any(under(rel, r) for r in roots)]
        if stray:
            raise ValueError(
                f"{dataset} reads only {', '.join(sorted(roots))}; not: "
                + ", ".join(stray[:5])
            )
        # A server following the channel switches every link of the data set,
        # so a version missing one of them would leave that link dangling.
        missing = sorted(r for r in roots if not any(under(rel, r) for rel in rels))
        if channel and missing:
            raise ValueError(
                f"{dataset} {version} has no {', '.join(missing)}; a channel "
                "can point only at a version holding every folder the data "
                "set's links read"
            )

    target = _target(dest_url)
    prefix = f"{dataset}/{version}"
    if target.exists(f"{prefix}/manifest.json"):
        raise ValueError(
            f"{dataset} {version} is published already; versions are immutable"
        )

    def one(path: Path) -> dict[str, Any]:
        rel = path.relative_to(src).as_posix()
        target.put(f"{prefix}/{rel}", path)
        logger.info("published %s", rel)
        entry: dict[str, Any] = {
            "path": rel,
            "bytes": path.stat().st_size,
            "sha256": _sha256(path),
        }
        # A partitioned file names its cell, which a regional sync selects on
        # (_select); without it every deployment would fetch every cell.
        for part in rel.split("/"):
            if part.startswith("h3_3="):
                entry["h3_3"] = int(part.split("=", 1)[1])
        return entry

    with ThreadPoolExecutor(max_workers=workers) as pool:
        entries = list(pool.map(one, files))

    manifest: dict[str, Any] = {
        "dataset": dataset,
        "version": version,
        "data_schema": DATASETS[dataset].data_schema,
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if coverage:
        manifest["coverage"] = coverage
    if requires:
        manifest["requires"] = requires
    manifest["total_bytes"] = sum(e["bytes"] for e in entries)
    manifest["files"] = entries
    target.put_bytes(
        f"{prefix}/manifest.json", (json.dumps(manifest, indent=1) + "\n").encode()
    )

    channels: dict[str, Any] = (
        json.loads(target.read("channels.json"))
        if target.exists("channels.json")
        else {"format": 1, "channels": {}, "versions": {}}
    )
    listed = channels.setdefault("versions", {}).setdefault(dataset, [])
    if not any(v["version"] == version for v in listed):
        listed.append({"version": version, "data_schema": manifest["data_schema"]})
        listed.sort(key=lambda v: v["version"])
    if channel:
        channels.setdefault("channels", {}).setdefault(channel, {})[dataset] = version
    channels["updated_at"] = manifest["created_at"]
    target.put_bytes("channels.json", (json.dumps(channels, indent=1) + "\n").encode())
    logger.info(
        "published %s %s: %d file(s), %d bytes%s",
        dataset,
        version,
        len(entries),
        manifest["total_bytes"],
        f", {channel} channel" if channel else "",
    )
    return {"files": len(entries), "bytes": manifest["total_bytes"], "channel": channel}


def main(params: SyncBaseDataParams | None = None) -> dict[str, Any]:
    """Entry point for the Windmill task."""
    return sync(params or SyncBaseDataParams())


def _cli(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m goatlib.tasks.sync_base_data")
    sub = parser.add_subparsers(dest="command", required=True)
    m = sub.add_parser("mirror", help="copy the current versions into a folder")
    m.add_argument("--to", required=True, help="destination folder")
    m.add_argument("--source", default=default_source_url())
    m.add_argument("--datasets", default="street_network,public_transport")
    m.add_argument("--channel", default="stable")
    m.add_argument("--bbox", help="min_lon,min_lat,max_lon,max_lat")
    m.add_argument("--ring", type=int, default=1)
    m.add_argument("--workers", type=int, default=4)
    p = sub.add_parser("publish", help="publish a folder as a data set version")
    p.add_argument("--from", dest="src", required=True, help="the version's folder")
    p.add_argument("--to", required=True, help="s3://bucket/prefix/ or file:///path/")
    p.add_argument("--dataset", required=True, choices=list(DATASETS))
    p.add_argument("--version", required=True, help="e.g. 2026-11-02")
    p.add_argument("--channel", help="point this channel at the version, e.g. stable")
    p.add_argument(
        "--requires", action="append", default=[], help="dataset=version, repeatable"
    )
    p.add_argument("--coverage-name", help="what the data covers")
    p.add_argument("--coverage-bbox", help="min_lon,min_lat,max_lon,max_lat")
    p.add_argument("--workers", type=int, default=4)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    if args.command == "publish":
        coverage = {
            k: v
            for k, v in (
                ("name", args.coverage_name),
                (
                    "bbox",
                    [float(x) for x in args.coverage_bbox.split(",")]
                    if args.coverage_bbox
                    else None,
                ),
            )
            if v
        }
        publish(
            args.src,
            args.to,
            dataset=args.dataset,
            version=args.version,
            coverage=coverage or None,
            requires=dict(r.split("=", 1) for r in args.requires) or None,
            channel=args.channel,
            workers=args.workers,
        )
        return 0
    mirror(
        args.source,
        args.to,
        datasets=args.datasets.split(","),
        channel=args.channel,
        bbox=[float(v) for v in args.bbox.split(",")] if args.bbox else None,
        ring=args.ring,
        workers=args.workers,
    )
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
