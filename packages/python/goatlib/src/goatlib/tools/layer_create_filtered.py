"""LayerCreateFiltered Tool - Create a new layer from a filtered subset.

This tool creates a fully independent layer by materializing the filtered
rows of an existing layer into a new DuckLake table with its own PMTiles.

Usage:
    from goatlib.tools.layer_create_filtered import LayerCreateFilteredParams, main

    result = main(LayerCreateFilteredParams(
        user_id="...",
        project_id="...",
        source_layer_id="...",
        cql_filter={"op": "and", "args": [...]},
        result_layer_name="Buildings (filtered)",
    ))
"""

import logging
from pathlib import Path
from typing import Any, Self

from pydantic import ConfigDict, Field

from goatlib.analysis.schemas.ui import (
    SECTION_INPUT,
    SECTION_OUTPUT,
    SECTION_RESULT,
    ui_field,
    ui_sections,
)
from goatlib.models.io import DatasetMetadata
from goatlib.tools.base import (
    BaseToolRunner,
    _get_or_create_event_loop,
    drops_unrecorded_tables,
)
from goatlib.tools.schemas import ToolInputBase

logger = logging.getLogger(__name__)


class LayerCreateFilteredParams(ToolInputBase):
    """Parameters for creating a layer from a filtered subset."""

    model_config = ConfigDict(
        json_schema_extra=ui_sections(
            SECTION_INPUT,
            SECTION_RESULT,
            SECTION_OUTPUT,
        )
    )

    source_layer_id: str = Field(
        ...,
        description="ID of the source layer to filter",
        json_schema_extra=ui_field(
            section="input",
            field_order=1,
            hidden=True,
        ),
    )
    cql_filter: dict[str, Any] = Field(
        ...,
        description="CQL2-JSON filter to apply to the source layer",
        json_schema_extra=ui_field(
            section="input",
            field_order=2,
            hidden=True,
        ),
    )
    source_properties: dict[str, Any] | None = Field(
        None,
        description="Style properties to copy from the source layer",
        json_schema_extra=ui_field(
            section="input",
            field_order=3,
            hidden=True,
        ),
    )


class LayerCreateFilteredToolRunner(BaseToolRunner["LayerCreateFilteredParams"]):
    """Runner for creating a layer from a filtered subset.

    Reads the source layer with the CQL filter applied, writes the filtered
    rows to a parquet file, then lets BaseToolRunner handle DuckLake ingestion,
    PMTiles generation, and DB record creation.
    """

    tool_class = "layer_create_filtered"
    output_geometry_type: str | None = None  # Dynamic based on source layer
    output_geometry_follows_input = True
    default_output_name = "Filtered Layer"

    def process(
        self: Self,
        params: LayerCreateFilteredParams,
        temp_dir: Path,
    ) -> tuple[Path, DatasetMetadata]:
        """Export the filtered source layer as parquet."""
        # Export the source layer with the CQL filter applied
        input_path = self.export_layer_to_parquet(
            layer_id=params.source_layer_id,
            user_id=params.user_id,
            cql_filter=params.cql_filter,
        )

        # The exported parquet IS our output — no further analysis needed
        output_path = Path(input_path)

        metadata = DatasetMetadata(
            path=str(output_path),
            source_type="vector",
        )
        return output_path, metadata

    def get_layer_properties(
        self: Self,
        params: LayerCreateFilteredParams,
        metadata: DatasetMetadata,
        table_info: Any = None,
        parquet_path: Any = None,
    ) -> dict[str, Any] | None:
        """Return the source layer's style properties."""
        return params.source_properties

    def get_feature_layer_type(
        self: Self,
        params: LayerCreateFilteredParams,
    ) -> str:
        """Mark as standard (not tool output) since this is user data."""
        return "standard"

    @drops_unrecorded_tables
    def run(self: Self, params: LayerCreateFilteredParams) -> dict[str, Any]:
        """Create the copy, then carry the source's per-column metadata over."""
        result = super().run(params)
        self._copy_field_config(params, result)
        return result

    def _copy_field_config(
        self: Self, params: LayerCreateFilteredParams, result: dict[str, Any]
    ) -> None:
        """Give the copy the source layer's ``field_config``.

        The copy is the same kind of layer as its source, so a column's
        vocabulary, default, formatting, computed formula and generated kind
        still apply to it — a serial number keeps counting, from the source's
        high-water mark, and a UUID column keeps filling itself, rather than
        both turning into plain columns users would have to type into.

        The same rule ``bundle_create_filtered`` follows for a bundle's member
        layers. Never in temp mode, where there is no layer row; a failure is
        logged, not raised, because the copy and its data are real by now.
        """
        if getattr(params, "temp_mode", False):
            return
        layer_id = result.get("layer_id")
        if not layer_id:
            return
        try:
            _get_or_create_event_loop().run_until_complete(
                self._persist_source_field_config(params.source_layer_id, str(layer_id))
            )
        except Exception as e:
            logger.warning(
                "Could not copy field_config from %s to %s: %s",
                params.source_layer_id,
                layer_id,
                e,
            )

    async def _persist_source_field_config(
        self: Self, source_layer_id: str, layer_id: str
    ) -> None:
        """Open a pool, copy the blob, and close it again — `run` closed its own."""
        await self._init_db_service()
        try:
            if self.db_service is None:
                return
            source = await self.db_service.get_layer_info(source_layer_id)
            field_config = (source or {}).get("field_config")
            if field_config:
                await self.db_service.set_layer_field_config(layer_id, field_config)
                # And the serial high-water marks, so the copy never hands out
                # a number the source handed out and deleted since.
                if any(
                    isinstance(e, dict) and e.get("kind") == "serial"
                    for e in field_config.values()
                ):
                    await self.db_service.copy_layer_serial_counters(
                        source_layer_id, layer_id
                    )
        finally:
            await self._close_db_service()


def main(params: LayerCreateFilteredParams) -> dict[str, Any]:
    """Windmill entry point for LayerCreateFiltered.

    Args:
        params: Validated LayerCreateFilteredParams

    Returns:
        ToolOutputBase as dict
    """
    runner = LayerCreateFilteredToolRunner()
    runner.init_from_env()
    try:
        return runner.run(params)
    finally:
        runner.cleanup()
