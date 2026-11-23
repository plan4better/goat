"""A bounded sample of an item's data, read straight from the catalog bucket.

The catalog serves metadata; this is the one endpoint that touches the data
itself, so that a detail page can show *what the dataset looks like* rather
than only what it claims to be -- the map preview a Carto-style catalog page
is built around, and the rows behind it.

**Geometry is optional.** A dataset with geometry samples features; an
attribute table samples rows and gives each a ``null`` geometry -- a Feature
the GeoJSON spec allows, which a client renders as a table and fits no map to.
One response shape for both, because the question a detail page asks ("what
does a record look like") is the same question either way.

Three decisions shape it, each measured against the real bucket rather than
assumed:

**A fixed sample, not a viewport.** No ``bbox`` parameter, no refetch on pan or
zoom. That keeps the response a pure function of (item, mirror generation), so
a client can cache it and a deployment may cache it server-side as well.

**The read is bounded, not scanned.** The sample is the first rows of the
file -- see `_sample_sql`, which is where the cost of this endpoint is decided
and what the alternatives were measured to cost.

**The cap is bytes, not features.** Per-feature GeoJSON across the live catalog
spans 0.07-66.7 KB -- a ~950x range that file size does not predict (the worst
offender is a 1.4 MB file; a 447 MB one is 9x cheaper per feature). 100 raw
features of one dataset came to 6.4 MB. So the feature ceiling bounds the work
and the byte budget is the real limit -- and it bounds the *read* (`_collect`),
not just the response, so a dataset of enormous geometries cannot be
materialised in full before anything notices.

**Simplification does the work.** At a tolerance of "one screen pixel" the same
100 features came to 0.27 MB -- 24x smaller, and faster, with nothing visible
lost at the zoom the extent is drawn at. It is bounded in both directions:
coarsened while that still pays, and stopped before it empties the shapes it
is thinning.
"""

import hashlib
import json
import logging
import os
import shutil
import threading
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from uuid import UUID

import duckdb
from goatlib.storage.ducklake import load_extensions

from catalog.config import CatalogSettings
from catalog.errors import ApiError
from catalog.services.s3_secret import create_s3_secret

logger = logging.getLogger(__name__)

#: Columns that are structural rather than attributes of the feature.
_NON_PROPERTY_COLUMNS = frozenset({"geometry", "geom", "bbox"})

#: Rows pulled from DuckDB per step while filling the byte budget.
_FETCH_BATCH = 256

#: How DuckDB spells a geometry column in ``DESCRIBE``. Matched by prefix, not
#: equality: a GeoParquet file carries its CRS in the type, so the real
#: published data reads back as ``GEOMETRY('OGC:CRS84')``.
_GEOMETRY_TYPE_PREFIX = "GEOMETRY"


def object_key(
    href: str, bucket: str, *, prefixes: tuple[str, ...] = ("data/",)
) -> str:
    """Resolve a published asset href to a key inside our own bucket.

    The href comes from the harvester (``../../../data/<id>.parquet``,
    relative to the item's place in the static JSON tree), which means it is
    **publisher-controlled input to a fetch we perform** -- the classic SSRF
    shape. So this does not resolve it as a URL; it extracts a key and refuses
    anything that would read from somewhere else:

    * an absolute URL is accepted only when it addresses this bucket,
    * ``..`` may only appear as the leading walk out of the tree, never in the
      resolved key,
    * the key must start with one of ``prefixes`` -- each caller passes the
      prefixes it is allowed to read, so the data objects the preview samples
      and the thumbnails the assets route serves cannot reach each other's.

    Anything else raises rather than being "helpfully" coerced.
    """
    candidate = href.strip()
    if not candidate:
        raise ApiError(404, "item has no data asset")

    parsed = urlparse(candidate)
    if parsed.scheme:
        if parsed.scheme == "s3":
            if parsed.netloc != bucket:
                raise ApiError(404, "item data is not in this catalog's bucket")
            candidate = parsed.path
        elif parsed.scheme in ("http", "https"):
            # Path-style endpoint URL: /<bucket>/<key>.
            path = parsed.path.lstrip("/")
            prefix = f"{bucket}/"
            if not path.startswith(prefix):
                raise ApiError(404, "item data is not in this catalog's bucket")
            candidate = path[len(prefix) :]
        else:
            raise ApiError(404, f"unsupported data asset scheme: {parsed.scheme!r}")

    # Strip the walk out of the static tree, then require the rest to be clean.
    segments = [s for s in candidate.split("/") if s not in ("", ".")]
    while segments and segments[0] == "..":
        segments.pop(0)
    if any(s == ".." for s in segments):
        raise ApiError(404, "item data asset href is not a valid object key")
    key = "/".join(segments)
    if not key.startswith(prefixes):
        raise ApiError(404, "asset href is not inside a published catalog prefix")
    return key


