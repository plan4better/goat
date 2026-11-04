from typing import TYPE_CHECKING, Any, List, Optional, Type
from uuid import UUID

from fastapi import HTTPException, status
from pydantic import UUID4
from sqlalchemy import Row, and_, func, null, or_, select, union
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import Select
from sqlmodel import SQLModel

from core.core.config import settings
from core.db.models import (
    Layer,
    Organization,
    Project,
    ResourceGrant,
    Role,
    Team,
    User,
)
from core.db.models.folder import Folder

if TYPE_CHECKING:
    from core.crud.crud_layer import CRUDLayer


async def read_content_by_id(
    async_session: AsyncSession,
    id: UUID4,
    model: Type[SQLModel],
    crud_content: "CRUDLayer",
    extra_fields: List[Any] = [],
) -> SQLModel:
    """Read a content by its ID.

    404s for a trashed item too — a soft-deleted resource stays in
    the database, but a normal read must behave as if it were gone; the
    trash listing (`GET /content/trash`) is the only place a trashed item is
    still surfaced.
    """
    content = await crud_content.get(async_session, id=id, extra_fields=extra_fields)

    if content is None or getattr(content, "deleted_at", None) is not None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"{model.__name__} not found"
        )

    return content


def grant_conditions(
    user_id: UUID | None, team_id: UUID | None, organization_id: UUID | None
) -> list[Any]:
    """ResourceGrant grantee predicates for a personal/team/org context."""
    conds: list[Any] = []
    if user_id:  # seam: personal shares
        conds.append(
            and_(
                ResourceGrant.grantee_type == "user",
                ResourceGrant.grantee_id == user_id,
            )
        )
    if team_id:
        conds.append(
            and_(
                ResourceGrant.grantee_type == "team",
                ResourceGrant.grantee_id == team_id,
            )
        )
    if organization_id:
        conds.append(
            and_(
                ResourceGrant.grantee_type == "organization",
                ResourceGrant.grantee_id == organization_id,
            )
        )
    return conds


def granted_ids(
    resource_type: str,
    user_id: UUID | None,
    team_id: UUID | None,
    organization_id: UUID | None,
) -> Select[Any]:
    """Subquery of resource ids the context has a direct grant on."""
    return select(ResourceGrant.resource_id).where(
        ResourceGrant.resource_type == resource_type,
        or_(*grant_conditions(user_id, team_id, organization_id)),
    )


