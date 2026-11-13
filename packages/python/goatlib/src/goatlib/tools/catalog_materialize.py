"""Materialize a promoted catalog layer's data onto the shared volume.

Promote (``catalog_promote``) creates the ``customer.layer`` row instantly and
leaves the data behind: this job copies it. For a vector/table item that means
the harmonized GeoParquet from the catalog bucket, rewritten once —
Hilbert-ordered so spatial queries prune row groups — to::

    {DATA_DIR}/catalog/layers/t_<layer_id>.parquet

plus PMTiles at the shared flat tiles location. The file is written next to
its final name and moved into place, so a re-run (or a crash mid-way)
overwrites cleanly; the job is idempotent.

Dispatch is by format so the catalog is not limited to vectors: a handler per
``FormatProfile`` key, ``vector`` and ``raster``. A raster item's data asset is
a GeoTIFF, copied as it is to::

    {DATA_DIR}/catalog/layers/t_<layer_id>.tif

because the catalog bucket is private: the copy is the file GOAT stores for
the layer (``goatlib.utils.layer.stored_raster_file``, named from the layer's
id), which geoapi and processes read. The row becomes a raster file layer
(``data_type`` ``cog``) without a ``url``: no address of the file exists. A
future bundle handler is a new entry here, nothing else changes — core only ever
says "materialize layer X" and reads the status back.

Status lives in ``other_properties.catalog_materialize`` on the layer row
(``pending`` → ``running`` → ``ready`` | ``failed``), merged so the
``catalog_item`` snapshot next to it is never touched.
"""

from __future__ import annotations

import json
import logging
import os
import posixpath
import tempfile
import uuid as uuid_module
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, Self

import duckdb
from pydantic import Field

from goatlib.catalog.item import RASTER_SUFFIXES
from goatlib.io.config import parquet_copy_options
from goatlib.tools.base import SimpleToolRunner
from goatlib.tools.schemas import ToolInputBase
from goatlib.utils.container_memory import JOB_WORK_MEMORY_SHARE, set_memory_share
from goatlib.utils.layer import (
    catalog_layer_relation,
    catalog_tiles_dir,
    catalog_view_sql,
    layer_id_to_table_name,
    stored_raster_file,
)

if TYPE_CHECKING:
    from goatlib.io.pmtiles import PMTilesConfig

logger = logging.getLogger(__name__)


#: The handler for each layer type: its data asset's format.
HANDLERS = {"feature": "vector", "table": "vector", "raster": "raster"}


class CatalogMaterializeParams(ToolInputBase):
    """Parameters for the catalog materialize job."""

    layer_id: str = Field(..., description="Promoted layer UUID to materialize")


#: The first bytes of a TIFF and a BigTIFF, in either byte order.
TIFF_SIGNATURES = (b"II*\x00", b"MM\x00*", b"II+\x00", b"MM\x00+")


def bucket_key_for(parquet_url: str, suffixes: tuple[str, ...] = (".parquet",)) -> str:
    """The catalog-bucket key for an item's data asset.

    The published href is relative to the item's place in the bucket's JSON
    tree (``../../../data/<uuid>.parquet`` — contract C8), so only its
    basename is meaningful here; the data prefix is fixed by the bucket
    layout (contract §1). The asset must be of the layer's format: a parquet
    for a vector or table item, a GeoTIFF (`RASTER_SUFFIXES`) for a raster.
    """
    name = posixpath.basename(parquet_url or "")
    if not name.lower().endswith(suffixes):
        raise ValueError(f"Not a {'/'.join(suffixes)} data asset: {parquet_url!r}")
    return f"data/{name}"


def catalog_layers_dir() -> Path:
    """Where the materialized files go — the shared definition, so the writer
    and every reader honour the same `CATALOG_LAYERS_DIR`."""
    from goatlib.utils.layer import catalog_layers_dir as _shared

    return _shared()


def parquet_geometry_column(
    con: duckdb.DuckDBPyConnection, parquet_path: Path
) -> str | None:
    """The first geometry column of a parquet file, None for a table.

    The name comes from an external catalog file's schema: treat it as
    untrusted when splicing it as a SQL identifier.
    """
    cols = con.execute(
        f"DESCRIBE SELECT * FROM read_parquet('{parquet_path}')"
    ).fetchall()
    return next((c[0] for c in cols if "GEOMETRY" in c[1].upper()), None)


