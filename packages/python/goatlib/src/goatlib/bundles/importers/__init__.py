"""Dataset-bundle importers. Importing this package registers all importers.

One subpackage per bundle type family: ``pt_network`` for transit feeds,
``street_network`` for road networks. A family holds one module per source format
(``gtfs``, ``overture``), so adding a format is a new module plus one import here.
"""

from goatlib.bundles.importers.base import (
    BundleImporter,
    ExtractedLayer,
    ValidationResult,
    get_importer,
    infer_bundle_type,
    register_importer,
)
from goatlib.bundles.importers.pt_network import GtfsImporter
from goatlib.bundles.importers.street_network import OvertureImporter
from goatlib.bundles.importers.xplan.importer import XPlanImporter

__all__ = [
    "BundleImporter",
    "ExtractedLayer",
    "GtfsImporter",
    "OvertureImporter",
    "XPlanImporter",
    "ValidationResult",
    "get_importer",
    "infer_bundle_type",
    "register_importer",
]
