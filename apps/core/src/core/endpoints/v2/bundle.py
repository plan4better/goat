import contextlib
import logging
import os
import tempfile
from collections import defaultdict
from collections.abc import Sequence
from typing import Any, List, Literal
from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query, status
from fastapi.concurrency import run_in_threadpool
from goatlib.bundles.importers import infer_bundle_type
from goatlib.models.bundle import (
    BundleArtifactState,
    BundleStatus,
    BundleTypeName,
    artifact_state,
    artifacts_from_layers,
    get_spec,
)
from pydantic import UUID4
from sqlalchemy import and_, or_, select, text
from sqlalchemy import delete as sql_delete
from sqlalchemy import update as sql_update

from core.core import authz
from core.core.authz import Action
from core.core.config import settings
from core.crud.crud_bundle import bundle as crud_bundle
from core.crud.crud_bundle import member_thumbnails
from core.db.models._link_model import (
    BundleDependencyLink,
    BundleLayerLink,
    ResourceGrant,
    UserTeamLink,
)
from core.db.models.bundle import Bundle
from core.db.models.bundle_artifact import BundleArtifact
from core.db.models.folder import Folder
from core.db.models.layer import Layer
from core.db.models.organization import Organization
from core.db.models.project import Project
from core.db.models.role import Role
from core.db.models.team import Team
from core.db.models.user import User
from core.db.session import AsyncSession
from core.deps.auth import auth, auth_z
from core.endpoints.deps import get_db, get_user_id
from core.schemas.bundle import (
    BundleArtifactSummary,
    BundleByLayerResponse,
    BundleCreate,
    BundleDependencyCreate,
    BundleDependencyResponse,
    BundleGrantResponse,
    BundleGrantsResponse,
    BundleImportRequest,
    BundleImportResponse,
    BundleMemberCreate,
    BundleMemberResponse,
    BundleRead,
    BundleShareCreate,
    BundleUpdate,
    request_examples,
)
from core.services.processes import dispatch_never_started, execute_process
from core.services.s3 import s3_service

logger = logging.getLogger(__name__)

RESOURCE_TYPE = "bundle"

router = APIRouter()


### Access helpers


async def _user_teams_and_org(
    async_session: AsyncSession, user_id: UUID
) -> tuple[list[UUID], UUID | None]:
    team_ids = list(
        (
            await async_session.execute(
                select(UserTeamLink.team_id).where(UserTeamLink.user_id == user_id)
            )
        ).scalars()
    )
    org_id = (
        await async_session.execute(
            select(User.organization_id).where(User.id == user_id)
        )
    ).scalar_one_or_none()
    return team_ids, org_id


def _grant_conditions(team_ids: list[UUID], org_id: UUID | None) -> list:
    """resource_grant match conditions for the caller's teams / organization."""
    conds = []
    if team_ids:
        conds.append(
            and_(
                ResourceGrant.grantee_type == "team",
                ResourceGrant.grantee_id.in_(team_ids),
            )
        )
    if org_id is not None:
        conds.append(
            and_(
                ResourceGrant.grantee_type == "organization",
                ResourceGrant.grantee_id == org_id,
            )
        )
    return conds


BundleAccess = Literal["read", "write", "owner"]


async def authorize_bundle(
    async_session: AsyncSession,
    bundle_id: UUID,
    user_id: UUID,
    level: BundleAccess,
) -> Bundle:
    """Single authorization gate for a bundle.

    Resolves the caller's effective access via ``customer.effective_role``
    (the caller's role in the bundle's space, the bundle's own grants, and its
    folder's grants — folder grants cascade to the bundle), then checks it
    against the required level:

    * ``read``  — viewer or above (view/list),
    * ``write`` — editor or above (update, move, members, dependencies, share),
    * ``owner`` — rank 3 (delete — a whole-bundle cascade). Only the owner or
      admin of the space the bundle lives in holds rank 3: a grant is capped
      at editor, and owning the bundle's folder gives editor-equivalent access
      to its contents (per ``effective_role``'s folder-inheritance rule),
      never owner. The row's ``user_id`` ("created by") confers nothing, so a
      member who created a bundle in a team space cannot delete it — the same
      rule ``authz.require(..., "delete")`` applies to a layer, folder,
      project or template.

    Returns the bundle, or raises 404 (no access — existence not leaked) /
    403 (has read access but not the required level).
    """
    bundle = await async_session.get(Bundle, bundle_id)
    if bundle is None or bundle.deleted_at is not None:
        # A trashed bundle behaves as gone for every normal route — the
        # trash listing is the only place it still surfaces.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Bundle not found"
        )
    if level == "owner":
        if not await authz.can(
            async_session, RESOURCE_TYPE, bundle_id, user_id, "delete"
        ):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only a space owner or admin can perform this action",
            )
        return bundle

    action: Action = "write" if level == "write" else "read"
    if await authz.can(async_session, RESOURCE_TYPE, bundle_id, user_id, action):
        return bundle
    if action == "write" and await authz.can(
        async_session, RESOURCE_TYPE, bundle_id, user_id, "read"
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have edit access to this bundle",
        )
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND, detail="Bundle not found"
    )