class PreviewCache:
    """Rendered previews on disk, one file per item, scoped to a generation.

    **Disk, not heap.** A memory cache is charged against the pod's limit
    alongside DuckDB's working set, is thrown away on every restart and
    rollout, and is per-replica -- so N pods each re-read every object. Files
    also serve as bytes: no parse-and-reserialise per hit. Sizing a heap cache
    honestly is its own trap, since a dict of 100 features costs several times
    its serialised length.

    Layout is ``<cache_dir>/<generation>/<item id>.json``, and the generation
    directory *is* the invalidation: a sync changes the store's content digest,
    the service starts writing under a new directory, and the previous one is
    deleted. A preview can never outlive the mirror it was sampled under.

    Note the residual: if the harvester rewrites ``data/<id>.parquet`` without
    touching the item's metadata, the digest does not move and the cached
    preview goes stale. That is contract territory (a data change must move
    ``updated``/``version``), not something detectable here without the read
    the cache exists to avoid.
    """

    def __init__(self, root: Path, max_bytes: int) -> None:  # noqa: D107
        self._root = root
        self._max_bytes = max_bytes
        self._lock = threading.Lock()
        self._generation: str | None = None

    def _generation_dir(self, generation: str) -> Path:
        return self._root / generation

    def _prune_old_generations(self, generation: str) -> None:
        """Drop every generation but the current one."""
        try:
            existing = list(self._root.iterdir())
        except FileNotFoundError:
            return
        for path in existing:
            if path.name != generation and path.is_dir():
                shutil.rmtree(path, ignore_errors=True)

    def _enter(self, generation: str) -> Path:
        directory = self._generation_dir(generation)
        with self._lock:
            if generation != self._generation:
                self._generation = generation
                directory.mkdir(parents=True, exist_ok=True)
                self._prune_old_generations(generation)
        return directory

    def get(self, generation: str, item_id: str) -> bytes | None:
        path = self._enter(generation) / _cache_filename(item_id)
        try:
            payload = path.read_bytes()
        except (FileNotFoundError, OSError):
            return None
        # Touch so eviction can order by recency of use rather than of write.
        try:
            path.touch()
        except OSError:  # pragma: no cover - a read-only cache still serves
            pass
        return payload

    def put(self, generation: str, item_id: str, payload: bytes) -> None:
        directory = self._enter(generation)
        path = directory / _cache_filename(item_id)
        tmp = path.with_suffix(".tmp")
        try:
            tmp.write_bytes(payload)
            # Atomic: a concurrent reader sees either no file or a whole one.
            os.replace(tmp, path)
        except OSError:
            # A cache that cannot be written is a slow cache, not an outage.
            tmp.unlink(missing_ok=True)
            logger.warning("could not cache preview for %s", item_id, exc_info=True)
            return
        self._evict(directory)

    def _evict(self, directory: Path) -> None:
        """Keep the generation under budget, dropping least-recently-used."""
        try:
            entries = [(p, p.stat()) for p in directory.glob("*.json")]
        except OSError:  # pragma: no cover
            return
        total = sum(stat.st_size for _, stat in entries)
        if total <= self._max_bytes:
            return
        for path, stat in sorted(entries, key=lambda e: e[1].st_mtime):
            path.unlink(missing_ok=True)
            total -= stat.st_size
            if total <= self._max_bytes:
                return


def _cache_filename(item_id: str) -> str:
    """A filesystem-safe name for an item id.

    Item ids are UUIDs today, but the contract only promises "stable and
    URL-safe" -- which permits slashes and dots. Hashing sidesteps having to
    trust that, and keeps names a fixed length.
    """
    return f"{hashlib.sha256(item_id.encode()).hexdigest()}.json"