def generate_catalog_pmtiles(
    con: duckdb.DuckDBPyConnection,
    layer_id: str,
    parquet_path: Path,
    geometry_column: str,
    config: PMTilesConfig,
) -> Path | None:
    """Tiles for a catalog layer's materialized file, written beside its parquet.

    Not the user tiles directory: everything a catalog layer produces is
    derived from a dataset every deployment harvests, so it lives under the
    catalog tree -- wipeable, rebuildable, shippable prebuilt -- while the
    tiles tree stays the user's own data. In its own directory beside the
    parquet, because tiles are a cache OF that parquet and get cleared on
    their own.

    The generator's SQL selects ``rowid`` from its source, which a parquet
    scan does not have — the catalog layer view (``catalog_view_sql``)
    provides it from ``file_row_number``, and the column is excluded from
    tile properties. Used by the materialize job and by sync_pmtiles, on a
    connection with spatial loaded.

    Returns:
        The PMTiles path, None if the build failed
    """
    from goatlib.io.pmtiles import PMTilesGenerator

    relation = catalog_layer_relation(layer_id)
    # A long-lived connection may hold the view from an earlier file
    con.execute(f"DROP VIEW IF EXISTS {relation}")
    for statement in catalog_view_sql(layer_id, parquet_path):
        con.execute(statement)
    generator = PMTilesGenerator(tiles_data_dir=catalog_tiles_dir(), config=config)
    # A polygon layer's label anchors are built with it
    return generator.generate_from_table(
        duckdb_con=con,
        table_name=relation,
        layer_id=layer_id,
        geometry_column=geometry_column,
        exclude_columns=["rowid"],
    )


