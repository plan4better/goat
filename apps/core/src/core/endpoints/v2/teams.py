from typing import Any, List, Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from core.crud.crud_team import team as crud_team
from core.crud.crud_user import user as crud_user
from core.db.models.organization import OrganizationRolesEnum
from core.db.models.team import Team, TeamRolesEnum
from core.db.models.user import User
from core.deps.auth import auth_z, user_token
from core.endpoints.deps import get_db
from core.schemas.team import (
    TeamCreate,
    TeamMember,
    TeamOwnerUpdate,
    TeamRead,
    TeamUpdate,
    request_examples,
)

router = APIRouter()

ORG_ADMIN_ROLES = {OrganizationRolesEnum.owner, OrganizationRolesEnum.admin}
# Who can own a team: Bearbeiter and up (decision 5).
EDITOR_OR_UP = ORG_ADMIN_ROLES | {OrganizationRolesEnum.editor}


async def _org_admin(db: AsyncSession, user_id: str) -> User | None:
    """The caller when they are an owner or admin of their organization."""
    user = await crud_user.get_user_with_roles(db_session=db, user_id=user_id)
    if not user:
        return None
    roles = {link.role.name for link in user.role_links}
    return user if roles & ORG_ADMIN_ROLES else None


async def is_org_admin(db: AsyncSession, user_id: str) -> bool:
    """Whether the caller is an owner or admin of their organization."""
    return await _org_admin(db, user_id) is not None


async def is_org_admin_of_team(db: AsyncSession, team_id: str, user_id: str) -> bool:
    """Whether the caller is an owner or admin of the organization the team
    belongs to. With AUTH on, authorization() refuses a team of another
    organization already; this keeps it so in the handlers too."""
    admin = await _org_admin(db, user_id)
    if admin is None or admin.organization_id is None:
        return False
    team = await crud_team.get(db, id=team_id)
    return team is not None and team.organization_id == admin.organization_id


async def _require_team_manager(db: AsyncSession, team_id: str, user_id: str) -> None:
    """Renaming, deleting, adding and removing members and naming a new owner
    are for the team's owner and the owners and admins of the team's
    organization, who answer for every team of it (decision 2), also one whose
    owner has left. Everyone else gets 403."""
    team_role = await crud_team.get_member_role(db=db, team_id=team_id, user_id=user_id)
    if team_role == TeamRolesEnum.owner:
        return
    if await is_org_admin_of_team(db, team_id, user_id):
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Only the team's owner or an organization admin can do this",
    )


@router.get(
    "",
    summary="Get Teams List for a user",
    response_model=List[TeamRead],
    dependencies=[Depends(auth_z)],
)
async def get_team_list(
    *,
    db: AsyncSession = Depends(get_db),
    user_token: dict = Depends(user_token),
    scope: Literal["mine", "organization"] = Query(
        "mine",
        description=(
            "`mine`: the caller's teams (what the share dialogs list). "
            "`organization`: every team of the caller's organization, for its "
            "owners and admins only; `role` is null for a team the caller is not in."
        ),
    ),
) -> Any:
    """
    The caller's teams, or every team of their organization (owners and admins)
    """
    user_id = user_token["sub"]
    if scope == "organization" and not await is_org_admin(db, user_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the organization's owners and admins can list all its teams",
        )
    return await crud_team.get_all(db=db, user_id=user_id, scope=scope)


@router.get(
    "/{team_id}",
    summary="Get Team by ID",
    response_model=TeamRead | None,
    dependencies=[Depends(auth_z)],
)
async def get_team_by_id(
    *,
    db: AsyncSession = Depends(get_db),
    user_token: dict = Depends(user_token),
    team_id: str,
) -> Any:
    """
    The team with the caller's role in it. An owner or admin of the team's
    organization who is not in it gets the team with role null; anyone else
    outside it gets null.
    """
    user_id = user_token["sub"]
    team = await crud_team.get_by_id(db=db, team_id=team_id, user_id=user_id)
    if team is None and await is_org_admin_of_team(db, team_id, user_id):
        team = await crud_team.get_by_id(
            db=db, team_id=team_id, user_id=user_id, admin_view=True
        )
    return team


@router.get(
    "/{team_id}/members",
    summary="Get Team Members",
    response_model=List[TeamMember] | None,
    dependencies=[Depends(auth_z)],
)
async def get_team_members(
    *,
    db: AsyncSession = Depends(get_db),
    user_token: dict = Depends(user_token),
    team_id: str,
) -> Any:
    """
    The team's members, for a member of the team and for the owners and
    admins of the team's organization. Anyone else gets null, as
    GET /teams/{id} answers for a team that is not theirs.
    """
    user_id = user_token["sub"]
    team_role = await crud_team.get_member_role(db=db, team_id=team_id, user_id=user_id)
    if team_role is None and not await is_org_admin_of_team(db, team_id, user_id):
        return None
    team_members = await crud_team.get_team_members(db=db, team_id=team_id)

    return team_members


@router.post(
    "",
    summary="Create a new team",
    response_model=Team,
    dependencies=[Depends(auth_z)],
)
async def create_team(
    *,
    db: AsyncSession = Depends(get_db),
    user_token: dict = Depends(user_token),
    team: TeamCreate = Body(..., examples=[request_examples["team"]["create"]]),
) -> Any:
    """
    Create a new team, for Bearbeiter and up: a team brings a space for
    content, and viewers create no content.
    """
    user_id = user_token["sub"]
    # The permission table says the same (`create-team`), but it only changes
    # when the seed runs: until then its older rule lets a viewer through.
    # Someone with no organization role at all holds no permission in either
    # version of the table, so only the viewer needs refusing here.
    user = await crud_user.get_user_with_roles(db_session=db, user_id=user_id)
    org_roles = {link.role.name for link in user.role_links} if user else set()
    if org_roles and not org_roles & EDITOR_OR_UP:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="A viewer cannot create a team",
        )
    team = await crud_team.create_team(db=db, team_obj=team, user_id=user_id)
    return team


