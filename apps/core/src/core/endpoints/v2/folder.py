from typing import List, Optional
from uuid import UUID

from fastapi import (
    APIRouter,
    Body,
    Depends,
    HTTPException,
    Path,
    Query,
    status,
)
from pydantic import UUID4
from sqlalchemy import and_, func, or_, select, text
from sqlalchemy import delete as sql_delete
from sqlalchemy.exc import IntegrityError

from core.core import authz
from core.core.config import settings
from core.core.content import create_query_accessible_folders
from core.crud.crud_folder import folder as crud_folder
from core.crud.crud_share import share as crud_share
from core.crud.crud_space import space as crud_space
from core.db.models._link_model import ResourceGrant, UserTeamLink
from core.db.models.folder import Folder
from core.db.models.organization import Organization
from core.db.models.role import Role
from core.db.models.team import Team
from core.db.models.user import User
from core.db.session import AsyncSession
from core.deps.auth import auth_z
from core.endpoints.deps import ensure_home_folder, get_db, get_user_id
from core.schemas.common import OrderEnum
from core.schemas.folder import (
    FolderCreate,
    FolderGrantResponse,
    FolderGrantsResponse,
    FolderRead,
    FolderShareCreate,
    FolderUpdate,
)
from core.schemas.folder import (
    request_examples as folder_request_examples,
)

router = APIRouter()

# A team/organisation space's membership rank as a folder role (D5/D8: the
# space owns its content, membership is the access). Mirrors
# `customer.space_rank`: 3 = space owner/admin, 2 = member of an editor-default
# space, 1 = member of a viewer-default space. This is the space's *default*,
# which is what decides where a folder is shared from; what the caller actually
# holds on a given folder comes from `customer.effective_role`, since a
# Restricted folder withholds the default.
_RANK_TO_FOLDER_ROLE: dict[int, str] = {
    3: "folder-owner",
    2: "folder-editor",
    1: "folder-viewer",
}

# Which of two role names wins when a folder is reachable both through its
# space and through an explicit grant — the stronger one, so a grant may raise
# a member's role but never lower it.
_FOLDER_ROLE_STRENGTH: dict[str, int] = {
    "folder-owner": 3,
    "folder-editor": 2,
    "folder-viewer": 1,
}


def _folder_name_conflict_or_reraise(e: IntegrityError) -> Exception:
    """Map a folder-name unique-index violation (root or same-parent) to a
    clear 409; any other IntegrityError propagates unchanged so it still
    reaches the app-wide handler in main.py."""
    err_detail = str(e.orig).lower() if e.orig else str(e).lower()
    if "uq_folder_root_name" in err_detail or "uq_folder_child_name" in err_detail:
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A folder with this name already exists here",
        )
    return e


### Folder endpoints
@router.post(
    "",
    summary="Create a new folder",
    response_model=FolderRead,
    status_code=201,
    dependencies=[Depends(auth_z)],
)
async def create_folder(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    folder_in: FolderCreate = Body(..., examples=[folder_request_examples["create"]]),
) -> FolderRead:
    """Create a new folder."""
    # Count already existing folders for the user
    folder_cnt = (
        await async_session.execute(
            select(func.count(Folder.id)).filter(Folder.user_id == user_id)
        )
    ).scalar()

    if folder_cnt is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to fetch folder count",
        )

    # Check if the user has already reached the maximum number of folders
    if folder_cnt >= settings.MAX_FOLDER_COUNT:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"The maximum number of folders ({settings.MAX_FOLDER_COUNT}) has been reached.",
        )

    folder_in.user_id = user_id
    if folder_in.parent_id is not None:
        await authz.require(
            async_session, "folder", folder_in.parent_id, user_id, "write"
        )
        parent = await async_session.get(Folder, folder_in.parent_id)
        if parent is None or parent.space_id is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found"
            )
        folder_in.space_id = parent.space_id
        await crud_folder.assert_valid_parent(
            async_session,
            folder_id=None,
            parent_id=folder_in.parent_id,
            space_id=parent.space_id,
        )
    elif folder_in.space_id is not None:
        # A root folder in a team/organisation space: allowed for a member
        # with write rank on it (`space_rank >= 2`), who becomes the folder's
        # creator while the space stays its owner (D5).
        rank = (
            await async_session.execute(
                text(f"SELECT {settings.SCHEMA}.space_rank(:s, :u)"),
                {"s": folder_in.space_id, "u": user_id},
            )
        ).scalar()
        if int(rank or 0) < 2:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Not allowed to create a folder in this space",
            )
    else:
        folder_in.space_id = (
            await crud_space.ensure_personal(async_session, user_id)
        ).id

    try:
        created = await crud_folder.create(async_session, obj_in=folder_in)
    except IntegrityError as e:
        await async_session.rollback()
        raise _folder_name_conflict_or_reraise(e) from e
    assert created.id is not None
    depth = await crud_folder.depth(async_session, created.id)
    return FolderRead(**created.model_dump(), depth=depth)


