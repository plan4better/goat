"""Dataset-bundle artifact builders. Importing this registers all builders."""

from goatlib.bundles.artifacts.base import (
    ArtifactBuilder,
    ArtifactBuilderUnavailableError,
    ArtifactBuildFailedError,
    BuiltArtifact,
)
from goatlib.bundles.artifacts.gtfs import GtfsArtifactBuilder
from goatlib.bundles.artifacts.registry import (
    get_artifact_builder,
    register_artifact_builder,
)
from goatlib.bundles.artifacts.storage import (
    artifact_relative_path,
    delete_bundle_artifacts,
    resolve_artifact,
    store_artifact,
)
from goatlib.bundles.artifacts.street_network import StreetNetworkArtifactBuilder

register_artifact_builder(GtfsArtifactBuilder())
register_artifact_builder(StreetNetworkArtifactBuilder())

__all__ = [
    "ArtifactBuildFailedError",
    "ArtifactBuilder",
    "ArtifactBuilderUnavailableError",
    "BuiltArtifact",
    "GtfsArtifactBuilder",
    "StreetNetworkArtifactBuilder",
    "artifact_relative_path",
    "delete_bundle_artifacts",
    "get_artifact_builder",
    "resolve_artifact",
    "store_artifact",
    "register_artifact_builder",
]