async def _bundle_reachable_via_project(
    async_session: AsyncSession, bundle_id: UUID, user_id: UUID
) -> bool:
    """Whether a member layer of the bundle sits in a project the caller can
    reach through any effective-role path (owner, direct grant, team,
    organization, or folder grant).

    Project sharing mints no bundle or folder grant, yet someone working in
    such a project handles the member layers daily — they get read-only
    visibility of the bundle (membership, roles, revision), or the client
    would route their edits down the per-feature path, which refuses bundle
    members. Writes stay behind geoapi's layer-edit rule, and everything
    beyond reading stays behind ``authorize_bundle``.
    """
    result = await async_session.execute(
        text(
            f"""
            SELECT EXISTS (
                SELECT 1
                FROM {settings.SCHEMA}.layer_project lp
                JOIN {settings.SCHEMA}.bundle_layer bl ON bl.layer_id = lp.layer_id
                JOIN {settings.SCHEMA}.bundle b ON b.id = bl.bundle_id
                WHERE bl.bundle_id = :bundle_id
                  AND b.deleted_at IS NULL
                  AND {settings.SCHEMA}.effective_role('project', lp.project_id, :user_id) IS NOT NULL
            )
            """
        ),
        {"bundle_id": str(bundle_id), "user_id": str(user_id)},
    )
    return bool(result.scalar())


async def _authorize_bundle_read_or_project_reach(
    async_session: AsyncSession, bundle_id: UUID, user_id: UUID
) -> Bundle:
    """Grant-based read, falling back to shared-project reachability.

    A trashed bundle must behave as gone through this fallback too:
    ``authorize_bundle`` already 404s on it, but the project-reachability
    fallback below doesn't look at ``deleted_at`` on its own — re-check it
    here before falling back, so a shared-project editor can't still resolve
    a trashed bundle's membership/roles through this path.
    """
    try:
        return await authorize_bundle(async_session, bundle_id, user_id, "read")
    except HTTPException:
        bundle = await async_session.get(Bundle, bundle_id)
        if bundle is None or bundle.deleted_at is not None:
            raise
        if not await _bundle_reachable_via_project(async_session, bundle_id, user_id):
            raise
        return bundle


### Bundle CRUD endpoints


async def _artifacts_by_bundle(
    async_session: AsyncSession, bundle_ids: Sequence[UUID]
) -> defaultdict[UUID, list[BundleArtifact]]:
    """Every bundle's artifact rows, grouped, in one query.

    A listing reports artifacts too, so fetching them per bundle would be one
    round trip per row. Total by construction — a bundle with no artifacts
    indexes to an empty list — so callers do not special-case it.
    """
    grouped: defaultdict[UUID, list[BundleArtifact]] = defaultdict(list)
    if not bundle_ids:
        return grouped
    rows = (
        (
            await async_session.execute(
                select(BundleArtifact)
                .where(BundleArtifact.bundle_id.in_(bundle_ids))
                .order_by(BundleArtifact.bundle_id, BundleArtifact.kind)
            )
        )
        .scalars()
        .all()
    )
    for artifact in rows:
        grouped[artifact.bundle_id].append(artifact)
    return grouped


def _from_layers(bundle_type: str) -> bool:
    """Whether a type's artifacts are built from its member layers.

    What makes both a filtered copy and an in-place rebuild possible: a type
    built from the uploaded source has nothing to build from once the import's
    temporary download is gone. Unknown types answer False — a read must not
    fail on a type the database holds and this release does not know.
    """
    if bundle_type not in {t.value for t in BundleTypeName}:
        return False
    return artifacts_from_layers(bundle_type)


async def _bundles_with_stale_dependencies(
    async_session: AsyncSession, bundle_ids: Sequence[UUID]
) -> set[UUID]:
    """Bundles whose artifacts were built from a dependency that has moved on.

    Each dependency row records the revision the dependent's artifacts were
    built from; a bundle is stale when that no longer matches the dependency's
    current ``layers_revision`` — it was edited, or the link was re-pointed at
    another bundle, which leaves the revision unrecorded. One query for the
    whole listing, like the artifacts themselves.
    """
    if not bundle_ids:
        return set()
    rows = (
        await async_session.execute(
            select(BundleDependencyLink.bundle_id)
            .join(Bundle, Bundle.id == BundleDependencyLink.depends_on_bundle_id)
            .where(
                BundleDependencyLink.bundle_id.in_(bundle_ids),
                BundleDependencyLink.built_revision.is_distinct_from(
                    Bundle.layers_revision
                ),
            )
            .distinct()
        )
    ).all()
    return {row[0] for row in rows}