class CatalogMaterializeRunner(SimpleToolRunner):
    """Runner for the catalog materialize job."""

    def _catalog_s3(self: Self) -> Any:
        """Client for the catalog bucket — separate credentials from GOAT's
        own bucket, since it is another team's bucket entirely."""
        import boto3

        endpoint = os.environ.get("CATALOG_S3_ENDPOINT_URL") or None
        return boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=os.environ.get("CATALOG_S3_ACCESS_KEY_ID"),
            aws_secret_access_key=os.environ.get("CATALOG_S3_SECRET_ACCESS_KEY"),
            region_name=os.environ.get("CATALOG_S3_REGION") or None,
        )

    async def _set_status(
        self: Self,
        layer_id: str,
        status: Literal["running", "ready", "failed"],
        extra: dict[str, Any] | None = None,
    ) -> None:
        payload: dict[str, Any] = {
            "status": status,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        if extra:
            payload.update(extra)
        pool = await self.get_postgres_pool()
        try:
            await pool.execute(
                f"""
                UPDATE {self.settings.customer_schema}.layer
                SET other_properties = COALESCE(other_properties, '{{}}'::jsonb)
                    || jsonb_build_object('catalog_materialize', $2::jsonb),
                    updated_at = NOW()
                WHERE id = $1
                """,
                uuid_module.UUID(layer_id),
                json.dumps(payload),
            )
        finally:
            await pool.close()

    async def _load_layer(self: Self, layer_id: str) -> dict[str, Any]:
        pool = await self.get_postgres_pool()
        try:
            row = await pool.fetchrow(
                f"""
                SELECT id, type, feature_layer_geometry_type,
                       catalog_external_uid, catalog_version, other_properties
                FROM {self.settings.customer_schema}.layer
                WHERE id = $1
                """,
                uuid_module.UUID(layer_id),
            )
        finally:
            await pool.close()
        if row is None:
            raise ValueError(f"Layer not found: {layer_id}")
        if row["catalog_external_uid"] is None:
            raise ValueError(f"Layer {layer_id} is not a promoted catalog layer")
        props = row["other_properties"]
        if isinstance(props, str):
            props = json.loads(props)
        return {**dict(row), "other_properties": props or {}}

    async def _finish_vector(
        self: Self,
        layer_id: str,
        out_path: Path,
        feature_count: int,
        bounds: tuple[float, float, float, float] | None,
    ) -> None:
        """Layer row updates that only the materialized data can answer."""
        pool = await self.get_postgres_pool()
        try:
            if bounds:
                await pool.execute(
                    f"""
                    UPDATE {self.settings.customer_schema}.layer
                    SET extent = ST_Multi(ST_MakeEnvelope($2, $3, $4, $5, 4326)),
                        size = $6
                    WHERE id = $1
                    """,
                    uuid_module.UUID(layer_id),
                    *bounds,
                    out_path.stat().st_size,
                )
            else:
                await pool.execute(
                    f"""
                    UPDATE {self.settings.customer_schema}.layer
                    SET size = $2 WHERE id = $1
                    """,
                    uuid_module.UUID(layer_id),
                    out_path.stat().st_size,
                )
        finally:
            await pool.close()
        await self._set_status(layer_id, "ready", {"feature_count": feature_count})

    async def _finish_raster(self: Self, layer_id: str, out_path: Path) -> None:
        """The row as a raster file layer (``data_type = 'cog'``), then `ready`.

        Without a ``url``: the catalog bucket is private, so the file has no
        address (and core reads a layer's url as an http(s) address); geoapi
        and processes read `out_path`, the layer's `stored_raster_file`. The
        extent stays the item's bbox, which promote wrote.
        """
        pool = await self.get_postgres_pool()
        try:
            await pool.execute(
                f"""
                UPDATE {self.settings.customer_schema}.layer
                SET data_type = 'cog', url = NULL, size = $2
                WHERE id = $1
                """,
                uuid_module.UUID(layer_id),
                out_path.stat().st_size,
            )
        finally:
            await pool.close()
        await self._set_status(layer_id, "ready")

    def _materialize_raster(self: Self, layer_id: str, href: str) -> Path:
        """Bucket GeoTIFF → `t_<id>.tif` beside the parquet copies, unchanged.

        Only its signature is checked: whatever GDAL reads is served as it is,
        and an object that is no TIFF (an error page, a parquet under a wrong
        name) fails here rather than on every tile.
        """
        bucket = os.environ.get("CATALOG_S3_BUCKET", "")
        if not bucket:
            raise RuntimeError("CATALOG_S3_BUCKET is not configured")
        key = bucket_key_for(href, RASTER_SUFFIXES)

        out_path = stored_raster_file(layer_id)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=out_path.parent) as tmp:
            staged = Path(tmp) / "source.tif"
            self._catalog_s3().download_file(bucket, key, str(staged))
            with staged.open("rb") as f:
                if f.read(4) not in TIFF_SIGNATURES:
                    raise ValueError(f"The catalog object {key} is no GeoTIFF")
            logger.info(
                "Downloaded s3://%s/%s (%d bytes)", bucket, key, staged.stat().st_size
            )
            # Same-directory rename, as for the parquet: atomic.
            os.replace(staged, out_path)
        return out_path

    def _materialize_vector(
        self: Self, layer_id: str, parquet_url: str
    ) -> tuple[Path, int, tuple[float, float, float, float] | None, str | None]:
        """Bucket parquet → Hilbert-ordered local GeoParquet + PMTiles.

        Returns (path, feature_count, bounds, geometry_column).
        """
        bucket = os.environ.get("CATALOG_S3_BUCKET", "")
        if not bucket:
            raise RuntimeError("CATALOG_S3_BUCKET is not configured")
        key = bucket_key_for(parquet_url)

        out_dir = catalog_layers_dir()
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"{layer_id_to_table_name(layer_id)}.parquet"

        con = duckdb.connect()
        set_memory_share(con, JOB_WORK_MEMORY_SHARE)
        try:
            con.execute("INSTALL spatial; LOAD spatial;")
            with tempfile.TemporaryDirectory(dir=out_dir) as tmp:
                src = Path(tmp) / "source.parquet"
                self._catalog_s3().download_file(bucket, key, str(src))
                logger.info(
                    "Downloaded s3://%s/%s (%d bytes)",
                    bucket,
                    key,
                    src.stat().st_size,
                )

                geom_col = parquet_geometry_column(con, src)
                # Double any embedded quote of the untrusted name so it stays
                # inside its "..." quoting.
                geom_col_sql = geom_col.replace('"', '""') if geom_col else None

                staged = Path(tmp) / "staged.parquet"
                if geom_col_sql:
                    con.execute(f"""
                        COPY (
                            SELECT * FROM read_parquet('{src}')
                            ORDER BY ST_Hilbert("{geom_col_sql}")
                        ) TO '{staged}' {parquet_copy_options('COMPRESSION ZSTD')}
                    """)
                else:
                    con.execute(f"""
                        COPY (SELECT * FROM read_parquet('{src}'))
                        TO '{staged}' {parquet_copy_options('COMPRESSION ZSTD')}
                    """)

                # The features a tool can use: tools read the rows that have a
                # geometry, and the workflow check compares this count with
                # their limits. A table without a geometry counts every row.
                counted = f'"{geom_col_sql}"' if geom_col_sql else "*"
                stats = con.execute(
                    f"SELECT count({counted}) FROM read_parquet('{staged}')"
                ).fetchone()
                feature_count = int(stats[0]) if stats else 0
                bounds = None
                if geom_col_sql and feature_count:
                    b = con.execute(f"""
                        SELECT MIN(ST_XMin("{geom_col_sql}")), MIN(ST_YMin("{geom_col_sql}")),
                               MAX(ST_XMax("{geom_col_sql}")), MAX(ST_YMax("{geom_col_sql}"))
                        FROM read_parquet('{staged}')
                        WHERE "{geom_col_sql}" IS NOT NULL
                    """).fetchone()
                    if b and b[0] is not None:
                        bounds = (float(b[0]), float(b[1]), float(b[2]), float(b[3]))

                # Same-directory rename: atomic, and a crash leaves only the
                # TemporaryDirectory to clean up, never a half-written target.
                os.replace(staged, out_path)

            return out_path, feature_count, bounds, geom_col
        finally:
            con.close()

    def _generate_catalog_pmtiles(
        self: Self, layer_id: str, parquet_path: Path, geom_col: str
    ) -> None:
        """Tiles for the materialized file (see generate_catalog_pmtiles)."""
        from goatlib.io.pmtiles import PMTilesConfig

        if not (self.settings and self.settings.pmtiles_enabled):
            return

        con = duckdb.connect()
        set_memory_share(con, JOB_WORK_MEMORY_SHARE)
        try:
            con.execute("INSTALL spatial; LOAD spatial;")
            pmtiles = generate_catalog_pmtiles(
                con,
                layer_id,
                parquet_path,
                geom_col,
                PMTilesConfig(
                    min_zoom=self.settings.pmtiles_min_zoom,
                    max_zoom=self.settings.pmtiles_max_zoom,
                ),
            )
            if pmtiles is None:
                raise RuntimeError("PMTiles generation returned no file")
        finally:
            con.close()

    def run(self: Self, params: CatalogMaterializeParams) -> dict[str, Any]:
        """Materialize one promoted layer; idempotent, safe to re-run."""
        if self.settings is None:
            raise RuntimeError("Settings not initialized. Call init_from_env() first.")

        import asyncio

        loop = asyncio.new_event_loop()
        try:
            layer = loop.run_until_complete(self._load_layer(params.layer_id))
            item = layer["other_properties"].get("catalog_item") or {}
            parquet_url = item.get("parquet_url")

            # Deterministic input errors must land as `failed`, not raise past
            # the status writes: a layer left at `pending` shows "preparing"
            # forever and core's self-heal re-enqueues it every time it is
            # re-added — a loop that never reaches the `failed` caption.
            handler_key = HANDLERS.get(layer["type"])
            problem: str | None = None
            if handler_key is None:
                problem = f"No materialize handler for layer type {layer['type']!r}"
            elif not parquet_url:
                problem = "Layer's catalog_item snapshot has no parquet_url to fetch"
            if problem is not None:
                loop.run_until_complete(
                    self._set_status(params.layer_id, "failed", {"error": problem})
                )
                raise ValueError(problem)

            loop.run_until_complete(self._set_status(params.layer_id, "running"))
            if handler_key == "raster":
                try:
                    raster_path = self._materialize_raster(params.layer_id, parquet_url)
                    loop.run_until_complete(
                        self._finish_raster(params.layer_id, raster_path)
                    )
                except Exception as e:
                    loop.run_until_complete(
                        self._set_status(
                            params.layer_id, "failed", {"error": str(e)[:500]}
                        )
                    )
                    raise
                return {
                    "layer_id": params.layer_id,
                    "status": "ready",
                    "path": str(raster_path),
                    "wm_labels": [params.triggered_by_email]
                    if params.triggered_by_email
                    else [],
                }

            try:
                out_path, count, bounds, geom_col = self._materialize_vector(
                    params.layer_id, parquet_url
                )
                # Ready the moment the DATA is on disk: geoapi serves tiles
                # dynamically until the PMTiles cache exists, so a big layer
                # is usable while its tiles are being built.
                loop.run_until_complete(
                    self._finish_vector(params.layer_id, out_path, count, bounds)
                )
            except Exception as e:
                loop.run_until_complete(
                    self._set_status(params.layer_id, "failed", {"error": str(e)[:500]})
                )
                raise

            tiles_error: str | None = None
            if geom_col:
                try:
                    self._generate_catalog_pmtiles(params.layer_id, out_path, geom_col)
                except Exception as e:  # noqa: BLE001 - data is served either way
                    # The layer STAYS ready — dynamic tiles carry it — but the
                    # job fails so the missing cache is visible and a re-run
                    # (idempotent) rebuilds it.
                    tiles_error = str(e)[:500]
                    loop.run_until_complete(
                        self._set_status(
                            params.layer_id,
                            "ready",
                            {"feature_count": count, "tiles": f"failed: {tiles_error}"},
                        )
                    )
                    raise
            return {
                "layer_id": params.layer_id,
                "status": "ready",
                "path": str(out_path),
                "feature_count": count,
                "geometry_column": geom_col,
                "wm_labels": [params.triggered_by_email]
                if params.triggered_by_email
                else [],
            }
        finally:
            loop.close()
            self.cleanup()


def main(params: CatalogMaterializeParams) -> dict[str, Any]:
    """Windmill entry point."""
    runner = CatalogMaterializeRunner()
    runner.init_from_env()
    return runner.run(params)