class PreviewReader:
    """Owns the DuckDB connection that range-reads the catalog bucket.

    Separate from ``CatalogStore``'s connection on purpose: that one is
    swapped on every mirror reload and serves the local files, while this one
    holds S3 credentials and is long-lived. Queries run on per-call cursors,
    the same concurrency model the store uses.
    """

    def __init__(self, settings: CatalogSettings) -> None:
        self._settings = settings
        self._lock = threading.Lock()
        self._con: duckdb.DuckDBPyConnection | None = None
        #: None unless a cache directory is configured -- see
        #: `CatalogSettings.preview_cache_dir` for why that is the default.
        self.cache: PreviewCache | None = (
            PreviewCache(settings.preview_cache_dir, settings.preview_cache_max_bytes)
            if settings.preview_cache_dir is not None
            else None
        )

    def _connection(self) -> duckdb.DuckDBPyConnection:
        with self._lock:
            if self._con is not None:
                return self._con
            con = duckdb.connect()
            load_extensions(con, "spatial", "httpfs")
            # Previews are one-shot reads with their own disk cache. DuckDB
            # would otherwise keep each S3 row group read in memory for the
            # life of this connection.
            con.execute("SET enable_external_file_cache=false")
            create_s3_secret(con, "catalog_data", self._settings)
            self._con = con
            return con

    def _geometry_column(
        self, cursor: duckdb.DuckDBPyConnection, url: str
    ) -> str | None:
        """The file's geometry column, or ``None`` where it has none.

        Absence is a shape, not an error: an attribute table has rows worth
        showing and no map to draw them on, and after the 2026-08 harvest that
        is most of the catalog.
        """
        described = cursor.execute(
            "DESCRIBE SELECT * FROM read_parquet(?)", [url]
        ).fetchall()
        for name, type_name, *_ in described:
            if str(type_name).upper().startswith(_GEOMETRY_TYPE_PREFIX):
                return str(name)
        return None

    def object_url(self, row: dict[str, Any]) -> str:
        """The DuckDB-readable URL of this item's data object.

        A seam, not indirection: it is the only part of the read that needs a
        bucket, so a test can point the same query pipeline at a local file.
        """
        bucket = self._settings.s3_catalog_bucket or ""
        key = object_key(str(row.get("parquet_url") or ""), bucket, prefixes=("data/",))
        return f"s3://{bucket}/{key}"

    def render(self, generation: str, row: dict[str, Any], limit: int) -> bytes:
        """The item's preview as serialised GeoJSON, cached on disk.

        Bytes rather than a dict all the way through: a cache hit then costs
        one file read and no JSON round-trip, and the endpoint hands the same
        buffer straight to the client.
        """
        item_id = str(row.get("id"))
        if self.cache is None:
            return json.dumps(self.read(row, limit)).encode()
        cached = self.cache.get(generation, item_id)
        if cached is not None:
            return cached
        payload = json.dumps(self.read(row, limit)).encode()
        self.cache.put(generation, item_id, payload)
        return payload

    def read(self, row: dict[str, Any], limit: int) -> dict[str, Any]:
        """Sample ``limit`` rows of the item's data as a FeatureCollection.

        A dataset with geometry samples features; one without samples rows and
        gives each a ``null`` geometry, which is a Feature the GeoJSON spec
        allows and a client can render as a table. One response shape either
        way, so a caller reads the sample the same for both.
        """
        data = str(row.get("parquet_url") or "")
        if not data.lower().endswith(".parquet"):
            # A raster's GeoTIFF or a map service's link: there are no rows to
            # sample, and reading a TIFF as Parquet only fails (502).
            raise ApiError(404, "item has no table or vector data to sample")
        settings = self._settings
        url = self.object_url(row)

        cursor = self._connection().cursor()
        try:
            geometry_column = self._geometry_column(cursor, url)
            tolerance = _tolerance(row, settings.preview_render_width_px)
            features, truncated = _fetch(
                cursor, url, geometry_column, limit, tolerance, settings
            )
        except ApiError:
            raise
        except duckdb.OutOfMemoryException as exc:
            raise ApiError(503, "preview is temporarily unavailable") from exc
        except duckdb.Error as exc:
            raise ApiError(502, f"could not read the item's data: {exc}") from exc
        finally:
            cursor.close()

        document: dict[str, Any] = {
            "type": "FeatureCollection",
            "features": features,
            "goat:truncated": truncated,
        }
        sample_bbox = _bbox_of(features)
        if sample_bbox:
            # The client fits the map here, not to the item extent: a sample
            # can sit in a corner of it (measured 5.6-100% of the extent's
            # area across real datasets), and fitting to the extent would then
            # render the whole preview as a speck.
            document["bbox"] = sample_bbox
        item_bbox = _item_bbox(row)
        if item_bbox:
            document["goat:item_bbox"] = item_bbox
        total = row.get("table:row_count")
        if total is not None:
            # Free: the mirror carries the row count, so "showing 100 of
            # 496,271" costs no read.
            document["goat:total"] = int(total)
        return document


