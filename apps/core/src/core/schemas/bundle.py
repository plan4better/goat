import logging
from datetime import datetime
from typing import Any, Dict, Literal, Optional
from uuid import UUID

from goatlib.models.bundle import BundleArtifactState
from pydantic import BaseModel, Field, field_validator

from core.db.models.bundle_type import BundleTypeName
from core.schemas.layer import ThumbnailUrlMixin
from core.schemas.metadata import DatasetProvenance

logger = logging.getLogger(__name__)


class BundleBase(BaseModel):
    name: str = Field(..., description="Bundle name", max_length=255)
    description: str | None = Field(
        None, description="Bundle description", max_length=2000
    )
    bundle_type: BundleTypeName = Field(..., description="Bundle type")


class BundleCreate(BundleBase):
    folder_id: UUID = Field(..., description="Folder the bundle lives in")
    user_id: UUID | None = Field(None, description="Bundle owner ID")


class BundleUpdate(BaseModel):
    name: str | None = Field(None, description="Bundle name", max_length=255)
    description: str | None = Field(
        None, description="Bundle description", max_length=2000
    )
    folder_id: UUID | None = Field(
        None,
        description="Move the bundle (and its member layers) to this folder",
    )
    dataset_metadata: DatasetProvenance | None = Field(
        None,
        description=(
            "Dataset-level provenance. Merged into what is stored, so a field "
            "left out keeps its value rather than being cleared"
        ),
    )


class DatasetContentTile(ThumbnailUrlMixin):
    """One item in the dataset content grid — a layer OR a bundle,
    projected to a single uniform shape so the mixed listing returns one
    consistent DTO for both (rather than rich layer DTOs next to bundle tiles).

    ``content_type`` discriminates the two; ``type`` is the layer type or the
    bundle type, so the tile chip resolves the same way for both.
    """

    content_type: Literal["layer", "bundle"]
    id: UUID
    name: Optional[str] = None
    folder_id: Optional[UUID] = None
    type: Optional[str] = Field(None, description="Layer type or bundle type")
    feature_layer_geometry_type: Optional[str] = Field(
        None, description="Geometry type for feature layers (null for bundles)"
    )
    data_type: Optional[str] = None
    bundle_type: Optional[str] = None
    status: Optional[str] = None
    description: Optional[str] = None
    thumbnail_url: Optional[str] = Field(None, validate_default=True)
    owned_by: Dict[str, Any] | None = None
    shared_with: Dict[str, Any] | None = None
    tags: Optional[list[str]] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class BundleArtifactSummary(BaseModel):
    """A derived artifact of a bundle, as reported on a read.

    Reported per artifact rather than collapsed to one status: a GTFS bundle has
    both a timetable and a stop-to-street linkage, and "one of them failed" is
    not useful without saying which. The storage path is deliberately absent —
    it is an internal location, not something a client needs.
    """

    kind: str
    # Where the artifact stands. Derived here from `build_status`, the revisions
    # and whether the file is there — not stored — so a client never has to know
    # the rule and cannot disagree with the tools that decide whether they may
    # route on it.
    state: BundleArtifactState
    # What the last build attempt did — the raw fact `state` is derived from.
    # Reported as written, not as an enum: the column is text, and
    # `artifact_state` deliberately treats a value this release does not know
    # as unroutable rather than an error. Validating it here would undo that
    # and fail the whole read instead.
    build_status: str
    # The bundle's layers_revision this artifact was built from, so a client can
    # tell how far behind it is. Null for an artifact that never built.
    revision: int | None = None
    size: int | None = None
    #: What the build recorded about its own output — a PT timetable's service
    #: window, which is what bounds a date offered against it. Free-form by
    #: design (see the column), so reported as stored and typed as a document:
    #: validating a shape nothing writes deliberately would let one artifact
    #: fail a whole listing.
    properties: Dict[str, Any] | None = None
    updated_at: Optional[datetime] = None

    @field_validator("properties", mode="before")
    @classmethod
    def _drop_non_document_properties(cls, value: Any) -> Any:
        """A stored value that is not a document reads as none recorded.

        The same rule as `BundleRead.dataset_metadata`, for the same reason: a
        free-form column can hold anything, a listing builds one DTO per
        artifact, and one malformed row must not fail every artifact the caller
        asked for.
        """
        if value is not None and not isinstance(value, dict):
            logger.warning("Ignoring non-document artifact properties: %r", value)
            return None
        return value