@router.patch(
    "/{team_id}/profile",
    summary="Update team",
    response_model=Team,
    dependencies=[Depends(auth_z)],
)
async def update_team(
    *,
    db: AsyncSession = Depends(get_db),
    user_token: dict = Depends(user_token),
    team_id: str,
    team: TeamUpdate = Body(..., examples=[request_examples["team"]["update"]]),
) -> Any:
    """
    Update a team
    """
    await _require_team_manager(db, team_id, user_token["sub"])
    db_obj = await crud_team.get(db=db, id=team_id)
    if not db_obj:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found",
        )
    updated_team = await crud_team.update_team(db=db, db_obj=db_obj, team_obj=team)
    return updated_team


@router.put(
    "/{team_id}/owner",
    summary="Name a team's owner",
    response_model=List[TeamMember],
    dependencies=[Depends(auth_z)],
)
async def change_team_owner(
    *,
    db: AsyncSession = Depends(get_db),
    user_token: dict = Depends(user_token),
    team_id: str,
    owner: TeamOwnerUpdate = Body(..., examples=[request_examples["team"]["owner"]]),
) -> Any:
    """
    Make a member of the team its owner: the team's owner hands the team over,
    or an owner or admin of the organization names one (a team whose owner
    left has none). The new owner must be in the team and hold Bearbeiter or
    higher in the organization; any other owner stays as a member. Naming the
    current owner again changes nothing. 409 when the new owner left the team
    meanwhile. Answers the team's members.
    """
    await _require_team_manager(db, team_id, user_token["sub"])
    new_owner = str(owner.user_id)
    team_role = await crud_team.get_member_role(
        db=db, team_id=team_id, user_id=new_owner
    )
    if team_role is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only a member of the team can become its owner",
        )
    if team_role != TeamRolesEnum.owner:
        user = await crud_user.get_user_with_roles(db_session=db, user_id=new_owner)
        org_roles = {link.role.name for link in user.role_links} if user else set()
        if not org_roles & EDITOR_OR_UP:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="A viewer cannot own a team",
            )
        await crud_team.change_owner(db=db, team_id=team_id, user_id=new_owner)
    return await crud_team.get_team_members(db=db, team_id=team_id)


@router.delete(
    "/{team_id}",
    summary="Delete a team",
    dependencies=[Depends(auth_z)],
)
async def delete_team(
    *,
    db: AsyncSession = Depends(get_db),
    user_token: dict = Depends(user_token),
    team_id: str,
) -> Any:
    """
    Delete a team
    """
    await _require_team_manager(db, team_id, user_token["sub"])
    team = await crud_team.delete_team(db=db, team_id=team_id)
    return team


@router.post(
    "/{team_id}/users/{user_id}",
    summary="Add a user to an team",
    # The member as GET /teams/{id}/members lists them; names may be missing.
    response_model=TeamMember,
    dependencies=[Depends(auth_z)],
)
async def add_user_to_team(
    *,
    db: AsyncSession = Depends(get_db),
    user_token: dict = Depends(user_token),
    user_id: str | None = None,
    team_id: str,
) -> Any:
    """
    Add a user to a team: for the team's owner and the owners and admins of
    the team's organization, and only users of that organization.
    """
    await _require_team_manager(db, team_id, user_token["sub"])
    team = await crud_team.get(db=db, id=team_id)
    user = await crud_user.get(db, user_id)
    if not team or not user or user.organization_id != team.organization_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only users of the team's organization can be added",
        )
    member = await crud_team.add_team_member(db=db, team_id=team_id, user_id=user_id)

    return member


@router.delete(
    "/{team_id}/users/{user_id}",
    summary="Remove a user from an team",
    dependencies=[Depends(auth_z)],
)
async def remove_user_from_team(
    *,
    db: AsyncSession = Depends(get_db),
    user_token: dict = Depends(user_token),
    user_id: str | None = None,
    team_id: str,
) -> Any:
    """
    Remove a user from a team. The team's owner and the owners and admins of
    the team's organization remove any member but the team's owner; every
    other member may only remove themselves, which is leaving. The owner
    cannot leave (the team would have no owner); a new owner comes first.
    """
    caller_id = user_token["sub"]
    caller_role = await crud_team.get_member_role(
        db=db, team_id=team_id, user_id=caller_id
    )
    # Leaving is for members; anyone else removing themselves is checked like
    # removing someone else (refused unless an owner or admin of the team's
    # organization, for whom it changes nothing).
    if caller_role is not None and str(user_id) == str(caller_id):
        if caller_role == TeamRolesEnum.owner:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="The team's owner cannot leave the team; make another member the owner first.",
            )
    else:
        if caller_role != TeamRolesEnum.owner and not await is_org_admin_of_team(
            db, team_id, caller_id
        ):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only the team's owner or an organization admin can remove other members",
            )
        target_role = await crud_team.get_member_role(
            db=db, team_id=team_id, user_id=user_id
        )
        if target_role == TeamRolesEnum.owner:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="The team's owner cannot be removed; delete the team instead",
            )

    await crud_team.remove_team_member(db=db, team_id=team_id, user_id=user_id)

    return {"message": "User removed from team"}