def create_query_shared_content(
    model: type[Layer] | type[Project],
    filters: list[Any],
    team_id: UUID | None = None,
    organization_id: UUID | None = None,
    user_id: UUID | None = None,
) -> Select[Any]:
    """
    Creates a dynamic query for a given model (Layer or Project) and its associated team, organization, and owner user.

    :param model: The main model (Layer or Project)
    :param filters: Additional filters to apply
    :param team_id: ID of the team (optional)
    :param organization_id: ID of the organization (optional)
    :param user_id: ID of the user the content is directly shared with (optional)
    :return: A SQLAlchemy query object
    """
    # Every caller of this listing helper must hide a trashed item;
    # enforced once here so no listing can forget it.
    filters = [*filters, model.deleted_at.is_(None)]

    if team_id:
        read_column = [
            Team.name.label("team_name"),
            Team.id,
            Team.avatar.label("team_avatar"),
        ]
    elif organization_id:
        read_column = [
            Organization.name.label("team_name"),
            Organization.id,
            Organization.avatar.label("team_avatar"),
        ]
    else:
        read_column = []

    # Basic query to join the User who owns the Layer or Project
    base_query = select(
        model,
        Role.id.label("valid_role_id"),
        User.id.label("valid_user_id"),
        User.firstname.label("user_firstname"),
        User.lastname.label("user_lastname"),
        User.avatar.label("user_avatar"),
        *read_column,
    ).outerjoin(
        # LEFT, not INNER: a catalog layer has no owner, and an inner join would
        # drop it from the listing silently rather than returning it with an
        # empty `owned_by`.
        User,
        model.user_id == User.id,
    )

    if team_id:
        query = (
            base_query.join(
                ResourceGrant,
                and_(
                    ResourceGrant.resource_type == model.__tablename__,
                    ResourceGrant.resource_id == model.id,
                    ResourceGrant.grantee_type == "team",
                    ResourceGrant.grantee_id == team_id,
                ),
            )
            .join(Role, ResourceGrant.role_id == Role.id)
            .join(Team, ResourceGrant.grantee_id == Team.id)
            .where(and_(*filters))
        )
    elif organization_id:
        query = (
            base_query.join(
                ResourceGrant,
                and_(
                    ResourceGrant.resource_type == model.__tablename__,
                    ResourceGrant.resource_id == model.id,
                    ResourceGrant.grantee_type == "organization",
                    ResourceGrant.grantee_id == organization_id,
                ),
            )
            .join(Role, ResourceGrant.role_id == Role.id)
            .join(Organization, ResourceGrant.grantee_id == Organization.id)
            .where(and_(*filters))
        )
    elif user_id:
        query = (
            base_query.join(
                ResourceGrant,
                and_(
                    ResourceGrant.resource_type == model.__tablename__,
                    ResourceGrant.resource_id == model.id,
                    ResourceGrant.grantee_type == "user",
                    ResourceGrant.grantee_id == user_id,
                ),
            )
            .join(Role, ResourceGrant.role_id == Role.id)
            .where(and_(*filters))
        )
    else:
        # No team/org/user context (e.g. folder-grant path or plain "My
        # Content"). Use null() for valid_role_id to preserve the column
        # order that build_shared_with_object relies on (positional
        # indices), without joining Role — which would cause an implicit
        # cross join and multiply rows by the number of roles in the table.
        # The full multi-grant "shared_with" display for this branch is
        # fetched separately by `fetch_grants_by_resource` (reads
        # `resource_grant` directly — no ORM relationship, so no row
        # multiplication and no dependency on the legacy link tables).
        query = (
            select(
                model,
                null().label("valid_role_id"),
                User.id.label("valid_user_id"),
                User.firstname.label("user_firstname"),
                User.lastname.label("user_lastname"),
                User.avatar.label("user_avatar"),
            )
            .outerjoin(User, model.user_id == User.id)  # LEFT: see above
            .where(and_(*filters))
        )
    return query


async def fetch_grants_by_resource(
    async_session: AsyncSession,
    resource_type: str,
    resource_ids: list[UUID],
) -> dict[UUID, dict[str, list[dict[str, Any]]]]:
    """Every direct `resource_grant` row for the given resources, bucketed by
    resource id and grantee kind: ``{resource_id: {"teams": [...],
    "organizations": [...], "users": [...]}}``, each entry shaped like
    ``{"role": <role name>, "id": ..., "name": ..., "avatar": ...}``.

    Used by `build_shared_with_object`'s no-team/org/user-context branch —
    the multi-grant "who is this shared with" display for "My Content" and
    similar listings. A team/organization has a single `name` column; a user
    grantee does not, so `name` here is ``"{firstname} {lastname}"``
    (stripped), falling back to `email` when both are blank — the same shape
    the team/organization buckets use, so a caller can render all three
    kinds identically.
    """
    buckets: dict[UUID, dict[str, list[dict[str, Any]]]] = {}
    if not resource_ids:
        return buckets

    def bucket(resource_id: UUID) -> dict[str, list[dict[str, Any]]]:
        return buckets.setdefault(
            resource_id, {"teams": [], "organizations": [], "users": []}
        )

    team_rows = (
        await async_session.execute(
            select(
                ResourceGrant.resource_id,
                Role.name,
                Team.id,
                Team.name,
                Team.avatar,
            )
            .join(Role, ResourceGrant.role_id == Role.id)
            .join(Team, ResourceGrant.grantee_id == Team.id)
            .where(
                ResourceGrant.resource_type == resource_type,
                ResourceGrant.resource_id.in_(resource_ids),
                ResourceGrant.grantee_type == "team",
            )
        )
    ).all()
    for resource_id, role_name, team_id, team_name, team_avatar in team_rows:
        bucket(resource_id)["teams"].append(
            {
                "role": role_name,
                "id": team_id,
                "name": team_name,
                "avatar": team_avatar,
            }
        )

    org_rows = (
        await async_session.execute(
            select(
                ResourceGrant.resource_id,
                Role.name,
                Organization.id,
                Organization.name,
                Organization.avatar,
            )
            .join(Role, ResourceGrant.role_id == Role.id)
            .join(Organization, ResourceGrant.grantee_id == Organization.id)
            .where(
                ResourceGrant.resource_type == resource_type,
                ResourceGrant.resource_id.in_(resource_ids),
                ResourceGrant.grantee_type == "organization",
            )
        )
    ).all()
    for resource_id, role_name, org_id, org_name, org_avatar in org_rows:
        bucket(resource_id)["organizations"].append(
            {
                "role": role_name,
                "id": org_id,
                "name": org_name,
                "avatar": org_avatar,
            }
        )

    user_rows = (
        await async_session.execute(
            select(
                ResourceGrant.resource_id,
                Role.name,
                User.id,
                User.firstname,
                User.lastname,
                User.email,
                User.avatar,
            )
            .join(Role, ResourceGrant.role_id == Role.id)
            .join(User, ResourceGrant.grantee_id == User.id)
            .where(
                ResourceGrant.resource_type == resource_type,
                ResourceGrant.resource_id.in_(resource_ids),
                ResourceGrant.grantee_type == "user",
            )
        )
    ).all()
    for (
        resource_id,
        role_name,
        user_id,
        firstname,
        lastname,
        email,
        avatar,
    ) in user_rows:
        name = f"{firstname or ''} {lastname or ''}".strip() or email
        bucket(resource_id)["users"].append(
            {
                "role": role_name,
                "id": user_id,
                "name": name,
                "avatar": avatar,
            }
        )

    return buckets


