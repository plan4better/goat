"""Dataset-bundle import runner.

Validates an uploaded source, ingests it into DuckLake as member layers, and
creates the bundle + membership rows. Reuses ``SimpleToolRunner``'s ingest
primitives (DuckLake connection, ``_ingest_to_ducklake``, postgres pool) and the
per-type importer plugin — so it stays type-agnostic and runs wherever the tools
run (Windmill, or any env with DuckLake + Postgres configured).

Boundary: this is the *mechanical* side (produce layers, write rows). Policy —
who may import, quota, the HTTP surface — stays in core, which triggers this.
"""

import logging
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional
from uuid import uuid4

from pydantic import BaseModel

from goatlib.bundles.artifacts.build_mixin import BundleArtifactBuildMixin
from goatlib.bundles.artifacts.storage import delete_bundle_artifacts
from goatlib.bundles.importers import get_importer
from goatlib.bundles.importers.base import ValidationResult
from goatlib.io.converter import IOConverter
from goatlib.models.bundle import (
    BundleStatus,
    BundleTypeName,
    get_spec,
    member_draw_rank,
    role_computed_columns,
    role_field_config,
)
from goatlib.models.io import DatasetMetadata
from goatlib.tools.authz import authorize_bundle_ingest
from goatlib.tools.base import BaseToolRunner
from goatlib.tools.db import ToolDatabaseService, normalize_geometry_type
from goatlib.tools.style import get_bundle_style

logger = logging.getLogger(__name__)


class BundleValidationError(Exception):
    """Raised when the uploaded source fails validation against the type spec."""

    def __init__(self, validation: ValidationResult) -> None:
        self.validation = validation
        detail = "; ".join(validation.errors) or "Source failed validation"
        super().__init__(detail)


class ImportedLayer(BaseModel):
    role: str
    layer_id: str
    name: str
    layer_type: str
    geometry_type: Optional[str] = None
    feature_count: int = 0


class BundleImportResult(BaseModel):
    bundle_id: str
    bundle_type: str
    layers: List[ImportedLayer]


def _as_members(imported: List["ImportedLayer"]) -> List[Dict[str, Any]]:
    """Freshly imported layers in the shape the artifact build expects."""
    return [{"role": layer.role, "layer_id": layer.layer_id} for layer in imported]


