"""
Windmill tool infrastructure for GOAT.

This module provides the base classes and utilities for creating
Windmill tool scripts that:
- Run goatlib analysis tools
- Ingest results into DuckLake
- Create layer metadata in PostgreSQL
- Optionally link layers to projects

Example usage:
    from goatlib.tools import BaseToolRunner, ToolInputBase, ToolSettings

    class MyToolParams(ToolInputBase):
        my_param: str

    class MyToolRunner(BaseToolRunner[MyToolParams]):
        def process(self, params, temp_dir):
            # Run analysis, return (output_path, metadata)
            ...

    # Windmill entry point
    def main(**kwargs):
        runner = MyToolRunner()
        runner.init_from_env()
        return runner.run(MyToolParams(**kwargs))
"""

from typing import TYPE_CHECKING

# Imported on demand. Eagerly importing every tool here made this package
# unusable from any consumer without goatlib's `full` extra: `core` calls
# promote, which needs only the light `style` helpers, but reaching them
# through this package pulled base -> io -> pyproj and answered 500. The
# tool registry resolves modules through importlib, so nothing depends on
# these imports having run.
if TYPE_CHECKING:
    from goatlib.tools.base import BaseToolRunner, ToolSettings
    from goatlib.tools.buffer import BufferToolParams, BufferToolRunner
    from goatlib.tools.centroid import CentroidToolParams, CentroidToolRunner
    from goatlib.tools.cleanup_temp import (
        CleanupTempLayersOutput,
        CleanupTempLayersParams,
        cleanup_workflow_temp,
    )
    from goatlib.tools.clip import ClipToolParams, ClipToolRunner
    from goatlib.tools.codegen import generate_windmill_script, python_type_to_str
    from goatlib.tools.db import ToolDatabaseService
    from goatlib.tools.difference import DifferenceToolParams, DifferenceToolRunner
    from goatlib.tools.dissolve import DissolveToolParams, DissolveToolRunner
    from goatlib.tools.finalize_layer import (
        FinalizeLayerOutput,
        FinalizeLayerParams,
        FinalizeLayerRunner,
    )
    from goatlib.tools.geocoding import GeocodingToolParams, GeocodingToolRunner
    from goatlib.tools.intersection import (
        IntersectionToolParams,
        IntersectionToolRunner,
    )
    from goatlib.tools.join import JoinToolParams, JoinToolRunner
    from goatlib.tools.layer_delete import LayerDeleteParams, LayerDeleteRunner
    from goatlib.tools.layer_delete_multi import (
        LayerDeleteMultiParams,
        LayerDeleteMultiRunner,
    )
    from goatlib.tools.layer_export import LayerExportParams, LayerExportRunner
    from goatlib.tools.layer_import import LayerImportParams, LayerImportRunner
    from goatlib.tools.merge import MergeToolParams, MergeToolRunner
    from goatlib.tools.origin_destination import (
        OriginDestinationToolParams,
        OriginDestinationToolRunner,
    )
    from goatlib.tools.print_report import PrintReportParams, PrintReportRunner
    from goatlib.tools.project_export import ProjectExportParams, ProjectExportRunner
    from goatlib.tools.project_import import ProjectImportParams, ProjectImportRunner
    from goatlib.tools.registry import TOOL_REGISTRY, ToolDefinition, get_tool
    from goatlib.tools.schemas import (
        LayerInputMixin,
        ToolInputBase,
        ToolOutputBase,
        TwoLayerInputMixin,
    )
    from goatlib.tools.temp_writer import TempLayerMetadata, TempLayerWriter
    from goatlib.tools.union import UnionToolParams, UnionToolRunner