def _bundle_read(
    bundle: Bundle,
    *,
    artifacts: Sequence[BundleArtifact] = (),
    dependencies_current: bool = True,
    thumbnail_url: str | None = None,
    owned_by: dict[str, Any] | None = None,
) -> BundleRead:
    """A bundle as the API reports it.

    The single place a ``BundleRead`` is built, so every route answers with the
    same shape: a bundle carries its artifacts and their derived state whether
    it was just created, listed, read or updated. Artifacts are passed in
    rather than lazy-loaded — an async session cannot resolve a relationship on
    access, and a listing needs them fetched in bulk anyway.
    """
    fields = bundle.model_dump()
    if thumbnail_url:
        # A member's thumbnail in place of the bundle's own, which is only ever
        # the generic placeholder — see `member_thumbnails`.
        fields["thumbnail_url"] = thumbnail_url
    return BundleRead(
        **fields,
        owned_by=owned_by,
        artifacts_from_layers=_from_layers(bundle.bundle_type),
        artifacts=[
            BundleArtifactSummary(
                # Loaded values may be the enum or the raw string, depending on
                # whether SQLModel coerced the column.
                kind=getattr(a.kind, "value", a.kind),
                build_status=getattr(a.build_status, "value", a.build_status),
                state=artifact_state(
                    getattr(a.build_status, "value", a.build_status),
                    a.revision,
                    bundle.layers_revision,
                    a.storage_path,
                    dependencies_current,
                ),
                revision=a.revision,
                size=a.size,
                properties=a.properties,
                updated_at=a.updated_at,
            )
            for a in artifacts
        ],
    )


@router.post(
    "",
    summary="Create a new bundle",
    response_model=BundleRead,
    status_code=201,
    dependencies=[Depends(auth_z)],
)
async def create_bundle(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    bundle_in: BundleCreate = Body(..., example=request_examples["create"]),
) -> BundleRead:
    """Create a new bundle in a folder the caller owns."""
    folder = await async_session.get(Folder, bundle_in.folder_id)
    if folder is None or folder.user_id != user_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found"
        )
    bundle_in.user_id = user_id
    created = await crud_bundle.create(async_session, obj_in=bundle_in)
    # No artifacts yet: nothing has been imported into it.
    return _bundle_read(created)


