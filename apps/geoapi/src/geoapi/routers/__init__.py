"""Routers package for GeoAPI."""

from geoapi.routers.bundle_edits import router as bundle_edits_router
from geoapi.routers.download import router as download_router
from geoapi.routers.expressions import router as expressions_router
from geoapi.routers.features import router as features_router
from geoapi.routers.features_write import router as features_write_router
from geoapi.routers.metadata import router as metadata_router
from geoapi.routers.rasters import router as rasters_router
from geoapi.routers.tiles import router as tiles_router

__all__ = [
    "bundle_edits_router",
    "tiles_router",
    "features_router",
    "features_write_router",
    "metadata_router",
    "expressions_router",
    "download_router",
    "rasters_router",
]