_LAZY: dict[str, str] = {
    "BaseToolRunner": "goatlib.tools.base",
    "BufferToolParams": "goatlib.tools.buffer",
    "BufferToolRunner": "goatlib.tools.buffer",
    "CentroidToolParams": "goatlib.tools.centroid",
    "CentroidToolRunner": "goatlib.tools.centroid",
    "CleanupTempLayersOutput": "goatlib.tools.cleanup_temp",
    "CleanupTempLayersParams": "goatlib.tools.cleanup_temp",
    "ClipToolParams": "goatlib.tools.clip",
    "ClipToolRunner": "goatlib.tools.clip",
    "DifferenceToolParams": "goatlib.tools.difference",
    "DifferenceToolRunner": "goatlib.tools.difference",
    "DissolveToolParams": "goatlib.tools.dissolve",
    "DissolveToolRunner": "goatlib.tools.dissolve",
    "FinalizeLayerOutput": "goatlib.tools.finalize_layer",
    "FinalizeLayerParams": "goatlib.tools.finalize_layer",
    "FinalizeLayerRunner": "goatlib.tools.finalize_layer",
    "GeocodingToolParams": "goatlib.tools.geocoding",
    "GeocodingToolRunner": "goatlib.tools.geocoding",
    "IntersectionToolParams": "goatlib.tools.intersection",
    "IntersectionToolRunner": "goatlib.tools.intersection",
    "JoinToolParams": "goatlib.tools.join",
    "JoinToolRunner": "goatlib.tools.join",
    "LayerDeleteMultiParams": "goatlib.tools.layer_delete_multi",
    "LayerDeleteMultiRunner": "goatlib.tools.layer_delete_multi",
    "LayerDeleteParams": "goatlib.tools.layer_delete",
    "LayerDeleteRunner": "goatlib.tools.layer_delete",
    "LayerExportParams": "goatlib.tools.layer_export",
    "LayerExportRunner": "goatlib.tools.layer_export",
    "LayerImportParams": "goatlib.tools.layer_import",
    "LayerImportRunner": "goatlib.tools.layer_import",
    "LayerInputMixin": "goatlib.tools.schemas",
    "MergeToolParams": "goatlib.tools.merge",
    "MergeToolRunner": "goatlib.tools.merge",
    "OriginDestinationToolParams": "goatlib.tools.origin_destination",
    "OriginDestinationToolRunner": "goatlib.tools.origin_destination",
    "PrintReportParams": "goatlib.tools.print_report",
    "PrintReportRunner": "goatlib.tools.print_report",
    "ProjectExportParams": "goatlib.tools.project_export",
    "ProjectExportRunner": "goatlib.tools.project_export",
    "ProjectImportParams": "goatlib.tools.project_import",
    "ProjectImportRunner": "goatlib.tools.project_import",
    "TOOL_REGISTRY": "goatlib.tools.registry",
    "TempLayerMetadata": "goatlib.tools.temp_writer",
    "TempLayerWriter": "goatlib.tools.temp_writer",
    "ToolDatabaseService": "goatlib.tools.db",
    "ToolDefinition": "goatlib.tools.registry",
    "ToolInputBase": "goatlib.tools.schemas",
    "ToolOutputBase": "goatlib.tools.schemas",
    "ToolSettings": "goatlib.tools.base",
    "TwoLayerInputMixin": "goatlib.tools.schemas",
    "UnionToolParams": "goatlib.tools.union",
    "UnionToolRunner": "goatlib.tools.union",
    "cleanup_workflow_temp": "goatlib.tools.cleanup_temp",
    "generate_windmill_script": "goatlib.tools.codegen",
    "get_tool": "goatlib.tools.registry",
    "python_type_to_str": "goatlib.tools.codegen",
}


def __getattr__(name: str) -> object:
    """Resolve an export to its module the first time it is asked for."""
    module_path = _LAZY.get(name)
    if module_path is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

    import importlib

    value = getattr(importlib.import_module(module_path), name)
    globals()[name] = value  # subsequent lookups skip __getattr__
    return value


def __dir__() -> list[str]:
    return sorted(__all__)


__all__ = [
    "BaseToolRunner",
    "ToolSettings",
    "ToolDatabaseService",
    "ToolInputBase",
    "ToolOutputBase",
    "LayerInputMixin",
    "TwoLayerInputMixin",
    "TempLayerWriter",
    "TempLayerMetadata",
    "FinalizeLayerParams",
    "FinalizeLayerOutput",
    "FinalizeLayerRunner",
    "CleanupTempLayersParams",
    "CleanupTempLayersOutput",
    "cleanup_workflow_temp",
    "BufferToolParams",
    "BufferToolRunner",
    "CentroidToolParams",
    "CentroidToolRunner",
    "ClipToolParams",
    "ClipToolRunner",
    "IntersectionToolParams",
    "IntersectionToolRunner",
    "JoinToolParams",
    "JoinToolRunner",
    "DissolveToolParams",
    "DissolveToolRunner",
    "GeocodingToolParams",
    "GeocodingToolRunner",
    "UnionToolParams",
    "UnionToolRunner",
    "DifferenceToolParams",
    "DifferenceToolRunner",
    "OriginDestinationToolParams",
    "OriginDestinationToolRunner",
    "LayerImportParams",
    "LayerImportRunner",
    "MergeToolParams",
    "MergeToolRunner",
    "LayerDeleteParams",
    "LayerDeleteRunner",
    "LayerDeleteMultiParams",
    "LayerDeleteMultiRunner",
    "LayerExportParams",
    "LayerExportRunner",
    "PrintReportParams",
    "PrintReportRunner",
    "ProjectExportParams",
    "ProjectExportRunner",
    "ProjectImportParams",
    "ProjectImportRunner",
    "generate_windmill_script",
    "python_type_to_str",
    "TOOL_REGISTRY",
    "ToolDefinition",
    "get_tool",
]
