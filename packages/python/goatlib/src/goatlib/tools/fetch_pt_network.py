"""Create a GTFS bundle from GOAT's own public transport network, for an area.

The cut itself is in `goatlib.io.fetch.pt_network`; this stores it as a
pt_network_gtfs bundle, which builds its timetable and its access and egress
like an uploaded feed, against the default street network.
"""

import logging
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional

import duckdb
from pydantic import ConfigDict, Field

from goatlib.analysis.schemas.ui import (
    SECTION_INPUT,
    SECTION_OUTPUT,
    ui_field,
    ui_sections,
)
from goatlib.bundles.importers.base import bound_duckdb
from goatlib.bundles.importers.pt_network.store import read_store, tables_dir
from goatlib.bundles.runner import BundleImportRunner
from goatlib.io.fetch.pt_network import export_pt_network
from goatlib.models.bundle import BundleTypeName
from goatlib.models.io import DatasetMetadata
from goatlib.tools.authz import require_can
from goatlib.tools.db import ToolDatabaseService
from goatlib.tools.schemas import ToolInputBase

logger = logging.getLogger(__name__)


class FetchPtNetworkParams(ToolInputBase):
    """Where to cut the public transport network, and where the bundle goes."""

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


class FetchPtNetworkRunner(BundleImportRunner):
    """Cuts the public transport network to an area and stores it as a bundle."""

    def process(self, params: Any, temp_dir: Path) -> "tuple[Path, DatasetMetadata]":
        raise NotImplementedError(
            "FetchPtNetworkRunner builds a bundle through run_extract()."
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
                    "public transport network has nowhere to go."
                ),
            )
            # Resolved once: the path goes through the base data link, which a
            # sync can switch to another version while the cut runs.
            store = tables_dir(self.settings.pt_network_base_path).resolve()
            info = read_store(store)
            # Cut first: a refused area (too large, no service) leaves nothing behind.
            with tempfile.TemporaryDirectory(prefix="goat_pt_cut_") as workdir:
                # Bounded, spilling into the cut's own folder: a country's stop
                # times are scanned to find the lines.
                con = bound_duckdb(duckdb.connect(), workdir)
                try:
                    layers = export_pt_network(
                        con, area=area, store_dir=str(store), workdir=workdir
                    )
                finally:
                    con.close()
                # What the feed's builder stated about it, and nothing more:
                # GTFS itself states no licence.
                stated = {
                    "lineage": "Cut from the GOAT public transport network"
                    + (f" ({info['lineage']})" if info.get("lineage") else ""),
                    "license": info.get("license"),
                    "attribution": info.get("attribution"),
                }
                return await self.create_bundle_from_layers(
                    db,
                    bundle_type=BundleTypeName.pt_network_gtfs,
                    name=result_bundle_name or "GOAT public transport network",
                    dataset_metadata={k: v for k, v in stated.items() if v},
                    layers=layers,
                    user_id=user_id,
                    folder_id=folder_id,
                    project_id=project_id,
                )
        finally:
            await pool.close()
            self.cleanup()


def main(params: FetchPtNetworkParams) -> dict:
    """Windmill entry point."""
    from goatlib.tools.base import _get_or_create_event_loop

    runner = FetchPtNetworkRunner()
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