@router.post(
    "/import",
    summary="Import an uploaded file (e.g. gtfs.zip) as a bundle",
    response_model=BundleImportResponse,
    status_code=202,
    dependencies=[Depends(auth_z)],
)
async def import_bundle(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    access_token: str = Depends(auth),
    payload: BundleImportRequest = Body(...),
) -> BundleImportResponse:
    """Route an uploaded file to the right bundle importer (``*gtfs*.zip`` → GTFS
    PT network, ``*overture*.zip`` or a zip holding segments/connectors
    GeoParquet → street network), validate it synchronously against the type's
    spec, create the bundle (status=processing) and optional street dependency,
    then ingest the member layers in the background."""
    # Uploads are presigned into the caller's own prefix (datasets
    # request-upload); an import may only consume keys from there — the key is
    # otherwise an arbitrary read of the shared bucket.
    upload_prefix = (
        s3_service.build_s3_key(
            settings.S3_BUCKET_PATH, "users", str(user_id), "imports", "uploads"
        )
        + "/"
    )
    if not payload.s3_key.startswith(upload_prefix):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="s3_key must reference a file you uploaded",
        )
    filename = payload.s3_key.rsplit("/", 1)[-1]

    # The target folder must exist, be live, and be writable by the caller —
    # the bundle then takes THAT folder's own space (personal, or a team/org
    # space the caller may write to), never just the caller's personal space
    # regardless of where folder_id actually points.
    folder = await async_session.get(Folder, payload.folder_id)
    if folder is None or folder.deleted_at is not None or folder.space_id is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found"
        )
    if not await authz.can(
        async_session, "folder", payload.folder_id, user_id, "write"
    ):
        # Read access but not write: confirm the folder is there but refuse
        # it (403). No access at all: behave as if it weren't there (404)
        # rather than confirming a totally foreign folder's existence to a
        # caller with no relationship to it.
        if await authz.can(async_session, "folder", payload.folder_id, user_id, "read"):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Not allowed to write this folder",
            )
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found"
        )

    # When adding to a project, the caller must own it (guards the project_id
    # that the background job later uses to attach the bundle).
    if payload.project_id is not None:
        project = await async_session.get(Project, payload.project_id)
        if project is None or project.user_id != user_id:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Project not found"
            )

    # Downloaded only to infer the type: the name alone can't always decide it
    # — GTFS feeds and Overture extracts are both zips — so importers get to
    # sniff the contents as a fallback. The type is needed here because it is
    # written on the bundle row this request creates. Validating the payload is
    # the import job's job: a refusal raised here would be reported to nobody,
    # while a failed job is, and the heavier checks need a geospatial stack this
    # service does not install.
    tmp_path = tempfile.NamedTemporaryFile(suffix=".zip", delete=False).name
    try:
        # boto3 and the zip sniffing are synchronous; off the event loop so a
        # large upload doesn't stall every other request on this worker.
        await run_in_threadpool(
            s3_service.download_file, settings.S3_BUCKET_NAME, payload.s3_key, tmp_path
        )
        bundle_type = await run_in_threadpool(infer_bundle_type, filename, tmp_path)
        if bundle_type is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"'{filename}' is not a recognised bundle upload "
                    "(expected a *gtfs*.zip, or a zip containing Overture "
                    "segments and connectors GeoParquet)"
                ),
            )
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
    # Validate the optional street-network dependency before creating anything.
    link_street = False
    if payload.street_network_bundle_id is not None:
        dep_spec = get_spec(bundle_type).dependency("street_network")
        if dep_spec is not None:
            target = await authorize_bundle(
                async_session, payload.street_network_bundle_id, user_id, "read"
            )
            if str(target.bundle_type) != dep_spec.bundle_type.value:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=(
                        "street_network_bundle_id must reference a "
                        f"'{dep_spec.bundle_type.value}' bundle"
                    ),
                )
            link_street = True

    # Create the bundle shell (processing) + optional dependency, synchronously.
    space_id = folder.space_id
    bundle = Bundle(
        user_id=user_id,
        folder_id=payload.folder_id,
        space_id=space_id,
        name=payload.name,
        description=payload.description,
        bundle_type=bundle_type,
        status=BundleStatus.processing,
    )
    async_session.add(bundle)
    await async_session.flush()
    if link_street:
        async_session.add(
            BundleDependencyLink(
                bundle_id=bundle.id,
                depends_on_bundle_id=payload.street_network_bundle_id,
                dependency_kind="street_network",
            )
        )
    await async_session.commit()
    await async_session.refresh(bundle)

    # Trigger the ingest as a Windmill job via the processes service. The job
    # ingests the member layers and flips the bundle status to ready/failed.
    try:
        job_id = await execute_process(
            process_id="bundle_import",
            inputs={
                "bundle_id": str(bundle.id),
                "s3_key": payload.s3_key,
                "bundle_type": bundle_type.value,
                "folder_id": str(payload.folder_id),
                # When uploading from within a project, add the bundle to it once
                # its member layers are ingested.
                **(
                    {"project_id": str(payload.project_id)}
                    if payload.project_id
                    else {}
                ),
            },
            access_token=access_token,
        )
    except Exception as error:
        # Remove the committed shell only when the dispatch cannot have taken
        # effect: an import that never started cannot be resumed, and a bundle
        # stuck at "processing" offers no action that would fix it. A timeout or
        # a 502 says nothing about whether the job was accepted, and an ingest
        # that is already running needs this row — it is the foreign key its
        # member layers point at — so an ambiguous failure leaves the bundle
        # alone and the job carries the outcome.
        if dispatch_never_started(error):
            # Read before the cleanup: a session that fails leaves the instance
            # in a state where reloading an attribute fails too.
            bundle_id = bundle.id
            try:
                await async_session.delete(bundle)
                await async_session.commit()
            except Exception:
                # A session that is itself broken must not replace the reason
                # the dispatch failed with an error about the cleanup.
                with contextlib.suppress(Exception):
                    await async_session.rollback()
                logger.exception(
                    "Could not remove the shell of bundle %s after its import "
                    "failed to start",
                    bundle_id,
                )
        raise

    # The ingest has only just been queued, so the bundle has no artifacts to
    # report; the client polls the job and re-reads it.
    return BundleImportResponse(bundle=_bundle_read(bundle), job_id=job_id)