# TODO: Make a pydantic schema for shared_with and owned_by
def build_shared_with_object(
    items: list[Row[Any]],
    role_mapping: dict[UUID, str],
    model_name: str = "layer",
    team_id: UUID | None = None,
    organization_id: UUID | None = None,
    grants_by_resource: dict[UUID, dict[str, list[dict[str, Any]]]] | None = None,
) -> list[dict[str, Any]]:
    """
    Builds the shared_with object for both Layer and Project models.

    :param items: The list of Layer or Project items, as produced by
        `create_query_shared_content` — column layout: (model, valid_role_id,
        valid_user_id, user_firstname, user_lastname, user_avatar
        [, team_or_org_name, team_or_org_id, team_or_org_avatar])
    :param role_mapping: The mapping of role IDs to role names
    :param model_name: The name of the model ("layer" or "project")
    :param team_id: Optional ID for team-specific sharing
    :param organization_id: Optional ID for organization-specific sharing
    :param grants_by_resource: Pre-fetched `fetch_grants_by_resource` output,
        keyed by resource id — required (else every item gets an empty
        teams/organizations/users list) when neither `team_id` nor
        `organization_id` is set, since that's the only case where a full
        multi-grant listing is built.
    :return: A list of dictionaries containing the model and the shared_with data
    """

    def get_owned_by(item: Row[Any]) -> dict[str, Any] | None:
        """The owner, or None when there isn't one (a catalog layer)."""
        if item[2] is None:
            return None
        return {
            "id": item[2],
            "firstname": item[3],
            "lastname": item[4],
            "avatar": item[5],
        }

    result_arr = []

    # Determine shared_with key
    shared_with_key = (
        "teams" if team_id else "organizations" if organization_id else None
    )

    for item in items:
        if team_id or organization_id:
            # Case where shared_with is for a specific team or organization.
            # Column layout (see docstring): index 6/7/8 are the team-or-org
            # name/id/avatar — NOT 2/3/4, which are the *owner*'s
            # id/firstname/lastname. (Previously misread as 2/3/4, which
            # silently put the wrong values — the resource owner's id/
            # firstname/lastname — into this team/org entry.)
            shared_with = {
                shared_with_key: [
                    {
                        "role": role_mapping[item[1]],  # Role name
                        "id": item[7],  # Team or Organization ID
                        "name": item[6],  # Team or Organization name
                        "avatar": item[8],  # Team or Organization avatar
                    }
                ]
            }
        else:
            # Case where shared_with includes every direct grant on the
            # resource, bucketed by grantee kind.
            grants = (grants_by_resource or {}).get(
                item[0].id, {"teams": [], "organizations": [], "users": []}
            )
            shared_with = {
                "teams": grants.get("teams", []),
                "organizations": grants.get("organizations", []),
                "users": grants.get("users", []),
            }

        # Add owned_by information
        owned_by = get_owned_by(item)
        result_arr.append(
            {**item[0].dict(), "shared_with": shared_with, "owned_by": owned_by}
        )

    return result_arr