def _tolerance(row: dict[str, Any], render_width_px: int) -> float:
    """Simplification tolerance: roughly one pixel of the rendered extent."""
    item_bbox = _item_bbox(row)
    if not item_bbox or render_width_px <= 0:
        return 0.0
    width = item_bbox[2] - item_bbox[0]
    return max(width, 0.0) / render_width_px


def _item_bbox(row: dict[str, Any]) -> list[float] | None:
    corners = [
        row.get("bbox_xmin"),
        row.get("bbox_ymin"),
        row.get("bbox_xmax"),
        row.get("bbox_ymax"),
    ]
    if any(value is None for value in corners):
        return None
    return [float(value) for value in corners]  # type: ignore[arg-type]


def _bbox_of(features: list[dict[str, Any]]) -> list[float] | None:
    xs: list[float] = []
    ys: list[float] = []

    def walk(coords: Any) -> None:
        if (
            isinstance(coords, list)
            and len(coords) >= 2
            and all(isinstance(v, (int, float)) for v in coords[:2])
        ):
            xs.append(float(coords[0]))
            ys.append(float(coords[1]))
            return
        if isinstance(coords, list):
            for part in coords:
                walk(part)

    for feature in features:
        geometry = feature.get("geometry") or {}
        walk(geometry.get("coordinates"))
    if not xs:
        return None
    return [min(xs), min(ys), max(xs), max(ys)]


def _sample_sql(projection: str, limit: int) -> str:
    """SQL reading the first ``limit`` rows of the file.

    A bounded read from the front, which touches only the first row groups.
    Everything else measured against the real bucket costs an order of
    magnitude more, because cost here is decided by how much of the object has
    to be touched:

    * a reservoir sample gives every row an equal chance, so it reads every
      row -- 34 s on a 740 MB object, 108 s on a 232 MB one, on every request,
      since the server-side cache (`preview_cache_dir`) is off unless a
      deployment configures one;
    * sampling at spaced offsets covers the whole extent but touches a row
      group per offset, and the published files hold 3-54 of them, so it
      converges on the same scan: measured 21-104 s;
    * filtering to a bbox prunes on the GeoParquet covering column, but only
      as far as the row groups allow -- 42 s on the 740 MB file whatever the
      window size, because it has three of them.

    What this returns is a patch rather than a survey: the files are
    Hilbert-ordered (`catalog_materialize` writes them `ORDER BY ST_Hilbert`),
    so the first rows are neighbours on the map as well as in the file, and the
    client fits its map to the sample's own bbox. The dataset's full extent
    travels alongside as ``goat:item_bbox``, so a caller that wants to show
    where the patch sits within the whole still can.
    """
    return f"SELECT {projection} FROM read_parquet($url) LIMIT {int(limit)}"


def _drawable_count(features: list[dict[str, Any]]) -> int:
    """How many features still have a shape to draw."""
    return sum(
        1 for feature in features if (feature.get("geometry") or {}).get("coordinates")
    )


def _collect(
    result: duckdb.DuckDBPyConnection,
    names: list[str],
    geometry_column: str | None,
    limit: int,
    max_bytes: int,
) -> tuple[list[dict[str, Any]], bool]:
    """Build features until the row ceiling or the byte budget, whichever first.

    Streamed, not fetched whole. The budget used to be applied to a list that
    had already been materialised, which left the *ceiling* deciding peak
    memory -- and the ceiling counts features, while what costs memory is
    bytes. Per-feature payload spans ~950x across the catalog, so the same 5000
    rows is 2.8 MB of points or several hundred MB of line geometry. Measured:
    reading a 740 MB line dataset that way OOM-killed the pod.

    Stopping mid-read also keeps the prefix a prefix -- the rows are
    file-ordered, so the ones that fit are the ones nearest the start rather
    than a scatter with holes in it.

    Returns the features, and whether the budget rather than the data ended the
    read.
    """
    features: list[dict[str, Any]] = []
    # The enclosing brackets of the array the caller serialises these into.
    size = 2
    while len(features) < limit:
        batch = result.fetchmany(_FETCH_BATCH)
        if not batch:
            return features, False
        for values in batch:
            feature = _feature(dict(zip(names, values, strict=True)), geometry_column)
            # Plus the ", " that will join it to the previous one.
            encoded = len(json.dumps(feature)) + 2
            if features and size + encoded > max_bytes:
                return features, True
            features.append(feature)
            size += encoded
            if len(features) >= limit:
                return features, False
    return features, False