@router.get(
    "",
    summary="List the caller's bundles",
    response_model=List[BundleRead],
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def list_bundles(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    bundle_type: str | None = Query(
        None, description="Only bundles of this type (e.g. pt_network_gtfs)"
    ),
    artifact_kind: str | None = Query(
        None,
        description="Only bundles that have a ready artifact of this kind "
        "(e.g. pt_network_graph for routable PT bundles)",
    ),
) -> List[BundleRead]:
    """List bundles the caller owns or has been shared."""
    team_ids, org_id = await _user_teams_and_org(async_session, user_id)
    conds = _grant_conditions(team_ids, org_id)
    # Join the owner so tiles can show an avatar (same "owned_by" shape as layers).
    stmt = (
        select(
            Bundle,
            User.id,
            User.firstname,
            User.lastname,
            User.avatar,
        )
        .outerjoin(
            # LEFT, not INNER: `user_id` is "created by" and is cleared when
            # the account is removed, and an inner join would drop an
            # offboarded member's bundles from the listing silently rather
            # than returning them with an empty `owned_by` — same as the
            # content listing.
            User,
            User.id == Bundle.user_id,
        )
        .where(Bundle.deleted_at.is_(None))
    )
    if conds:
        shared_ids = select(ResourceGrant.resource_id).where(
            ResourceGrant.resource_type == RESOURCE_TYPE, or_(*conds)
        )
        stmt = stmt.where(or_(Bundle.user_id == user_id, Bundle.id.in_(shared_ids)))
    else:
        stmt = stmt.where(Bundle.user_id == user_id)
    if bundle_type:
        stmt = stmt.where(Bundle.bundle_type == bundle_type)
    stmt = stmt.order_by(Bundle.updated_at.desc())
    rows = (await async_session.execute(stmt)).all()
    # One query for every listed bundle's artifacts, whether or not they are
    # also being filtered on.
    artifacts = await _artifacts_by_bundle(
        async_session, [bundle.id for bundle, *_ in rows]
    )
    stale = await _bundles_with_stale_dependencies(
        async_session, [bundle.id for bundle, *_ in rows]
    )
    if artifact_kind:
        # Restrict to bundles with a ready artifact of the requested kind (e.g.
        # only PT bundles whose routing graph is built). Readiness is asked of
        # `artifact_state` over the rows already loaded, not respelled as SQL:
        # a second copy of the rule cannot see whether the file is there, cannot
        # treat a build_status from another release as failed, and cannot know
        # whether the dependencies it was built from have moved on — so the
        # listing and the read DTO would disagree about the same bundle.
        rows = [
            row
            for row in rows
            if any(
                getattr(a.kind, "value", a.kind) == artifact_kind
                and artifact_state(
                    a.build_status,
                    a.revision,
                    row[0].layers_revision,
                    a.storage_path,
                    row[0].id not in stale,
                )
                is BundleArtifactState.ready
                for a in artifacts[row[0].id]
            )
        ]
    listed_ids = [bundle.id for bundle, *_ in rows]
    thumbnails = await member_thumbnails(async_session, listed_ids)
    return [
        _bundle_read(
            bundle,
            artifacts=artifacts[bundle.id],
            dependencies_current=bundle.id not in stale,
            thumbnail_url=thumbnails.get(bundle.id),
            # None when the row has no owner left (the creator's account was
            # removed), matching `build_shared_with_object`'s `owned_by`.
            owned_by=(
                {
                    "id": uid,
                    "firstname": firstname,
                    "lastname": lastname,
                    "avatar": avatar,
                }
                if uid is not None
                else None
            ),
        )
        for bundle, uid, firstname, lastname, avatar in rows
    ]


@router.get(
    "/{bundle_id}",
    summary="Retrieve a bundle by its ID",
    response_model=BundleRead,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def read_bundle(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    bundle_id: UUID4 = Path(..., description="The bundle ID"),
) -> BundleRead:
    """Retrieve a bundle the caller owns or has been shared."""
    bundle = await authorize_bundle(async_session, bundle_id, user_id, "read")
    artifacts = await _artifacts_by_bundle(async_session, [bundle_id])
    stale = await _bundles_with_stale_dependencies(async_session, [bundle_id])
    thumbnails = await member_thumbnails(async_session, [bundle_id])
    return _bundle_read(
        bundle,
        artifacts=artifacts[bundle_id],
        dependencies_current=bundle_id not in stale,
        thumbnail_url=thumbnails.get(bundle_id),
    )


@router.put(
    "/{bundle_id}",
    summary="Update a bundle",
    response_model=BundleRead,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def update_bundle(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    bundle_id: UUID4 = Path(..., description="The bundle ID"),
    bundle_in: BundleUpdate = Body(...),
) -> BundleRead:
    """Update a bundle (owner or editor). Moving the bundle to a new
    folder (``folder_id``) moves its member layers along with it, so the bundle
    stays self-contained."""
    bundle = await authorize_bundle(async_session, bundle_id, user_id, "write")

    # A move must target a folder of the BUNDLE OWNER: listings scope bundles
    # to the owner's folders, so a shared editor moving it into one of their
    # own folders would hide it from its owner — and deleting that folder
    # would cascade the owner's bundle away.
    if bundle_in.folder_id is not None:
        folder = await async_session.get(Folder, bundle_in.folder_id)
        if folder is None or folder.user_id != bundle.user_id:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found"
            )

    updated = await crud_bundle.update(async_session, db_obj=bundle, obj_in=bundle_in)

    # Keep member layers in the bundle's folder (they are hidden, but folder
    # location still drives folder-scoped access checks).
    if bundle_in.folder_id is not None:
        await async_session.execute(
            sql_update(Layer)
            .where(
                Layer.id.in_(
                    select(BundleLayerLink.layer_id).where(
                        BundleLayerLink.bundle_id == bundle_id
                    )
                )
            )
            .values(folder_id=bundle_in.folder_id)
        )
        await async_session.commit()

    artifacts = await _artifacts_by_bundle(async_session, [bundle_id])
    stale = await _bundles_with_stale_dependencies(async_session, [bundle_id])
    thumbnails = await member_thumbnails(async_session, [bundle_id])
    return _bundle_read(
        updated,
        artifacts=artifacts[bundle_id],
        dependencies_current=bundle_id not in stale,
        thumbnail_url=thumbnails.get(bundle_id),
    )


@router.delete(
    "/{bundle_id}",
    summary="Delete a bundle and all its member layers",
    status_code=204,
    dependencies=[Depends(auth_z)],
)
async def delete_bundle(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    bundle_id: UUID4 = Path(..., description="The bundle ID"),
) -> None:
    """Delete a bundle (owner only). Soft delete: the bundle and every
    member layer get `deleted_at` — rows and DuckLake data stay until the
    trash retention window expires (the purge task)."""
    await authorize_bundle(async_session, bundle_id, user_id, "owner")

    # Block deletion while another bundle depends on this one (deleting would
    # break the dependent).
    dependent = (
        await async_session.execute(
            select(BundleDependencyLink.bundle_id)
            .where(BundleDependencyLink.depends_on_bundle_id == bundle_id)
            .limit(1)
        )
    ).first()
    if dependent is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "Cannot delete a bundle that another bundle "
                "depends on. "
                "Remove the dependency first."
            ),
        )

    await crud_bundle.delete(
        async_session,
        id=bundle_id,
        user_id=user_id,
    )
    return