def create_query_accessible_folders(
    user_id: UUID,
    team_ids: list[UUID],
    organization_id: Optional[UUID],
    member_space_ids: Optional[list[UUID]] = None,
) -> Any:
    """Return a UNION query of folder rows the user owns, has been granted
    access to, or reaches through membership of one of ``member_space_ids``.

    ``member_space_ids`` are the team/organisation spaces the caller is a
    member of (``space_rank >= 1``), resolved by the caller. Every live folder
    in such a space the caller holds a role on is listed — the space's own
    ``home`` root and folders other members created included — because a space
    owns its content (D1) and its members browse the whole tree. A Restricted
    folder is the exception: it withholds the space default (D9), so a member
    with no grant of his own is not shown it, nor anything below it.

    Columns: id, user_id, name
    """
    owned = select(
        Folder.id,
        Folder.user_id,
        Folder.name,
    ).where(Folder.user_id == user_id, Folder.deleted_at.is_(None))

    branches: list[Any] = [owned]

    if team_ids:
        shared_via_team = (
            select(
                Folder.id,
                Folder.user_id,
                Folder.name,
            )
            .join(
                ResourceGrant,
                and_(
                    ResourceGrant.resource_type == "folder",
                    ResourceGrant.resource_id == Folder.id,
                    ResourceGrant.grantee_type == "team",
                    ResourceGrant.grantee_id.in_(team_ids),
                ),
            )
            # user_id is nullable ("created by", survives the owning user
            # being deleted): plain `!=` is NULL for a NULL user_id in SQL,
            # which would silently drop a still-shared, owner-deleted folder
            # from this branch. is_distinct_from is NULL-safe. space_id NOT
            # NULL excludes a genuine orphan (space AND user both gone) —
            # a stale grant on one must not resurrect it into a listing.
            .where(
                Folder.user_id.is_distinct_from(user_id),
                Folder.deleted_at.is_(None),
                Folder.space_id.is_not(None),
            )
        )
        branches.append(shared_via_team)

    if organization_id:
        shared_via_org = (
            select(
                Folder.id,
                Folder.user_id,
                Folder.name,
            )
            .join(
                ResourceGrant,
                and_(
                    ResourceGrant.resource_type == "folder",
                    ResourceGrant.resource_id == Folder.id,
                    ResourceGrant.grantee_type == "organization",
                    ResourceGrant.grantee_id == organization_id,
                ),
            )
            .where(
                Folder.user_id.is_distinct_from(user_id),
                Folder.deleted_at.is_(None),
                Folder.space_id.is_not(None),
            )
        )
        branches.append(shared_via_org)

    if member_space_ids:
        # Membership alone is not access: a Restricted folder withholds the
        # space default (D9), and a member with no grant of his own must not
        # learn that it exists — the breadcrumbs, the folder tree and the Move
        # dialog all read this listing. `effective_role` covers the whole
        # ancestor chain, so a subtree under a restricted folder drops with it.
        # The grant branches above already imply access and stay untouched.
        in_member_space = select(
            Folder.id,
            Folder.user_id,
            Folder.name,
        ).where(
            Folder.space_id.in_(member_space_ids),
            Folder.deleted_at.is_(None),
            getattr(func, settings.SCHEMA)
            .effective_role("folder", Folder.id, user_id)
            .is_not(None),
        )
        branches.append(in_member_space)

    return union(*branches)
