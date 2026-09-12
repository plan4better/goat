"""Create a new bundle from a spatially filtered copy of an existing one.

The source bundle is never touched. Every member layer is copied with the
filter applied, the copies are linked to a new bundle, and its artifacts are
built from them — so the new bundle is a fully independent thing with its own
routable graph, the same as any imported one.

The filter is applied to each member independently rather than to one "primary"
layer with the rest derived from it. That means a street clipped at the boundary
can survive while the node at its far end does not, and the artifact build drops
such an edge (it inner-joins edges against the nodes layer and warns). Living
with that keeps this tool free of per-bundle-type relationships: nothing here
knows that an edge names two nodes.

Only types whose artifacts are built from their member layers can be filtered.
A GTFS bundle's graph comes from the uploaded feed, which is not kept, so a
filtered copy could not build one.
"""

import logging
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional
from uuid import uuid4

from pydantic import ConfigDict, Field

from goatlib.analysis.schemas.ui import (
    SECTION_INPUT,
    SECTION_OUTPUT,
    SECTION_RESULT,
    ui_field,
    ui_sections,
)
from goatlib.bundles.artifacts import get_artifact_builder
from goatlib.bundles.runner import BundleImportRunner, ImportedLayer
from goatlib.models.bundle import (
    BundleStatus,
    BundleTypeName,
    get_spec,
    role_field_config,
)
from goatlib.models.io import DatasetMetadata
from goatlib.storage.query_builder import build_cql_filter
from goatlib.tools.authz import authorize_bundle_copy
from goatlib.tools.db import ToolDatabaseService, normalize_geometry_type
from goatlib.tools.schemas import ToolInputBase
from goatlib.tools.style import get_bundle_style

logger = logging.getLogger(__name__)


class BundleCreateFilteredParams(ToolInputBase):
    """Parameters for creating a bundle from a filtered copy."""

    model_config = ConfigDict(
        json_schema_extra=ui_sections(SECTION_INPUT, SECTION_RESULT, SECTION_OUTPUT)
    )

    source_bundle_id: str = Field(
        ...,
        description="ID of the bundle to copy",
        json_schema_extra=ui_field(section="input", field_order=1, hidden=True),
    )
    cql_filter: Dict[str, Any] = Field(
        ...,
        description="CQL2-JSON filter applied to every member layer that has "
        "geometry. Spatial, in practice: it has to mean something against each "
        "member's own schema, and only a geometry predicate does.",
        json_schema_extra=ui_field(section="input", field_order=2, hidden=True),
    )
    folder_id: str = Field(
        ...,
        description="Folder the new bundle and its layers are created in",
        json_schema_extra=ui_field(section="output", field_order=1, hidden=True),
    )
    result_bundle_name: Optional[str] = Field(
        None,
        description="Name for the new bundle",
        json_schema_extra=ui_field(section="result", field_order=1),
    )
    project_id: Optional[str] = Field(
        None,
        description="Add the new bundle to this project once its layers exist",
        json_schema_extra=ui_field(section="output", field_order=2, hidden=True),
    )