class BundleRead(BundleBase, ThumbnailUrlMixin):
    # Unbounded, unlike the create/update schemas: the columns are `text`, so a
    # row longer than the input bound can exist, and refusing to serialise it
    # would fail every bundle in the listing rather than just its own. See
    # tests/unit/test_read_models_accept_stored_data.py.
    name: str = Field(..., description="Bundle name")
    description: str | None = Field(None, description="Bundle description")
    # The stored value, not the enum — as `BundleByLayerResponse` already
    # reports it. The column is plain text with no reference table behind it,
    # so a row can hold a type this release does not know (written by a newer
    # one, or left by a rollback); validating it here would take every bundle
    # listing down rather than just that row.
    bundle_type: str = Field(..., description="Bundle type")
    id: UUID = Field(..., description="Bundle ID")
    user_id: UUID | None = Field(
        None, description="Bundle owner ID; None if the owning user was deleted"
    )
    folder_id: UUID = Field(..., description="Folder the bundle lives in")
    status: str = Field("ready", description="Processing lifecycle status")
    # The mixin turns the stored value into a presigned URL and falls back to the
    # standard dataset image when unset (same logic as layers). validate_default
    # lets the mixin's before-validator run even when no value is supplied.
    thumbnail_url: Optional[str] = Field(
        None,
        description=(
            "Thumbnail: one member layer's, since a bundle renders nothing of "
            "its own — the role the type's spec names"
        ),
        validate_default=True,
    )
    # The stored document as it is, not `DatasetProvenance`. That model is the
    # *input* contract — `max_length`, `EmailStr`, an ISO-country rule — and
    # the column has no equivalent, so validating a read against it lets one
    # row fail every bundle in the listing. `BundleUpdate` still validates
    # everything authored through the API; shape is documented there.
    dataset_metadata: Dict[str, Any] | None = Field(
        None,
        description=(
            "Dataset-level provenance as stored: the DatasetProvenance fields "
            "the importer and the owner have filled in, sparsely"
        ),
    )

    @field_validator("dataset_metadata", mode="before")
    @classmethod
    def _drop_non_document_provenance(cls, value: Any) -> Any:
        """Report a stored value that is not a document as no provenance.

        The one shape the field cannot carry. Values inside it are passed
        through untouched — a listing builds one DTO per bundle, so anything
        stricter would let a single malformed row fail every bundle the caller
        asked for. A bundle whose provenance reads oddly is recoverable; a
        listing that 500s is not.
        """
        if value is not None and not isinstance(value, dict):
            if isinstance(value, DatasetProvenance):
                return value.model_dump()
            logger.warning("Ignoring non-document dataset_metadata: %r", value)
            return None
        return value

    owned_by: Dict[str, Any] | None = Field(
        None, description="Owner info ({id, firstname, lastname, avatar}) for tiles"
    )
    artifacts_from_layers: bool = Field(
        False,
        description=(
            "Whether the artifacts are built from the member layers rather "
            "than from the uploaded source. Gates the operations that need to "
            "produce artifacts from layers — a filtered copy, an in-place "
            "rebuild — which a GTFS bundle cannot do: its feed is not kept"
        ),
    )
    artifacts: list["BundleArtifactSummary"] = Field(
        default_factory=list,
        description="The bundle's derived artifacts and their build state",
    )
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


# --- Sharing ---------------------------------------------------------------


class BundleShareCreate(BaseModel):
    grantee_type: Literal["team", "organization"]
    grantee_id: UUID
    role: Literal["bundle-viewer", "bundle-editor"]


class BundleGrantResponse(BaseModel):
    grantee_type: str
    grantee_id: UUID
    grantee_name: str
    role: str


class BundleGrantsResponse(BaseModel):
    grants: list[BundleGrantResponse]


# --- Import ----------------------------------------------------------------


class BundleImportRequest(BaseModel):
    s3_key: str = Field(
        ..., description="Object-storage key of the uploaded source (e.g. a gtfs.zip)"
    )
    folder_id: UUID = Field(..., description="Folder to create the bundle in")
    name: str = Field(..., description="Bundle name", max_length=255)
    description: str | None = Field(None, max_length=2000)
    street_network_bundle_id: UUID | None = Field(
        None,
        description="Street network bundle to link as a dependency (PT networks)",
    )
    project_id: UUID | None = Field(
        None,
        description="If uploading from within a project, add the bundle to it",
    )


class BundleImportResponse(BaseModel):
    bundle: "BundleRead"
    job_id: str | None = Field(
        None, description="Windmill job id for the background ingest (poll for status)"
    )


# --- Dependencies ----------------------------------------------------------


class BundleDependencyCreate(BaseModel):
    depends_on_bundle_id: UUID = Field(
        ..., description="The bundle this one depends on (e.g. a street network)"
    )
    dependency_kind: str = Field(
        ..., description="Dependency slot from the type spec (e.g. 'street_network')"
    )


class BundleDependencyResponse(BaseModel):
    dependency_kind: str
    depends_on_bundle_id: UUID
    depends_on_name: str
    depends_on_type: str


# --- Membership ------------------------------------------------------------


class BundleMemberCreate(BaseModel):
    layer_id: UUID = Field(..., description="Layer to add to the bundle")
    role: str | None = Field(
        None, description="Role the layer plays in the bundle (a spec role key)"
    )


class BundleMemberResponse(BaseModel):
    layer_id: UUID
    role: str | None
    # Denormalised from the layer so a member listing renders without one
    # follow-up request per member.
    name: Optional[str] = None
    type: Optional[str] = None
    feature_layer_geometry_type: Optional[str] = None
    # Resolved from the type's spec, so the client never has to know the rules.
    editable: bool = False


class BundleByLayerResponse(BaseModel):
    """The bundle a layer belongs to, and whether that member is editable."""

    bundle_id: UUID
    bundle_type: str
    role: str | None
    editable: bool = False
    # An editor sends this back as base_revision, so a save can be refused if
    # someone else changed the network in the meantime.
    layers_revision: int = 0


request_examples = {
    "create": {
        "name": "Munich GTFS feed",
        "bundle_type": "pt_network_gtfs",
        "folder_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    },
}