def _read_sample(
    cursor: duckdb.DuckDBPyConnection,
    projection: str,
    url: str,
    geometry_column: str | None,
    limit: int,
    settings: CatalogSettings,
) -> tuple[list[dict[str, Any]], bool]:
    """One bounded read, collected under the byte budget."""
    result = cursor.execute(_sample_sql(projection, limit), {"url": url})
    names = [d[0] for d in result.description]
    return _collect(result, names, geometry_column, limit, settings.preview_max_bytes)


def _fetch(
    cursor: duckdb.DuckDBPyConnection,
    url: str,
    geometry_column: str | None,
    limit: int,
    tolerance: float,
    settings: CatalogSettings,
) -> tuple[list[dict[str, Any]], bool]:
    """Read and simplify a bounded sample of the item's features.

    The read is bounded rather than scanned -- see `_sample_sql` for why, and
    for what that costs against the real bucket -- and `_collect` stops it at
    the byte budget, so neither the response nor the memory behind it depends
    on how heavy this dataset's geometry happens to be.

    Simplification runs in the query, on the rows the read selects. When the
    budget rather than the ceiling ended the read, coarsening it is tried: more
    of the dataset fits, and blockier shapes at preview zoom cost nothing
    visible. That is abandoned as soon as it stops paying -- immediately for
    point data, where the properties rather than the geometry are the bytes --
    and before it empties the shapes it is thinning.
    """
    if geometry_column is None:
        return _fetch_rows(cursor, url, limit, settings)

    quoted = geometry_column.replace('"', '""')
    best: list[dict[str, Any]] = []
    best_drawable = -1
    for attempt in range(3):
        step = tolerance * (4**attempt) if tolerance > 0 else 0.0
        geometry_sql = (
            f'ST_AsGeoJSON("{quoted}")'
            if step <= 0
            else f'ST_AsGeoJSON(ST_Simplify("{quoted}", {step}))'
        )
        features, over_budget = _read_sample(
            cursor,
            f"{geometry_sql} AS __geometry, *",
            url,
            geometry_column,
            limit,
            settings,
        )
        # Simplifying past a shape's own size empties it: measured, a tolerance
        # of 16x on a 0.02-radius polygon returns `{"coordinates": []}`. A
        # preview of nothing is worse than a short one, so coarsening keeps the
        # last tolerance that still had shapes to draw.
        drawable = _drawable_count(features)
        if attempt and drawable < best_drawable:
            break
        # Coarsening pays in features admitted under the budget; when it stops
        # buying them it will not buy any at 4x more.
        if attempt and len(features) <= len(best) * 1.05:
            best, best_drawable = (
                (features, drawable)
                if len(features) > len(best)
                else (best, best_drawable)
            )
            break
        best, best_drawable = features, drawable
        if not over_budget:
            return features, len(features) >= limit
        if step <= 0:
            break

    return best, True


def _fetch_rows(
    cursor: duckdb.DuckDBPyConnection,
    url: str,
    limit: int,
    settings: CatalogSettings,
) -> tuple[list[dict[str, Any]], bool]:
    """The same bounded sample for a file with no geometry column.

    Its own read rather than a branch inside the loop above: with nothing to
    simplify there is no tolerance to coarsen, so the retry that trades detail
    for bytes would re-run an identical query three times. A table's only lever
    is fewer rows, which `_collect` already stops at.
    """
    features, over_budget = _read_sample(
        cursor, "NULL AS __geometry, *", url, None, limit, settings
    )
    return features, over_budget or len(features) >= limit


def _feature(row: dict[str, Any], geometry_column: str | None) -> dict[str, Any]:
    raw = row.pop("__geometry", None)
    geometry = json.loads(raw) if isinstance(raw, str) else None
    properties = {
        name: _scalar(value)
        for name, value in row.items()
        if name != geometry_column and name not in _NON_PROPERTY_COLUMNS
    }
    return {"type": "Feature", "geometry": geometry, "properties": properties}


def _scalar(value: Any) -> Any:
    """A JSON-safe attribute value, keeping numbers numeric.

    The catch-all matters less than the special cases above it: DuckDB hands
    back ``Decimal`` for any DECIMAL column, and stringifying those would put
    ``"157.5"`` in a feature property -- enough to break a client styling or
    charting by that field, and silently, since it still looks like a number.
    """
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        # Attribute blobs are not renderable and can be large; name the type
        # rather than base64 half a megabyte into a preview.
        return f"<{len(bytes(value))} bytes>"
    if isinstance(value, (list, tuple)):
        return [_scalar(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _scalar(v) for k, v in value.items()}
    return str(value)