class BundleCreateFilteredRunner(BundleImportRunner):
    """Copies a bundle's member layers through a filter into a new bundle.

    Subclasses the import runner for what a bundle needs whatever its source:
    the DuckLake ingest primitives, rolling back layers when a later stage
    fails, adding the finished bundle to a project, and building its artifacts.
    Only where the layers come from differs — an existing bundle rather than an
    uploaded file — so ``_ingest_layers`` and its importer plugin are not used.
    """

    def process(self, params: Any, temp_dir: Path) -> "tuple[Path, DatasetMetadata]":
        raise NotImplementedError(
            "BundleCreateFilteredRunner uses run_filtered(), not the "
            "single-output run()/process() lifecycle."
        )

    def _export_filtered(
        self, layer_id: str, cql_filter: Optional[Dict[str, Any]], workdir: str
    ) -> str:
        """A member layer's filtered rows as parquet, written into ``workdir``.

        Copied straight out of DuckLake rather than through
        ``export_layer_to_parquet``: that resolves the layer's owner with a
        nested ``run_until_complete``, which cannot work inside an already
        running event loop. The owner is known from the bundle anyway.

        The caller owns ``workdir`` and removes it, the way
        ``BundleImportRunner._ingest_layers`` does: a city-scale member layer
        is tens to hundreds of MB, and a directory per member left behind fills
        the worker's disk one job at a time.
        """
        import json

        table = self.get_layer_table_path(layer_id)
        out = Path(workdir) / f"{layer_id}.parquet"
        clause = ""
        params: List[Any] = []
        if cql_filter:
            described = self.duckdb_con.execute(
                f"DESCRIBE SELECT * FROM {table}"
            ).fetchall()
            columns = [row[0] for row in described]
            geometry_column = next(
                (row[0] for row in described if "GEOMETRY" in str(row[1]).upper()),
                "geometry",
            )
            filters = build_cql_filter(
                {"filter": json.dumps(cql_filter), "lang": "cql2-json"},
                columns,
                geometry_column,
            )
            if not filters.clauses:
                # `build_cql_filter` logs the parse error and hands back no
                # clauses, which for its usual caller means "show everything".
                # Here it would mean copying the whole source bundle — a
                # full-size, unfiltered duplicate of a city network — and
                # calling it the filtered copy the user asked for. A filter
                # that did not compile is a failed job, not an empty one.
                raise ValueError(
                    "The filter could not be applied to this bundle's member "
                    "layers, so a filtered copy cannot be made. Check the "
                    "filter and try again."
                )
            clause = f" WHERE {' AND '.join(filters.clauses)}"
            params = list(filters.params)
        self.duckdb_con.execute(
            f"COPY (SELECT * FROM {table}{clause}) TO '{out}' (FORMAT PARQUET)",
            params,
        )
        return str(out)

    async def run_filtered(
        self,
        *,
        source_bundle_id: str,
        cql_filter: Dict[str, Any],
        user_id: str,
        folder_id: str,
        result_bundle_name: Optional[str] = None,
        project_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        assert self.settings is not None, "init_from_env()/init() must run first"

        pool = await self.get_postgres_pool()
        db = ToolDatabaseService(pool, schema=self.settings.customer_schema)

        # Everything from here needs the pool, so the whole of it sits
        # inside the try whose finally closes it — including the
        # authorization refusals below, which are the earliest way out.
        try:
            # Both ids came in as tool inputs and neither has been checked against
            # the caller yet: the processes service dispatches a job without
            # authorizing its inputs, so without this an authenticated user could
            # copy any bundle by id, or write the copy into somebody else's folder.
            # Asked before anything is created or exported, so a refused job leaves
            # nothing behind. `tools/authz.py` holds the verb-per-tool reasoning.
            await authorize_bundle_copy(
                db,
                user_id=user_id,
                source_bundle_id=source_bundle_id,
                folder_id=folder_id,
            )

            source = await db.get_bundle(source_bundle_id)
            bundle_type = BundleTypeName(source["bundle_type"])
            members = await db.list_bundle_layers(source_bundle_id)
            if not members:
                raise ValueError(
                    "The source bundle holds no member layers, so there is nothing "
                    "to filter."
                )

            builder = get_artifact_builder(bundle_type)
            if builder is not None and not builder.builds_from_layers:
                raise ValueError(
                    f"A '{bundle_type.value}' bundle's artifacts are built from the "
                    "uploaded source, which is not kept, so a filtered copy could "
                    "not build them. Filtering is not supported for this type."
                )

            spec = get_spec(bundle_type)
            source_name = await db.get_bundle_name(source_bundle_id)
            name = result_bundle_name or f"{source_name} (filtered)"

            bundle_id = str(uuid4())
            await db.create_bundle(
                bundle_id=bundle_id,
                user_id=user_id,
                folder_id=folder_id,
                name=name,
                bundle_type=bundle_type,
                status=BundleStatus.processing,
                # What the source says about itself describes the copy just as
                # well, so both travel with it rather than the copy arriving blank.
                description=source.get("description"),
                dataset_metadata=source.get("dataset_metadata"),
            )

            imported: List[ImportedLayer] = []
            try:
                # One workdir for every member's parquet, removed on the way
                # out — the same shape `_ingest_layers` uses, and for the same
                # reason: these files are tens to hundreds of MB each.
                with tempfile.TemporaryDirectory(
                    prefix="goat_bundle_filter_"
                ) as workdir:
                    for member in members:
                        imported.append(
                            await self._copy_member(
                                db,
                                member=member,
                                cql_filter=cql_filter,
                                user_id=user_id,
                                folder_id=folder_id,
                                bundle_id=bundle_id,
                                bundle_name=name,
                                spec=spec,
                                workdir=workdir,
                            )
                        )
                await self.build_and_store_artifacts(
                    db,
                    bundle_id=bundle_id,
                    bundle_type=bundle_type,
                    source_path="",
                    user_id=user_id,
                    members=[
                        {"role": layer.role, "layer_id": layer.layer_id}
                        for layer in imported
                    ],
                )
            except Exception:
                # Same contract as an import that fails, through the same
                # function: nothing half-built is left behind — layers,
                # artifact files and the bundle row all go — and the job
                # carries the failure.
                await self._rollback_bundle(
                    db, user_id=user_id, bundle_id=bundle_id, imported=imported
                )
                raise

            await db.update_bundle_status(
                bundle_id=bundle_id, status=BundleStatus.ready
            )
            if project_id:
                try:
                    await self._add_bundle_to_project(
                        db,
                        project_id=project_id,
                        bundle_id=bundle_id,
                        imported=imported,
                    )
                except Exception as e:  # pragma: no cover - best effort
                    logger.warning(
                        "Filtered bundle %s created but not added to project " "%s: %s",
                        bundle_id,
                        project_id,
                        e,
                    )
            logger.info(
                "Created filtered bundle %s from %s (%d member layer(s))",
                bundle_id,
                source_bundle_id,
                len(imported),
            )
            return {
                "bundle_id": bundle_id,
                "bundle_type": bundle_type.value,
                "layers": [layer.model_dump() for layer in imported],
            }
        finally:
            await pool.close()
            self.cleanup()

    @staticmethod
    def _merged_field_config(
        role_config: Dict[str, Any], stored: Optional[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """The role's field_config with the source layer's entries on top.

        Merged per column rather than per blob: a column the role describes and
        the layer also has an entry for keeps both halves — the role's
        ``is_computed``/``kind``/``is_locked`` and the layer's own
        ``display_config`` — instead of one side replacing the other wholesale.
        Where both name the same key the layer's value wins, because that one
        is the user's.
        """
        merged: Dict[str, Any] = {
            column: dict(entry) for column, entry in role_config.items()
        }
        for column, entry in (stored or {}).items():
            if isinstance(merged.get(column), dict) and isinstance(entry, dict):
                merged[column].update(entry)
            else:
                merged[column] = entry
        return merged

    async def _copy_member(
        self,
        db: ToolDatabaseService,
        *,
        member: Dict[str, Any],
        cql_filter: Dict[str, Any],
        user_id: str,
        folder_id: str,
        bundle_id: str,
        bundle_name: str,
        spec: Any,
        workdir: str,
    ) -> ImportedLayer:
        """One member layer, filtered, as a layer of the new bundle."""
        role = member["role"]
        source_layer_id = str(member["layer_id"])
        source = await db.get_layer_info(source_layer_id)
        if source is None:
            raise ValueError(f"Member layer {source_layer_id} no longer exists.")

        # A geometry predicate is meaningless on an attribute table, and
        # applying it would empty the layer. Such a member is copied whole.
        has_geometry = bool(source.get("geometry_type"))
        parquet = self._export_filtered(
            source_layer_id, cql_filter if has_geometry else None, workdir
        )

        layer_id = str(uuid4())
        info = self._ingest_to_ducklake(
            user_id=user_id, layer_id=layer_id, parquet_path=Path(parquet)
        )
        geometry_type = normalize_geometry_type(info.get("geometry_type"))
        await db.create_layer(
            layer_id=layer_id,
            user_id=user_id,
            folder_id=folder_id,
            # Named the way the importer names members — "<bundle> <Role>" —
            # from the spec's own label rather than by pulling the old name
            # apart.
            name=f"{bundle_name} {(spec.role(role).label if spec.role(role) else role)}",
            layer_type=source.get("type") or "feature",
            feature_layer_type=source.get("feature_layer_type"),
            geometry_type=geometry_type,
            extent_wkt=info.get("extent_wkt"),
            feature_count=info.get("feature_count", 0),
            size=info.get("size", 0),
            # The same style the original's members were created with, from
            # the same rule — a clipped copy of a street network should not
            # arrive in different colours from the network it came from.
            properties=(
                get_bundle_style(spec.type, role, geometry_type)
                if geometry_type
                else None
            ),
        )
        # The copy is the same kind of layer as the original, so it keeps the
        # per-column metadata: computed columns, locked flags, vocabularies and
        # defaults all still apply to it.
        #
        # The role's own contract goes UNDER whatever the source layer stores.
        # Two things follow from that order. A copy of a bundle imported before
        # the contract existed comes out with it anyway — which is what lets a
        # filtered copy of a legacy bundle behave like a fresh import, rather
        # than inheriting the gap that makes its edges layer uneditable. And
        # anything the user authored on the source — a column's display config,
        # a vocabulary they extended — still wins, because their entry is the
        # one that overwrites.
        field_config = self._merged_field_config(
            role_field_config(spec.role(role)), source.get("field_config")
        )
        if field_config:
            await db.set_layer_field_config(layer_id, field_config)
        await db.add_layer_to_bundle(bundle_id=bundle_id, layer_id=layer_id, role=role)
        return ImportedLayer(
            role=role,
            layer_id=layer_id,
            name=str(source.get("name") or role),
            layer_type=source.get("type") or "feature",
            geometry_type=geometry_type,
            feature_count=info.get("feature_count", 0),
        )


def main(params: BundleCreateFilteredParams) -> dict:
    """Windmill entry point."""
    from goatlib.tools.base import _get_or_create_event_loop

    runner = BundleCreateFilteredRunner()
    runner.init_from_env()
    return _get_or_create_event_loop().run_until_complete(
        runner.run_filtered(
            source_bundle_id=params.source_bundle_id,
            cql_filter=params.cql_filter,
            user_id=params.user_id,
            folder_id=params.folder_id,
            result_bundle_name=params.result_bundle_name,
            project_id=params.project_id,
        )
    )