### Bundle membership endpoints
#
# Membership lives in the bundle_layer link table: a layer belongs to
# at most one bundle, tagged with the role it plays (a spec role key from
# goatlib). Roles are validated against the bundle type's spec.


def role_is_editable(bundle_type: str, role: str | None) -> bool:
    """Whether the spec marks this role's member layer editable."""
    if not role:
        return False
    spec_role = get_spec(bundle_type).role(role)
    return bool(spec_role and spec_role.editable)


@router.get(
    "/by-layer/{layer_id}",
    summary="The bundle a layer belongs to, if any",
    response_model=BundleByLayerResponse,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def read_bundle_by_layer(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    layer_id: UUID4 = Path(..., description="The layer"),
) -> BundleByLayerResponse:
    """Resolve a layer to its bundle, role and editability."""
    link = (
        await async_session.execute(
            select(BundleLayerLink).where(BundleLayerLink.layer_id == layer_id)
        )
    ).scalar_one_or_none()
    if link is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Layer is not part of a bundle",
        )
    # Project-reach fallback: a shared-project editor holds no bundle grant,
    # yet the client needs this answer to route saves to the bundle endpoint
    # instead of the per-feature one.
    bundle = await _authorize_bundle_read_or_project_reach(
        async_session, link.bundle_id, user_id
    )
    return BundleByLayerResponse(
        bundle_id=link.bundle_id,
        bundle_type=bundle.bundle_type,
        role=link.role,
        editable=role_is_editable(bundle.bundle_type, link.role),
        layers_revision=bundle.layers_revision,
    )


@router.get(
    "/{bundle_id}/layers",
    summary="List the layers in a bundle with their roles",
    response_model=List[BundleMemberResponse],
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def list_bundle_layers(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    bundle_id: UUID4 = Path(..., description="The bundle"),
) -> List[BundleMemberResponse]:
    """List member layers and their roles (owner or shared)."""
    # Same project-reach fallback as ``read_bundle_by_layer``: the web
    # resolves member editability through this listing.
    bundle = await _authorize_bundle_read_or_project_reach(
        async_session, bundle_id, user_id
    )
    rows = (
        await async_session.execute(
            select(BundleLayerLink, Layer)
            .join(Layer, Layer.id == BundleLayerLink.layer_id)
            .where(BundleLayerLink.bundle_id == bundle_id)
            .order_by(BundleLayerLink.id)
        )
    ).all()
    return [
        BundleMemberResponse(
            layer_id=link.layer_id,
            role=link.role,
            name=layer.name,
            # Loaded values may be the enum or the raw string, depending on
            # whether SQLModel coerced the column.
            type=getattr(layer.type, "value", layer.type),
            feature_layer_geometry_type=getattr(
                layer.feature_layer_geometry_type,
                "value",
                layer.feature_layer_geometry_type,
            ),
            editable=role_is_editable(bundle.bundle_type, link.role),
        )
        for link, layer in rows
    ]


@router.post(
    "/{bundle_id}/layers",
    summary="Add a layer to a bundle (or re-tag its role)",
    response_model=BundleMemberResponse,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def add_bundle_layer(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    bundle_id: UUID4 = Path(..., description="The bundle"),
    payload: BundleMemberCreate = Body(...),
) -> BundleMemberResponse:
    """Add a layer to the bundle with a role, or update the role if the layer
    is already a member. Owner only."""
    bundle = await authorize_bundle(async_session, bundle_id, user_id, "write")

    # Role must be a valid role key for this bundle type's spec.
    if payload.role is not None:
        spec = get_spec(bundle.bundle_type)
        if payload.role not in spec.role_keys():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"Invalid role '{payload.role}' for bundle type "
                    f"'{spec.type.value}'. "
                    f"Allowed roles: {list(spec.role_keys())}"
                ),
            )

    # The layer must be owned by the caller.
    layer = await async_session.get(Layer, payload.layer_id)
    if layer is None or layer.user_id != user_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Layer not found"
        )

    existing = (
        await async_session.execute(
            select(BundleLayerLink).where(BundleLayerLink.layer_id == payload.layer_id)
        )
    ).scalar_one_or_none()
    if existing is not None and existing.bundle_id != bundle_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Layer already belongs to another bundle",
        )

    # A role can be filled by only one layer within the bundle.
    if payload.role is not None:
        role_taken = (
            await async_session.execute(
                select(BundleLayerLink.id).where(
                    BundleLayerLink.bundle_id == bundle_id,
                    BundleLayerLink.role == payload.role,
                    BundleLayerLink.layer_id != payload.layer_id,
                )
            )
        ).first()
        if role_taken is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Role '{payload.role}' is already assigned in this bundle",
            )

    if existing is not None:
        existing.role = payload.role
        link = existing
    else:
        link = BundleLayerLink(
            bundle_id=bundle_id,
            layer_id=payload.layer_id,
            role=payload.role,
        )
        async_session.add(link)
    await async_session.commit()
    return BundleMemberResponse(layer_id=link.layer_id, role=link.role)


