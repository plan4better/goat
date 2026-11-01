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
``FormatProfile`` key, of which ``vector`` is the only one implemented. A
future COG or bundle handler is a new entry here, nothing else changes —
core only ever says "materialize layer X" and reads the status back.

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
from typing import Any, Literal, Self

import duckdb
from pydantic import Field

from goatlib.io.config import parquet_copy_options
from goatlib.tools.base import SimpleToolRunner
from goatlib.tools.schemas import ToolInputBase
from goatlib.utils.container_memory import JOB_WORK_MEMORY_SHARE, set_memory_share
from goatlib.utils.layer import catalog_tiles_dir, layer_id_to_table_name

logger = logging.getLogger(__name__)


class CatalogMaterializeParams(ToolInputBase):
    """Parameters for the catalog materialize job."""

    layer_id: str = Field(..., description="Promoted layer UUID to materialize")


def bucket_key_for(parquet_url: str) -> str:
    """The catalog-bucket key for an item's data asset.

    The published href is relative to the item's place in the bucket's JSON
    tree (``../../../data/<uuid>.parquet`` — contract C8), so only its
    basename is meaningful here; the data prefix is fixed by the bucket
    layout (contract §1).
    """
    name = posixpath.basename(parquet_url or "")
    if not name.endswith(".parquet"):
        raise ValueError(f"Not a parquet data asset: {parquet_url!r}")
    return f"data/{name}"


def catalog_layers_dir() -> Path:
    """Where the materialized files go — the shared definition, so the writer
    and every reader honour the same `CATALOG_LAYERS_DIR`."""
    from goatlib.utils.layer import catalog_layers_dir as _shared

    return _shared()


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

                cols = con.execute(
                    f"DESCRIBE SELECT * FROM read_parquet('{src}')"
                ).fetchall()
                geom_col = next(
                    (c[0] for c in cols if "GEOMETRY" in c[1].upper()), None
                )
                # The column name comes from an external catalog file's schema,
                # so treat it as untrusted when splicing it as a SQL identifier:
                # double any embedded quote so it stays inside its "..." quoting.
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
        """Tiles for the materialized file, written beside its parquet.

        Not the user tiles directory: everything a catalog layer produces is
        derived from a dataset every deployment harvests, so it lives under the
        catalog tree -- wipeable, rebuildable, shippable prebuilt -- while the
        tiles tree stays the user's own data. In its own directory beside the
        parquet, because tiles are a cache OF that parquet and get cleared on
        their own.

        The generator's SQL selects ``rowid`` from its source, which a parquet
        scan does not have — a view naming ``file_row_number`` provides it,
        and the column is excluded from tile properties.
        """
        from goatlib.io.pmtiles import PMTilesConfig, PMTilesGenerator

        if not (self.settings and self.settings.pmtiles_enabled):
            return

        # External-file column name → untrusted identifier; escape embedded
        # quotes so every quoted interpolation (here and in the generator's own
        # SQL, which also quotes it) stays a single identifier.
        geom_col_sql = geom_col.replace('"', '""')

        con = duckdb.connect()
        set_memory_share(con, JOB_WORK_MEMORY_SHARE)
        try:
            con.execute("INSTALL spatial; LOAD spatial;")
            view = f"cat_{layer_id_to_table_name(layer_id)}"
            con.execute(f"""
                CREATE VIEW "{view}" AS
                SELECT file_row_number AS rowid, * EXCLUDE (file_row_number)
                FROM read_parquet('{parquet_path}', file_row_number=true)
            """)
            generator = PMTilesGenerator(
                tiles_data_dir=catalog_tiles_dir(),
                config=PMTilesConfig(
                    min_zoom=self.settings.pmtiles_min_zoom,
                    max_zoom=self.settings.pmtiles_max_zoom,
                ),
            )
            pmtiles = generator.generate_from_table(
                duckdb_con=con,
                table_name=f'"{view}"',
                layer_id=layer_id,
                geometry_column=geom_col_sql,
                exclude_columns=["rowid"],
                show_progress=False,
            )
            if pmtiles is None:
                raise RuntimeError("PMTiles generation returned no file")

            geom_type = con.execute(
                f'SELECT ST_GeometryType("{geom_col_sql}") FROM "{view}" '
                f'WHERE "{geom_col_sql}" IS NOT NULL LIMIT 1'
            ).fetchone()
            if geom_type and "POLYGON" in str(geom_type[0]).upper():
                generator.generate_anchor_from_table(
                    duckdb_con=con,
                    table_name=f'"{view}"',
                    layer_id=layer_id,
                    geometry_column=geom_col_sql,
                    exclude_columns=["rowid"],
                    show_progress=False,
                )
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
            handler_key = "vector" if layer["type"] in ("feature", "table") else None
            problem: str | None = None
            if handler_key != "vector":
                problem = f"No materialize handler for layer type {layer['type']!r}"
            elif not parquet_url:
                problem = "Layer's catalog_item snapshot has no parquet_url to fetch"
            if problem is not None:
                loop.run_until_complete(
                    self._set_status(params.layer_id, "failed", {"error": problem})
                )
                raise ValueError(problem)

            loop.run_until_complete(self._set_status(params.layer_id, "running"))
            try:
                out_path, count, bounds, geom_col = self._materialize_vector(
                    params.layer_id, parquet_url
                )
                # Ready the moment the DATA is on disk: geoapi serves tiles
                # dynamically until the PMTiles cache exists, so a big layer
                # is usable while tippecanoe still runs.
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