class BundleImportRunner(BundleArtifactBuildMixin, BaseToolRunner):
    """Multi-output ingest: source → member layers in DuckLake + bundle rows.

    Subclasses ``BaseToolRunner`` to reuse its ingest primitives
    (``_ingest_to_ducklake`` etc.), but drives them directly from
    ``ingest_into_bundle`` — the single-output ``run()``/``process()``
    lifecycle is not used.
    """

    def process(self, params: Any, temp_dir: Path) -> "tuple[Path, DatasetMetadata]":
        raise NotImplementedError(
            "BundleImportRunner uses ingest_into_bundle(), not the "
            "single-output run()/process() lifecycle."
        )

    async def _cleanup_layers(
        self, db: ToolDatabaseService, user_id: str, layer_ids: List[str]
    ) -> None:
        """Best-effort removal of member layers created before a failure — their
        DuckLake tables and Postgres rows (which cascade the membership links) —
        so a partial import never leaves orphaned data behind."""
        if not layer_ids:
            return
        self.recycle_duckdb_connection()  # start from a clean connection for drops
        for layer_id in layer_ids:
            try:
                self.duckdb_con.execute(
                    f"DROP TABLE IF EXISTS {self.get_layer_table_path(layer_id)}"
                )
            except Exception as e:  # pragma: no cover - best-effort cleanup
                logger.warning(
                    "Cleanup: could not drop DuckLake table %s: %s", layer_id, e
                )
            try:
                await db.delete_layer(layer_id)
            except Exception as e:  # pragma: no cover - best-effort cleanup
                logger.warning(
                    "Cleanup: could not delete layer row %s: %s", layer_id, e
                )
        logger.info("Rolled back %d partially-imported layer(s)", len(layer_ids))

    async def _rollback_bundle(
        self,
        db: ToolDatabaseService,
        *,
        user_id: str,
        bundle_id: str,
        imported: List[ImportedLayer],
    ) -> None:
        """Undo everything a failed bundle job created.

        A bundle that failed part-way leaves nothing that can be completed:
        there is no retry that fills in half an ingest, and the only action such
        a bundle offers — rebuild its artifacts — needs the member layers this
        removes. So the whole thing goes and the job carries the failure.

        Three things in order, because each is a different store: the member
        layers (DuckLake tables and their Postgres rows), any artifact file
        already written to the data volume, and the bundle row last, since the
        others reference it. Shared by the import and the filtered copy rather
        than spelled out in each — they had already drifted, and the copy was
        the one leaving artifact files behind.
        """
        assert self.settings is not None
        await self._cleanup_layers(db, user_id, [layer.layer_id for layer in imported])
        delete_bundle_artifacts(self.settings.bundles_data_dir, str(bundle_id))
        await db.delete_bundle(bundle_id)

    async def _ingest_layers(
        self,
        db: ToolDatabaseService,
        *,
        source_path: str,
        bundle_type: "BundleTypeName | str",
        user_id: str,
        folder_id: str,
        bundle_id: str,
    ) -> List[ImportedLayer]:
        """Extract, ingest to DuckLake, and link each member layer. Assumes the
        bundle row already exists (FK target for the membership links).

        Member creation isn't a single transaction (DuckLake tables + separate
        Postgres rows), so on any failure we roll back the layers created so far
        to avoid orphaned tables/rows, then re-raise."""
        importer = get_importer(bundle_type)
        converter = IOConverter()
        imported: List[ImportedLayer] = []
        created_layer_ids: List[str] = []
        # Prefix member-layer names with the bundle name (e.g. "gtfs_fr Stops") so
        # they read cleanly and stay unique across bundles whose members share
        # standard names (stops, calendar, …).
        bundle_name = await db.get_bundle_name(bundle_id)
        with tempfile.TemporaryDirectory() as workdir:
            layers = importer.extract_layers(source_path, workdir)
            try:
                for i, extracted in enumerate(layers):
                    layer_id = str(uuid4())
                    # Tracked before ingest so a table created by a failing step
                    # is still dropped during cleanup.
                    created_layer_ids.append(layer_id)

                    # Importers may emit ready-to-ingest parquet (e.g. GTFS
                    # attribute tables) or a source file (GeoJSON/CSV) that needs
                    # conversion.
                    if extracted.file_path.endswith(".parquet"):
                        parquet_path = Path(extracted.file_path)
                    else:
                        parquet_path = Path(workdir) / f"out_{i}.parquet"
                        converter.to_parquet(
                            src_path=extracted.file_path,
                            out_path=str(parquet_path),
                            target_crs="EPSG:4326",
                        )
                    info = self._ingest_to_ducklake(
                        user_id=user_id, layer_id=layer_id, parquet_path=parquet_path
                    )

                    # The role's contract as per-column metadata: which columns
                    # are computed and by what formula, which the bundle owns,
                    # which take a vocabulary, and what a blank one defaults to.
                    # Projected from the spec by `role_field_config`, so a
                    # filtered copy and a backfill produce the same blob.
                    role_spec = get_spec(bundle_type).role(extracted.role)
                    field_config = role_field_config(role_spec)

                    # The DDL half of the same contract: a computed column has
                    # to exist on the table and hold a value, filled from the
                    # kind's own SQL so it matches what a later recompute
                    # produces.
                    #
                    # An importer's writer may already declare the column (to
                    # place it sensibly and fix its width) and fill it with the
                    # same expression. Where it has, nothing is recomputed: a
                    # DuckLake UPDATE rewrites every row of the table, which on
                    # a city-scale edges layer costs more than the whole import.
                    computed = role_computed_columns(role_spec)
                    if computed:
                        table = self.get_layer_table_path(layer_id)
                        existing = {
                            row[0]
                            for row in self.duckdb_con.execute(
                                f"SELECT column_name FROM (DESCRIBE {table})"
                            ).fetchall()
                        }
                        for column, kind in computed.items():
                            if column not in existing:
                                self.duckdb_con.execute(
                                    f'ALTER TABLE {table} ADD COLUMN "{column}" '
                                    f"{kind.duckdb_type}"
                                )
                                unfilled = True
                            else:
                                # Declared but possibly not filled. One null is
                                # enough to decide, so stop at the first.
                                unfilled = bool(
                                    self.duckdb_con.execute(
                                        f"SELECT 1 FROM {table} "
                                        f'WHERE "{column}" IS NULL LIMIT 1'
                                    ).fetchone()
                                )
                            if unfilled:
                                self.duckdb_con.execute(
                                    f'UPDATE {table} SET "{column}" = '
                                    f"{kind.compute_sql()}"
                                )

                    layer_name = (
                        f"{bundle_name} {extracted.name}"
                        if bundle_name
                        else extracted.name
                    )
                    await db.create_layer(
                        layer_id=layer_id,
                        user_id=user_id,
                        folder_id=folder_id,
                        name=layer_name,
                        layer_type=extracted.layer_type,
                        feature_layer_type=(
                            "standard" if extracted.layer_type == "feature" else None
                        ),
                        geometry_type=info.get("geometry_type"),
                        extent_wkt=info.get("extent_wkt"),
                        feature_count=info.get("feature_count", 0),
                        size=info.get("size", 0),
                        # Stated rather than left to `create_layer`, which
                        # picks a random colour when given none: a bundle's
                        # members are one dataset and should not arrive in two
                        # unrelated colours.
                        properties=get_bundle_style(
                            bundle_type,
                            extracted.role,
                            normalize_geometry_type(info.get("geometry_type")),
                        ),
                    )
                    if field_config:
                        await db.set_layer_field_config(layer_id, field_config)
                    await db.add_layer_to_bundle(
                        bundle_id=bundle_id, layer_id=layer_id, role=extracted.role
                    )

                    imported.append(
                        ImportedLayer(
                            role=extracted.role,
                            layer_id=layer_id,
                            name=layer_name,
                            layer_type=extracted.layer_type,
                            geometry_type=info.get("geometry_type"),
                            feature_count=info.get("feature_count", 0),
                        )
                    )
                    # Each CREATE TABLE is its own DuckLake commit; recycling the
                    # connection between layers keeps the catalog cache bounded.
                    self.recycle_duckdb_connection()
            except Exception:
                await self._cleanup_layers(db, user_id, created_layer_ids)
                raise
        return imported

    async def _add_bundle_to_project(
        self,
        db: ToolDatabaseService,
        *,
        project_id: str,
        bundle_id: str,
        bundle_type: "BundleTypeName | str",
        imported: List[ImportedLayer],
    ) -> None:
        """Place the freshly-imported member layers into a locked bundle-backed
        group in the given project (the upload-from-within-a-project flow).

        The group goes on top of what the project already holds, with its
        members directly beneath it, so the bundle arrives as one block instead
        of scattering through the panel — and in the same place a bundle added
        to a project by hand arrives.

        Each project layer gets the same default style the member layer was
        created with, so it matches adding the bundle to a project manually."""
        bundle_name = await db.get_bundle_name(bundle_id) or "Bundle"
        group_id, group_order = await db.create_bundle_project_group(
            project_id=project_id,
            bundle_id=bundle_id,
            name=bundle_name,
            # Room for the header plus every member, made before any of them
            # is written.
            member_count=len(imported),
        )
        # Points before lines before polygons, so a node is not buried under
        # the edges it joins. Stable, so members of one geometry keep the
        # order the spec lists their roles in.
        placed = sorted(
            imported,
            key=lambda layer: member_draw_rank(
                normalize_geometry_type(layer.geometry_type)
            ),
        )
        try:
            for position, layer in enumerate(placed):
                geom = normalize_geometry_type(layer.geometry_type)
                properties = (
                    get_bundle_style(bundle_type, layer.role, geom) if geom else None
                )
                await db.add_to_project(
                    layer_id=layer.layer_id,
                    project_id=project_id,
                    name=layer.name,
                    properties=properties,
                    group_id=group_id,
                    # Directly below the group header, in import order. Without an
                    # explicit position every member lands on 0 and they tie.
                    order=group_order + 1 + position,
                )
        except Exception:
            # Roll back the partially-populated group (cascades its links) so a
            # failure never leaves a half-filled locked bundle group behind.
            await db.delete_layer_project_group(group_id)
            raise
        logger.info(
            "Added bundle %s to project %s (%d member layers)",
            bundle_id,
            project_id,
            len(imported),
        )

    async def ingest_into_bundle(
        self,
        *,
        bundle_id: str,
        source_path: str,
        bundle_type: "BundleTypeName | str",
        user_id: str,
        folder_id: str,
        project_id: Optional[str] = None,
    ) -> BundleImportResult:
        """Validate the source, ingest it into an ALREADY-CREATED bundle (member
        layers), then flip the bundle's terminal status.

        When ``project_id`` is given (upload from within a project), the bundle
        is also added to that project as a locked bundle-backed group.

        This runs as the Windmill job kicked off by core's import endpoint (core
        created the shell as ``processing``). Because the job completes
        disconnected from any core request, the terminal status transition
        (``ready``/``failed``) is written here."""
        assert self.settings is not None, "init_from_env()/init() must run first"

        type_value = BundleTypeName(bundle_type).value
        pool = await self.get_postgres_pool()
        db = ToolDatabaseService(pool, schema=self.settings.customer_schema)
        imported: List[ImportedLayer] = []
        try:
            # Both ids arrive as tool inputs and the processes service
            # authorizes no id before dispatch, so core being the only caller
            # today is not a guarantee. Outside the inner try on purpose: a
            # refused job must not reach the rollback below, which deletes the
            # bundle — removing one the caller was just told they may not touch
            # would be worse than the unchecked ingest.
            await authorize_bundle_ingest(
                db, user_id=user_id, bundle_id=bundle_id, folder_id=folder_id
            )
            try:
                # Validated here rather than by core: an upload's problems have
                # to reach the person who uploaded it, and only a job's failure
                # is reported back — an error raised in the request that created
                # the shell is never shown. Inside the inner try, so a refusal
                # rolls the shell back like any other failed import rather than
                # leaving a bundle holding nothing.
                validation = get_importer(bundle_type).validate(source_path)
                if not validation.valid:
                    raise BundleValidationError(validation)
                imported = await self._ingest_layers(
                    db,
                    source_path=source_path,
                    bundle_type=bundle_type,
                    user_id=user_id,
                    folder_id=folder_id,
                    bundle_id=bundle_id,
                )
                await db.update_bundle_metadata(
                    bundle_id=bundle_id,
                    metadata=get_importer(bundle_type)
                    .extract_metadata(source_path)
                    .stated(),
                )
                # Artifacts gate readiness: the bundle stays "processing" until
                # its derived artifacts (e.g. the routing .bin) are built.
                await self.build_and_store_artifacts(
                    db,
                    bundle_id=bundle_id,
                    bundle_type=bundle_type,
                    source_path=source_path,
                    user_id=user_id,
                    members=_as_members(imported),
                )
            except Exception:
                await self._rollback_bundle(
                    db, user_id=user_id, bundle_id=bundle_id, imported=imported
                )
                raise
            await db.update_bundle_status(
                bundle_id=bundle_id, status=BundleStatus.ready
            )
            # Add to the originating project (best-effort: the bundle is a valid,
            # ready import even if the project association fails).
            if project_id:
                try:
                    await self._add_bundle_to_project(
                        db,
                        project_id=project_id,
                        bundle_id=bundle_id,
                        bundle_type=type_value,
                        imported=imported,
                    )
                except Exception:
                    logger.exception(
                        "Bundle %s imported but could not be added to project %s",
                        bundle_id,
                        project_id,
                    )
            return BundleImportResult(
                bundle_id=bundle_id, bundle_type=type_value, layers=imported
            )
        finally:
            await pool.close()
            self.cleanup()
