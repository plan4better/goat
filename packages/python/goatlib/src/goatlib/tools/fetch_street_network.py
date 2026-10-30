"""Create a street network bundle from GOAT's own routing network, for an area.

The cut itself is in `goatlib.io.fetch.street_network`; this stores
it as a street_network bundle with its routable artifact, which routes on the
network's slope.
"""

import logging
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional
from uuid import uuid4

import duckdb
from pydantic import ConfigDict, Field

from goatlib.analysis.schemas.ui import (
    SECTION_INPUT,
    SECTION_OUTPUT,
    ui_field,
    ui_sections,
)
from goatlib.bundles.importers.base import ExtractedLayer
from goatlib.bundles.runner import BundleImportRunner, ImportedLayer
from goatlib.io.fetch.street_network import export_network
from goatlib.models.bundle import (
    BundleStatus,
    BundleTypeName,
    get_spec,
)
from goatlib.models.io import DatasetMetadata
from goatlib.tools.authz import require_can
from goatlib.tools.db import ToolDatabaseService
from goatlib.tools.schemas import ToolInputBase

logger = logging.getLogger(__name__)


class FetchStreetNetworkParams(ToolInputBase):
    """Where to cut the routing network, and where the bundle goes."""

    model_config = ConfigDict(
        json_schema_extra=ui_sections(SECTION_INPUT, SECTION_OUTPUT)
    )

    area: dict = Field(
        ...,
        description="GeoJSON polygon the network is cut to",
        json_schema_extra=ui_field(section="input", field_order=1, hidden=True),
    )
    folder_id: str = Field(
        ...,
        description="Folder the bundle and its layers are created in",
        json_schema_extra=ui_field(section="output", field_order=1, hidden=True),
    )
    result_bundle_name: Optional[str] = Field(
        None,
        description="Name for the new bundle",
        json_schema_extra=ui_field(section="output", field_order=3),
    )
    project_id: Optional[str] = Field(
        None,
        description="Add the new bundle to this project once its layers exist",
        json_schema_extra=ui_field(section="output", field_order=2, hidden=True),
    )


class FetchStreetNetworkRunner(BundleImportRunner):
    """Cuts the routing network to an area and stores it as a bundle."""

    def process(self, params: Any, temp_dir: Path) -> "tuple[Path, DatasetMetadata]":
        raise NotImplementedError(
            "FetchStreetNetworkRunner builds a bundle through run_extract()."
        )

    async def run_extract(
        self,
        *,
        area: dict,
        user_id: str,
        folder_id: str,
        result_bundle_name: Optional[str] = None,
        project_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        assert self.settings is not None, "init_from_env()/init() must run first"
        pool = await self.get_postgres_pool()
        db = ToolDatabaseService(pool, schema=self.settings.customer_schema)
        try:
            # The job is dispatched without its inputs being checked, so the
            # folder is asked about here, before anything is created.
            await require_can(
                db,
                resource_type="folder",
                resource_id=folder_id,
                user_id=user_id,
                action="write",
                refusal=(
                    f"You cannot create content in folder {folder_id}, so the "
                    "street network has nowhere to go."
                ),
            )
            bundle_type = BundleTypeName.street_network
            spec = get_spec(bundle_type)
            name = result_bundle_name or "GOAT street network"
            # Cut first: a refused area (too large, no network) leaves nothing behind.
            with tempfile.TemporaryDirectory(prefix="goat_network_cut_") as workdir:
                con = duckdb.connect()
                try:
                    paths = export_network(
                        con,
                        area=area,
                        edges_base=self.settings.street_network_edges_base_path,
                        nodes_base=self.settings.street_network_nodes_base_path,
                        workdir=workdir,
                    )
                finally:
                    con.close()
                bundle_id = str(uuid4())
                await db.create_bundle(
                    bundle_id=bundle_id,
                    user_id=user_id,
                    folder_id=folder_id,
                    name=name,
                    bundle_type=bundle_type,
                    status=BundleStatus.processing,
                    dataset_metadata={
                        "lineage": "Cut from the GOAT routing network (Overture "
                        "transportation, processed by goat-data)",
                        "license": "ODbL-1.0",
                        "attribution": "© OpenStreetMap contributors, Overture Maps "
                        "Foundation",
                        "distributor_name": "Overture Maps Foundation",
                    },
                )

                imported: List[ImportedLayer] = []
                try:
                    # The import's own ingestion: it drops what a failing layer
                    # created, bounds DuckDB and fills computed columns.
                    imported = await self._ingest_layers(
                        db,
                        source_path="",
                        bundle_type=bundle_type,
                        user_id=user_id,
                        folder_id=folder_id,
                        bundle_id=bundle_id,
                        layers=[
                            ExtractedLayer(
                                role=role,
                                name=spec.role(role).label,
                                layer_type="feature",
                                file_path=path,
                            )
                            for role, path in paths.items()
                        ],
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
                    await db.update_bundle_status(
                        bundle_id=bundle_id, status=BundleStatus.ready
                    )
                except Exception:
                    await self._rollback_bundle(
                        db, user_id=user_id, bundle_id=bundle_id, imported=imported
                    )
                    raise

            if project_id:
                try:
                    await self._add_bundle_to_project(
                        db,
                        project_id=project_id,
                        bundle_id=bundle_id,
                        bundle_type=bundle_type,
                        imported=imported,
                    )
                except Exception as e:  # noqa: BLE001 - the bundle matters more
                    logger.warning(
                        "Street network %s created but not added to project %s: %s",
                        bundle_id,
                        project_id,
                        e,
                    )
            return {
                "bundle_id": bundle_id,
                "bundle_type": bundle_type.value,
                "layers": [layer.model_dump() for layer in imported],
            }
        finally:
            await pool.close()
            self.cleanup()


def main(params: FetchStreetNetworkParams) -> dict:
    """Windmill entry point."""
    from goatlib.tools.base import _get_or_create_event_loop

    runner = FetchStreetNetworkRunner()
    runner.init_from_env()
    return _get_or_create_event_loop().run_until_complete(
        runner.run_extract(
            area=params.area,
            user_id=params.user_id,
            folder_id=params.folder_id,
            result_bundle_name=params.result_bundle_name,
            project_id=params.project_id,
        )
    )