@router.delete(
    "/{bundle_id}/layers/{layer_id}",
    summary="Remove a layer from a bundle",
    status_code=204,
    dependencies=[Depends(auth_z)],
)
async def remove_bundle_layer(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    bundle_id: UUID4 = Path(..., description="The bundle"),
    layer_id: UUID4 = Path(..., description="The member layer to remove"),
) -> None:
    """Remove a layer from the bundle (the layer itself is not deleted; it
    becomes a standalone layer again). Owner only."""
    await authorize_bundle(async_session, bundle_id, user_id, "write")
    result = await async_session.execute(
        sql_delete(BundleLayerLink).where(
            and_(
                BundleLayerLink.bundle_id == bundle_id,
                BundleLayerLink.layer_id == layer_id,
            )
        )
    )
    await async_session.commit()
    if result.rowcount == 0:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Layer is not a member of this bundle",
        )


### Bundle dependency endpoints
#
# A bundle can depend on another (e.g. a GTFS bundle on the street network used
# to build its routable graph / stop-to-street mapping). The allowed dependency
# kinds and required target type come from the type's goatlib spec.


@router.get(
    "/{bundle_id}/dependencies",
    summary="List a bundle's dependencies",
    response_model=List[BundleDependencyResponse],
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def list_bundle_dependencies(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    bundle_id: UUID4 = Path(..., description="The bundle"),
) -> List[BundleDependencyResponse]:
    """List the bundles this one depends on (owner or shared)."""
    await authorize_bundle(async_session, bundle_id, user_id, "read")
    rows = (
        await async_session.execute(
            select(BundleDependencyLink, Bundle)
            .join(
                Bundle,
                Bundle.id == BundleDependencyLink.depends_on_bundle_id,
            )
            .where(BundleDependencyLink.bundle_id == bundle_id)
        )
    ).all()
    return [
        BundleDependencyResponse(
            dependency_kind=link.dependency_kind,
            depends_on_bundle_id=link.depends_on_bundle_id,
            depends_on_name=dep.name,
            depends_on_type=str(dep.bundle_type),
        )
        for link, dep in rows
    ]


@router.post(
    "/{bundle_id}/dependencies",
    summary="Link a bundle to a dependency (e.g. a street network)",
    response_model=BundleDependencyResponse,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def add_bundle_dependency(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    bundle_id: UUID4 = Path(..., description="The dependent bundle"),
    payload: BundleDependencyCreate = Body(...),
) -> BundleDependencyResponse:
    """Link a bundle to a dependency. The dependency kind must be declared by
    the bundle type's spec, and the target bundle must be of the required
    type. Owner only; upserts the link for the given kind."""
    bundle = await authorize_bundle(async_session, bundle_id, user_id, "write")

    dep_spec = get_spec(bundle.bundle_type).dependency(payload.dependency_kind)
    if dep_spec is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"'{payload.dependency_kind}' is not a valid dependency for "
                f"bundle type '{get_spec(bundle.bundle_type).type.value}'"
            ),
        )

    if payload.depends_on_bundle_id == bundle_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A bundle cannot depend on itself",
        )

    # Target must be accessible to the caller and of the required type.
    target = await authorize_bundle(
        async_session, payload.depends_on_bundle_id, user_id, "read"
    )
    if str(target.bundle_type) != dep_spec.bundle_type.value:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Dependency '{payload.dependency_kind}' requires a bundle of type "
                f"'{dep_spec.bundle_type.value}', but the target is "
                f"'{target.bundle_type}'"
            ),
        )

    # Upsert: one dependency per (bundle, kind).
    await async_session.execute(
        sql_delete(BundleDependencyLink).where(
            and_(
                BundleDependencyLink.bundle_id == bundle_id,
                BundleDependencyLink.dependency_kind == payload.dependency_kind,
            )
        )
    )
    async_session.add(
        BundleDependencyLink(
            bundle_id=bundle_id,
            depends_on_bundle_id=payload.depends_on_bundle_id,
            dependency_kind=payload.dependency_kind,
        )
    )
    await async_session.commit()
    return BundleDependencyResponse(
        dependency_kind=payload.dependency_kind,
        depends_on_bundle_id=payload.depends_on_bundle_id,
        depends_on_name=target.name,
        depends_on_type=str(target.bundle_type),
    )


