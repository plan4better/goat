"""Artifact builders for dataset bundles.

Spec-driven, mirroring importers: which artifacts a bundle type produces comes
from ``goatlib.models.bundle.SPECS``; how to build each is per-type here.

Boundary: a builder turns the bundle source into artifact file(s) on disk. The
runner stores them (S3 + ``bundle_artifact`` rows). Builders never touch the DB.
"""

from abc import ABC
from typing import Any, Dict, List, Protocol, Tuple

from pydantic import BaseModel, model_validator

from goatlib.models.bundle import (
    BundleArtifactKind,
    BundleArtifactState,
    BundleTypeName,
    get_spec,
)


class ArtifactSource(Protocol):
    """The one capability the ``fetch_*`` helpers need of a tool runner.

    A Protocol rather than ``BaseToolRunner`` keeps the dependency pointing from
    tools to bundles: ``bundles.runner`` already imports ``tools``, so importing
    it back would close a cycle.
    """

    def resolve_bundle_artifact(
        self, bundle_id: str, kind: str
    ) -> Tuple[str | None, BundleArtifactState | None]: ...

    def resolve_bundle_dependency(self, bundle_id: str, kind: str) -> str | None: ...


class ArtifactBuilderUnavailableError(Exception):
    """Raised when a builder's toolchain isn't available in this environment
    (e.g. the routing extension hasn't been rebuilt with the timetable-build
    binding yet). The import still completes; the artifact is skipped."""


class ArtifactBuildFailedError(Exception):
    """One or more of a bundle type's artifacts could not be built.

    Raised after every artifact's outcome has been recorded, so the bundle says
    which kind failed and why — and then the job fails. A bundle missing an
    artifact its type declares is not a usable bundle: the tools that need it
    would refuse, and an import that reported success would leave someone to
    discover that for themselves.
    """


class BuiltArtifact(BaseModel):
    """The outcome for one artifact kind: a file to store, or why there is none.

    A builder that produces several kinds reports each separately, so a build
    that fails can say which kind failed and why rather than only that
    something did. The build still fails as a whole — see
    ``ArtifactBuildFailedError``.
    """

    kind: BundleArtifactKind
    local_path: str | None = None
    size: int = 0
    #: What this build knows about its output that nobody can derive later —
    #: a timetable's service window, say, since the feed is not kept. Stored
    #: verbatim on the artifact row; see ``BundleArtifact.properties``.
    properties: Dict[str, Any] = {}
    #: Why this kind was not produced, in words a user can act on. Recorded
    #: against the artifact so the bundle reports it as failed rather than as
    #: never attempted.
    error: str | None = None

    @model_validator(mode="after")
    def _built_or_failed(self) -> "BuiltArtifact":
        if bool(self.local_path) == bool(self.error):
            raise ValueError(
                "a BuiltArtifact carries either a local_path or an error, "
                "never both and never neither"
            )
        return self


class ArtifactBuilder(ABC):
    """Builds a bundle type's derived artifacts."""

    bundle_type: BundleTypeName
    # The artifact kinds this builder currently produces (may be a subset of the
    # type spec's declared artifacts while others are still unimplemented).
    produces: tuple[BundleArtifactKind, ...] = ()

    @property
    def builds_from_layers(self) -> bool:
        """True when the build reads the bundle's member layers instead of the
        uploaded source.

        Read from the type spec rather than declared per builder: the API has to
        answer the same question (to know whether a filtered copy is possible)
        and cannot import a builder to ask — one of them pulls in DuckDB and the
        routing extension.
        """
        return get_spec(self.bundle_type).artifacts_build_from_layers

    def build(
        self,
        *,
        source_path: str,
        workdir: str,
        dependencies: Dict[str, Any] | None = None,
        options: Dict[str, Any] | None = None,
    ) -> List[BuiltArtifact]:
        """Build the artifacts from ``source_path`` into ``workdir``.

        ``dependencies`` carries what the bundle's *other* bundles contribute,
        keyed by dependency kind as the spec names it — a GTFS bundle's
        ``street_network`` entry holds the edge and node paths its linkage is
        computed against. Resolved by the caller, which owns the database and
        the artifact store; absent when a dependency is unlinked or its own
        artifact is not usable.

        ``options`` is per-build tuning a caller may pass through (which
        access/egress modes to compute, say). A builder ignores what it does
        not recognise.

        Raises ``ArtifactBuilderUnavailableError`` if the toolchain is missing.
        """
        raise NotImplementedError(
            f"{type(self).__name__} does not build from a source file"
        )

    def build_from_layers(
        self, *, layer_paths: Dict[str, str], workdir: str
    ) -> List[BuiltArtifact]:
        """Build the artifacts from member layers, keyed by spec role."""
        raise NotImplementedError(
            f"{type(self).__name__} does not build from member layers"
        )