@router.get(
    "/{folder_id}",
    summary="Retrieve a folder by its ID",
    response_model=FolderRead,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def read_folder(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    folder_id: UUID4 = Path(
        ...,
        description="The ID of the folder to get",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
) -> FolderRead:
    """Retrieve a folder by its ID."""
    folder = await crud_folder.get_by_multi_keys(
        async_session, keys={"id": folder_id, "user_id": user_id}
    )

    if len(folder) == 0 or folder[0].deleted_at is not None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found"
        )

    assert folder[0].id is not None
    depth = await crud_folder.depth(async_session, folder[0].id)
    return FolderRead(**folder[0].model_dump(), depth=depth)


@router.get(
    "",
    summary="Retrieve a list of folders",
    response_model=List[FolderRead],
    response_model_exclude_none=True,
    status_code=200,
    dependencies=[Depends(auth_z), Depends(ensure_home_folder)],
)
async def read_folders(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    parent_id: Optional[UUID] = Query(
        None,
        description=(
            "List only direct children of this folder. Omit to keep the "
            "historical behaviour of listing every folder (root and nested) "
            "the caller owns or has been granted access to."
        ),
    ),
    search: str = Query(None, description="Searches the name of the folder"),
    order_by: str = Query(
        None,
        description="Specify the column name that should be used to order. You can check the Project model to see which column names exist.",
        examples=["created_at"],
    ),
    order: OrderEnum = Query(
        "descendent",
        description="Specify the order to apply. There are the option ascendent or descendent.",
        examples=["descendent"],
    ),
) -> List[FolderRead]:
    """Retrieve a list of owned and shared folders."""
    # Fetch user's team memberships
    team_ids_result = await async_session.execute(
        select(UserTeamLink.team_id).where(UserTeamLink.user_id == user_id)
    )
    team_ids = [row[0] for row in team_ids_result.all()]

    # Fetch user's organization_id
    user_obj = await async_session.get(User, user_id)
    organization_id: Optional[UUID] = user_obj.organization_id if user_obj else None

    # The team/organisation spaces the caller is a member of, with the rank
    # that membership gives and the space's display name. Candidates come
    # from the caller's own team/organisation ids (indexed columns), so
    # `space_rank` runs once per candidate space rather than per folder row.
    member_spaces: dict[UUID, tuple[int, str]] = {}
    if team_ids or organization_id is not None:
        member_space_rows = (
            await async_session.execute(
                text(
                    f"SELECT s.id, {settings.SCHEMA}.space_rank(s.id, :u) AS rank, "
                    "COALESCE(t.name, o.name) AS name "
                    f"FROM {settings.SCHEMA}.space s "
                    f"LEFT JOIN {settings.SCHEMA}.team t ON t.id = s.team_id "
                    f"LEFT JOIN {settings.SCHEMA}.organization o ON o.id = s.organization_id "
                    "WHERE s.team_id = ANY(CAST(:team_ids AS uuid[])) "
                    "OR s.organization_id = :organization_id"
                ),
                {
                    "u": user_id,
                    "team_ids": team_ids,
                    "organization_id": organization_id,
                },
            )
        ).all()
        member_spaces = {
            row[0]: (int(row[1]), row[2] or str(row[0]))
            for row in member_space_rows
            if int(row[1] or 0) >= 1
        }

    # Build the UNION query of accessible folder IDs
    accessible_cte = create_query_accessible_folders(
        user_id=user_id,
        team_ids=team_ids,
        organization_id=organization_id,
        member_space_ids=list(member_spaces),
    ).cte("accessible_folders")

    # Load full Folder objects for accessible IDs
    folders_query = select(Folder).join(
        accessible_cte, Folder.id == accessible_cte.c.id
    )

    if parent_id is not None:
        folders_query = folders_query.where(Folder.parent_id == parent_id)

    if search:
        folders_query = folders_query.where(Folder.name.ilike(f"%{search}%"))

    result = await async_session.execute(folders_query)
    folders = result.scalars().all()
    depths_by_id = await crud_folder.depths(
        async_session, [f.id for f in folders if f.id is not None]
    )

    # The real role on a folder that lives in a space the caller is a member of.
    # The space's default is not the whole rule — a Restricted folder withholds
    # it (D9) and only a grant of the caller's own re-opens it — so the role
    # comes from `effective_role`, which folds the default, Restricted and every
    # grant on the folder's ancestor chain into one answer. One round trip for
    # all such rows; the same call already runs inside the accessible-folders
    # CTE, so this adds no new rule surface.
    member_space_roles: dict[UUID | None, str] = {}
    member_space_folder_ids = [
        f.id for f in folders if f.id is not None and f.space_id in member_spaces
    ]
    if member_space_folder_ids:
        role_rows = (
            await async_session.execute(
                text(
                    "SELECT f AS folder_id, "
                    f"{settings.SCHEMA}.effective_role('folder', f, :u) AS role "
                    "FROM unnest(CAST(:ids AS uuid[])) AS f"
                ),
                {
                    "ids": [str(fid) for fid in member_space_folder_ids],
                    "u": str(user_id),
                },
            )
        ).all()
        member_space_roles = {
            row.folder_id: f"folder-{row.role}" for row in role_rows if row.role
        }

    owned_ids = [f.id for f in folders if f.user_id == user_id]
    shared_ids = [f.id for f in folders if f.user_id != user_id]

    # Batch: owned-folder grantee_ids (one query for all owned folders)
    owned_grants: dict[UUID, list[UUID]] = {}
    if owned_ids:
        rows = (
            await async_session.execute(
                select(ResourceGrant.resource_id, ResourceGrant.grantee_id).where(
                    ResourceGrant.resource_type == "folder",
                    ResourceGrant.resource_id.in_(owned_ids),
                )
            )
        ).all()
        for resource_id, grantee_id in rows:
            owned_grants.setdefault(resource_id, []).append(grantee_id)

    # Batch: shared-folder grants + roles (one query for all shared folders)
    shared_grant_map: dict[UUID, tuple[ResourceGrant, Role]] = {}
    if shared_ids:
        conditions = []
        if team_ids:
            conditions.append(
                and_(
                    ResourceGrant.grantee_type == "team",
                    ResourceGrant.grantee_id.in_(team_ids),
                )
            )
        if organization_id:
            conditions.append(
                and_(
                    ResourceGrant.grantee_type == "organization",
                    ResourceGrant.grantee_id == organization_id,
                )
            )
        if conditions:
            grant_rows = (
                await async_session.execute(
                    select(ResourceGrant, Role)
                    .join(Role, Role.id == ResourceGrant.role_id)
                    .where(
                        ResourceGrant.resource_type == "folder",
                        ResourceGrant.resource_id.in_(shared_ids),
                        or_(*conditions),
                    )
                )
            ).all()
            # editor beats viewer; among equals keep the first (stable for the UI)
            for grant, role in grant_rows:
                existing = shared_grant_map.get(grant.resource_id)
                if existing is None or _FOLDER_ROLE_STRENGTH.get(
                    role.name, 0
                ) > _FOLDER_ROLE_STRENGTH.get(existing[1].name, 0):
                    shared_grant_map[grant.resource_id] = (grant, role)

    # Batch: team / org display names (one query each, only if needed)
    team_ids_needed = {
        g.grantee_id for g, _ in shared_grant_map.values() if g.grantee_type == "team"
    }
    org_ids_needed = {
        g.grantee_id
        for g, _ in shared_grant_map.values()
        if g.grantee_type == "organization"
    }

    teams_by_id: dict[UUID, str] = {}
    if team_ids_needed:
        team_rows = (
            (
                await async_session.execute(
                    select(Team).where(Team.id.in_(team_ids_needed))
                )
            )
            .scalars()
            .all()
        )
        teams_by_id = {t.id: t.name for t in team_rows}

    orgs_by_id: dict[UUID, str] = {}
    if org_ids_needed:
        org_rows = (
            (
                await async_session.execute(
                    select(Organization).where(Organization.id.in_(org_ids_needed))
                )
            )
            .scalars()
            .all()
        )
        orgs_by_id = {o.id: o.name for o in org_rows}

    # Assemble response
    folder_reads: List[FolderRead] = []
    for f in folders:
        if f.user_id == user_id:
            shared_with_ids = owned_grants.get(f.id) or None
            folder_reads.append(
                FolderRead(
                    **f.model_dump(),
                    depth=depths_by_id.get(f.id, 0),
                    is_owned=True,
                    role="folder-owner",
                    shared_from_name=None,
                    shared_with_ids=shared_with_ids,
                )
            )
        else:
            role_name: Optional[str] = None
            name: Optional[str] = None
            entry = shared_grant_map.get(f.id)
            if entry:
                grant, role = entry
                role_name = role.name
                name = (
                    teams_by_id.get(grant.grantee_id)
                    or orgs_by_id.get(grant.grantee_id)
                    or str(grant.grantee_id)
                )
            # A folder living in a space the caller is a member of: the space
            # is the owner (D5), so its own name is where the folder is shared
            # from whenever its default reaches at least as far as an explicit
            # grant; a stronger grant keeps its own attribution.
            space_entry = member_spaces.get(f.space_id) if f.space_id else None
            if space_entry:
                rank, space_name = space_entry
                space_default = _RANK_TO_FOLDER_ROLE.get(rank)
                if space_default and _FOLDER_ROLE_STRENGTH.get(
                    space_default, 0
                ) >= _FOLDER_ROLE_STRENGTH.get(role_name or "", 0):
                    name = space_name
                # The role, though, is what the caller actually holds, not the
                # space default: the web pickers keep the `folder-editor` rows
                # as create/upload destinations, so over-reporting a Restricted
                # folder the caller may only view turns into a 403 on the next
                # request.
                resolved = member_space_roles.get(f.id)
                if resolved and _FOLDER_ROLE_STRENGTH.get(
                    resolved, 0
                ) >= _FOLDER_ROLE_STRENGTH.get(role_name or "", 0):
                    role_name = resolved
            folder_reads.append(
                FolderRead(
                    **f.model_dump(),
                    depth=depths_by_id.get(f.id, 0),
                    is_owned=False,
                    role=role_name,
                    shared_from_name=name,
                )
            )

    return folder_reads


@router.put(
    "/{folder_id}",
    summary="Update a folder with new data",
    response_model=FolderRead,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def update_folder(
    *,
    async_session: AsyncSession = Depends(get_db),
    folder_id: UUID4 = Path(
        ...,
        description="The ID of the folder to update",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
    user_id: UUID4 = Depends(get_user_id),
    folder_in: FolderUpdate = Body(..., examples=[folder_request_examples["update"]]),
) -> FolderRead:
    """Rename and/or move a folder.

    A move must stay inside the folder's space and cannot exceed nesting
    depth 3 or create a cycle (D4); `folder_depth_check` enforces the same
    rule at the DB level as a backstop. `parent_id` is only touched when the
    request body sets it — sending it as `null` explicitly moves the folder
    to the root of its space, while omitting it leaves the parent unchanged.
    """
    await authz.require(async_session, "folder", folder_id, user_id, "write")
    db_obj = await crud_folder.get(async_session, id=folder_id)
    if db_obj is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found"
        )

    if "parent_id" in folder_in.model_fields_set:
        new_parent_id = folder_in.parent_id
        if new_parent_id is not None:
            # Space/depth/cycle first: a foreign, cross-space parent must
            # come back 400, not 403 — checking write access on it first
            # would leak "it exists but you can't touch it" through the
            # status code for a folder outside the mover's own space.
            assert db_obj.space_id is not None
            await crud_folder.assert_valid_parent(
                async_session,
                folder_id=db_obj.id,
                parent_id=new_parent_id,
                space_id=db_obj.space_id,
            )
            await authz.require(
                async_session, "folder", new_parent_id, user_id, "write"
            )
        db_obj.parent_id = new_parent_id

    if folder_in.name is not None:
        db_obj.name = folder_in.name

    async_session.add(db_obj)
    try:
        await async_session.commit()
    except IntegrityError as e:
        await async_session.rollback()
        raise _folder_name_conflict_or_reraise(e) from e
    await async_session.refresh(db_obj)

    assert db_obj.id is not None
    depth = await crud_folder.depth(async_session, db_obj.id)
    return FolderRead(**db_obj.model_dump(), depth=depth)


@router.delete(
    "/{folder_id}",
    summary="Delete a folder and all its contents",
    response_model=None,
    status_code=204,
    dependencies=[Depends(auth_z)],
)
async def delete_folder(
    *,
    async_session: AsyncSession = Depends(get_db),
    folder_id: UUID4 = Path(
        ...,
        description="The ID of the folder to delete",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
    user_id: UUID4 = Depends(get_user_id),
) -> None:
    """Delete a folder and all its contents (space owner/admin only)."""
    await authz.require(async_session, "folder", folder_id, user_id, "delete")

    await crud_folder.delete(
        async_session,
        id=folder_id,
        user_id=user_id,
    )
    return


### Folder sharing endpoints


@router.post(
    "/{folder_id}/share",
    summary="Share a folder with a team or organization",
    response_model=FolderGrantsResponse,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def share_folder(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    folder_id: UUID4 = Path(..., description="The folder to share"),
    payload: FolderShareCreate = Body(...),
) -> FolderGrantsResponse:
    """Share a folder with a team or organization. Only the folder owner can call this."""
    await authz.require(async_session, "folder", folder_id, user_id, "delete")

    await crud_share.assert_grantees_in_organization(
        async_session,
        granted_by=user_id,
        wanted=[(payload.grantee_type, payload.grantee_id, payload.role)],
    )

    role_result = await async_session.execute(
        select(Role).where(Role.name == payload.role)
    )
    role = role_result.scalar_one_or_none()
    if role is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown role: {payload.role}",
        )

    # Upsert: delete existing grant for this grantee, then insert fresh
    await async_session.execute(
        sql_delete(ResourceGrant).where(
            and_(
                ResourceGrant.resource_type == "folder",
                ResourceGrant.resource_id == folder_id,
                ResourceGrant.grantee_type == payload.grantee_type,
                ResourceGrant.grantee_id == payload.grantee_id,
            )
        )
    )
    grant = ResourceGrant(
        resource_type="folder",
        resource_id=folder_id,
        grantee_type=payload.grantee_type,
        grantee_id=payload.grantee_id,
        role_id=role.id,
        granted_by=user_id,
    )
    async_session.add(grant)
    await async_session.commit()

    return await _get_folder_grants_response(async_session, folder_id)


@router.get(
    "/{folder_id}/share",
    summary="List current grants for a folder",
    response_model=FolderGrantsResponse,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def get_folder_grants(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    folder_id: UUID4 = Path(..., description="The folder whose grants to list"),
) -> FolderGrantsResponse:
    """List current grants for a folder. Only the folder owner can call this."""
    await authz.require(async_session, "folder", folder_id, user_id, "delete")

    return await _get_folder_grants_response(async_session, folder_id)


@router.delete(
    "/{folder_id}/share/{grantee_type}/{grantee_id}",
    summary="Remove a grant from a folder",
    response_model=None,
    status_code=204,
    dependencies=[Depends(auth_z)],
)
async def delete_folder_grant(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    folder_id: UUID4 = Path(..., description="The folder"),
    grantee_type: str = Path(..., description="team or organization"),
    grantee_id: UUID4 = Path(..., description="The team or organization ID"),
) -> None:
    """Remove a specific grant from a folder. Only the folder owner can call this."""
    await authz.require(async_session, "folder", folder_id, user_id, "delete")

    result = await async_session.execute(
        sql_delete(ResourceGrant).where(
            and_(
                ResourceGrant.resource_type == "folder",
                ResourceGrant.resource_id == folder_id,
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


async def _get_folder_grants_response(
    async_session: AsyncSession,
    folder_id: UUID,
) -> FolderGrantsResponse:
    """Fetch all grants for a folder, enriched with grantee display names."""
    grants_result = await async_session.execute(
        select(ResourceGrant, Role)
        .join(Role, Role.id == ResourceGrant.role_id)
        .where(
            ResourceGrant.resource_type == "folder",
            ResourceGrant.resource_id == folder_id,
        )
    )
    rows = grants_result.all()

    enriched: list[FolderGrantResponse] = []
    for grant, role in rows:
        name = str(grant.grantee_id)  # fallback
        if grant.grantee_type == "team":
            team = await async_session.get(Team, grant.grantee_id)
            if team:
                name = team.name
        elif grant.grantee_type == "organization":
            org = await async_session.get(Organization, grant.grantee_id)
            if org:
                name = org.name
        enriched.append(
            FolderGrantResponse(
                grantee_type=grant.grantee_type,
                grantee_id=grant.grantee_id,
                grantee_name=name,
                role=role.name,
            )
        )
    return FolderGrantsResponse(grants=enriched)