@router.delete(
    "/{bundle_id}/dependencies/{dependency_kind}",
    summary="Remove a bundle dependency",
    status_code=204,
    dependencies=[Depends(auth_z)],
)
async def delete_bundle_dependency(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    bundle_id: UUID4 = Path(..., description="The dependent bundle"),
    dependency_kind: str = Path(..., description="The dependency slot to remove"),
) -> None:
    """Remove a dependency link. Owner only."""
    await authorize_bundle(async_session, bundle_id, user_id, "write")
    result = await async_session.execute(
        sql_delete(BundleDependencyLink).where(
            and_(
                BundleDependencyLink.bundle_id == bundle_id,
                BundleDependencyLink.dependency_kind == dependency_kind,
            )
        )
    )
    await async_session.commit()
    if result.rowcount == 0:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Dependency not found"
        )


### Bundle sharing endpoints
#
# A bundle is the sole sharing unit for its member layers: sharing a
# bundle with a team/organisation grants access to every member layer (derived
# at authorization time in check_layer.sql). Member layers cannot be shared
# individually (enforced in the layer share endpoint).


@router.post(
    "/{bundle_id}/share",
    summary="Share a bundle with a team or organization",
    response_model=BundleGrantsResponse,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def share_bundle(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    bundle_id: UUID4 = Path(..., description="The bundle to share"),
    payload: BundleShareCreate = Body(...),
) -> BundleGrantsResponse:
    """Share a bundle with a team or organization. Owner or editor."""
    await authorize_bundle(async_session, bundle_id, user_id, "write")

    role = (
        await async_session.execute(select(Role).where(Role.name == payload.role))
    ).scalar_one_or_none()
    if role is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown role: {payload.role}",
        )

    # Upsert: replace any existing grant for this grantee.
    await async_session.execute(
        sql_delete(ResourceGrant).where(
            and_(
                ResourceGrant.resource_type == RESOURCE_TYPE,
                ResourceGrant.resource_id == bundle_id,
                ResourceGrant.grantee_type == payload.grantee_type,
                ResourceGrant.grantee_id == payload.grantee_id,
            )
        )
    )
    async_session.add(
        ResourceGrant(
            resource_type=RESOURCE_TYPE,
            resource_id=bundle_id,
            grantee_type=payload.grantee_type,
            grantee_id=payload.grantee_id,
            role_id=role.id,
            granted_by=user_id,
        )
    )
    await async_session.commit()
    return await _get_grants_response(async_session, bundle_id)


@router.get(
    "/{bundle_id}/share",
    summary="List current grants for a bundle",
    response_model=BundleGrantsResponse,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def get_bundle_grants(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    bundle_id: UUID4 = Path(..., description="The bundle"),
) -> BundleGrantsResponse:
    """List the grants on a bundle. Owner or editor."""
    await authorize_bundle(async_session, bundle_id, user_id, "write")
    return await _get_grants_response(async_session, bundle_id)


@router.delete(
    "/{bundle_id}/share/{grantee_type}/{grantee_id}",
    summary="Remove a grant from a bundle",
    status_code=204,
    dependencies=[Depends(auth_z)],
)
async def delete_bundle_grant(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    bundle_id: UUID4 = Path(..., description="The bundle"),
    grantee_type: str = Path(..., description="team or organization"),
    grantee_id: UUID4 = Path(..., description="The team or organization ID"),
) -> None:
    """Remove a specific grant from a bundle. Owner or editor."""
    await authorize_bundle(async_session, bundle_id, user_id, "write")
    result = await async_session.execute(
        sql_delete(ResourceGrant).where(
            and_(
                ResourceGrant.resource_type == RESOURCE_TYPE,
                ResourceGrant.resource_id == bundle_id,
                ResourceGrant.grantee_type == grantee_type,
                ResourceGrant.grantee_id == grantee_id,
            )
        )
    )
    await async_session.commit()
    if result.rowcount == 0:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Grant not found"
        )


### Helpers


async def _get_grants_response(
    async_session: AsyncSession, bundle_id: UUID
) -> BundleGrantsResponse:
    """Fetch all grants for a bundle, enriched with grantee display names."""
    rows = (
        await async_session.execute(
            select(ResourceGrant, Role)
            .join(Role, Role.id == ResourceGrant.role_id)
            .where(
                ResourceGrant.resource_type == RESOURCE_TYPE,
                ResourceGrant.resource_id == bundle_id,
            )
        )
    ).all()

    enriched: list[BundleGrantResponse] = []
    for grant, role in rows:
        name = str(grant.grantee_id)
        if grant.grantee_type == "team":
            team = await async_session.get(Team, grant.grantee_id)
            if team:
                name = team.name
        elif grant.grantee_type == "organization":
            org = await async_session.get(Organization, grant.grantee_id)
            if org:
                name = org.name
        enriched.append(
            BundleGrantResponse(
                grantee_type=grant.grantee_type,
                grantee_id=grant.grantee_id,
                grantee_name=name,
                role=role.name,
            )
        )
    return BundleGrantsResponse(grants=enriched)
