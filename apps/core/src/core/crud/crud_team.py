from collections import defaultdict
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import and_, case, func, update
from sqlalchemy import delete as sql_delete
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased
from sqlmodel import select

from core.core.config import settings
from core.crud.base import CRUDBase
from core.crud.crud_role import role as crud_role
from core.crud.crud_space import space as crud_space
from core.crud.crud_user import user as crud_user
from core.db.models._link_model import ResourceGrant, UserTeamLink
from core.db.models.bundle import Bundle
from core.db.models.folder import Folder
from core.db.models.invitation import InvitationStatusEnum
from core.db.models.layer import Layer
from core.db.models.project import Project
from core.db.models.role import Role
from core.db.models.space import Space, SpaceKind
from core.db.models.team import Team, TeamRolesEnum
from core.db.models.template import Template
from core.db.models.user import User
from core.schemas.team import TeamCreate, TeamMember, TeamUpdate
from core.services.s3 import s3_service
from core.utils.i18n import trans as _
from core.utils.other import decode_base64_file, get_image_extension_from_base64


class CRUDTeam(CRUDBase[Team, TeamCreate, TeamUpdate]):
    async def name_taken(
        self,
        *,
        db: AsyncSession,
        organization_id: Any,
        name: str,
        exclude_team_id: str | None = None,
    ) -> bool:
        """Whether another team of the organization has `name`, ignoring case
        and surrounding spaces (`lower()` on both sides, so the database's
        notion of case decides, umlauts included). A team without an
        organization clashes with nothing."""
        if organization_id is None:
            return False
        statement = select(Team.id).where(
            Team.organization_id == organization_id,
            func.lower(func.trim(Team.name)) == func.lower(name.strip()),
        )
        if exclude_team_id is not None:
            statement = statement.where(Team.id != UUID(str(exclude_team_id)))
        return (await db.execute(statement.limit(1))).first() is not None

    def _name_conflict(self) -> HTTPException:
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=_("A team with this name already exists in the organization"),
        )

    async def create_team(
        self, *, db: AsyncSession, team_obj: TeamCreate, user_id: str
    ) -> Team:
        user = await crud_user.get(db, user_id)
        assert user is not None
        team_obj.name = team_obj.name.strip()
        if await self.name_taken(
            db=db, organization_id=user.organization_id, name=team_obj.name
        ):
            raise self._name_conflict()
        team = Team(**team_obj.model_dump(), organization_id=user.organization_id)
        role = await crud_role.get_by_key(db=db, key="name", value=TeamRolesEnum.owner)
        user_team = UserTeamLink(user=user, team=team, role_id=role[0].id)
        db.add(team)
        db.add(user_team)
        await db.commit()
        await db.refresh(team)
        assert team.id is not None
        await crud_space.ensure_team(db, team.id)
        return team

    async def update_team(
        self,
        *,
        db_obj: Team,
        team_obj: TeamUpdate,
        db: AsyncSession,
    ) -> Any:
        if team_obj.name is not None:
            team_obj.name = team_obj.name.strip()
            # An unchanged name never clashes: the web sends the name with
            # every save, and a duplicate made before names were checked must
            # still take a new picture or description.
            if team_obj.name != db_obj.name.strip() and await self.name_taken(
                db=db,
                organization_id=db_obj.organization_id,
                name=team_obj.name,
                exclude_team_id=str(db_obj.id),
            ):
                raise self._name_conflict()
        if team_obj.avatar and team_obj.avatar.startswith("data:image"):
            extension = get_image_extension_from_base64(team_obj.avatar)
            now = datetime.now()
            timestamp_str = now.strftime("%Y%m%d%H%M%S")
            file_name = f"avatar_team_{db_obj.id}_T{timestamp_str}.{extension}"
            file = decode_base64_file(team_obj.avatar)
            s3_service.upload_asset(
                file,
                f"img/users/{settings.ENVIRONMENT}/{file_name}",
                f"image/{extension}",
            )
            team_obj.avatar = (
                f"{settings.ASSETS_URL}/img/users/{settings.ENVIRONMENT}/{file_name}"
            )
        updated_team = await self.update(db=db, db_obj=db_obj, obj_in=team_obj)

        return updated_team

    async def delete_team(
        self,
        *,
        db: AsyncSession,
        team_id: str,
    ) -> Team:
        # A team space cascades away with the team (space.team_id FK), which
        # would take any content still in it along — refuse while the space
        # still holds anything, live OR TRASHED: a trashed row is still
        # restorable until it is purged, so silently
        # hard-deleting it via the space cascade would destroy content an
        # admin could otherwise have brought back. Counts every row
        # regardless of `deleted_at`, so the admin must restore/transfer the
        # live content and empty the trash before the team can go.
        team_space_id = (
            await db.execute(
                select(Space.id).where(
                    Space.kind == SpaceKind.team, Space.team_id == UUID(str(team_id))
                )
            )
        ).scalar_one_or_none()
        if team_space_id is not None:
            content_count = 0
            for model in (Layer, Project, Bundle, Template):
                content_count += int(
                    (
                        await db.execute(
                            select(func.count())
                            .select_from(model)
                            .where(model.space_id == team_space_id)
                        )
                    ).scalar_one()
                )
            # Folders, minus the space's own `home` root: that root
            # (`parent_id IS NULL AND user_id IS NULL`) is provisioned with
            # the space itself by `crud_space.ensure_team` and is not
            # content anyone can restore or transfer, so counting it would
            # make every team undeletable. Every other folder in the space
            # still blocks, root or not.
            content_count += int(
                (
                    await db.execute(
                        select(func.count())
                        .select_from(Folder)
                        .where(
                            Folder.space_id == team_space_id,
                            ~(Folder.parent_id.is_(None) & Folder.user_id.is_(None)),
                        )
                    )
                ).scalar_one()
            )
            if content_count:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=_(
                        "The team still owns content — restore or transfer it, "
                        "and empty its trash, before deleting the team"
                    ),
                )

        # A team is a grantee with no FK from resource_grant — drop its grants with it
        await db.execute(
            sql_delete(ResourceGrant).where(
                ResourceGrant.grantee_type == "team",
                ResourceGrant.grantee_id == UUID(str(team_id)),
            )
        )
        team = await self.remove(db=db, id=team_id)

        await db.commit()
        return team

    # How many faces a team's card shows.
    PREVIEW_SIZE = 4

    async def _with_members(
        self, db: AsyncSession, teams: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Adds `member_count` and `members_preview` (the owner first, then by
        name, at most PREVIEW_SIZE) to every team, from one query for all of
        them, so a list costs no request per team."""
        if not teams:
            return teams
        name = func.lower(
            func.coalesce(
                func.nullif(
                    func.trim(func.concat_ws(" ", User.firstname, User.lastname)), ""
                ),
                User.email,
            )
        )
        rows = (
            await db.execute(
                select(
                    UserTeamLink.team_id,
                    User.id,
                    User.firstname,
                    User.lastname,
                    User.avatar,
                    Role.name.label("role"),
                )
                .join(User, User.id == UserTeamLink.user_id)
                .join(Role, Role.id == UserTeamLink.role_id)
                .where(UserTeamLink.team_id.in_([team["id"] for team in teams]))
                .order_by(
                    UserTeamLink.team_id,
                    Role.name != TeamRolesEnum.owner.value,  # the owner first
                    name,
                )
            )
        ).all()
        by_team: dict[Any, list[Any]] = defaultdict(list)
        for row in rows:
            by_team[row.team_id].append(row)
        for team in teams:
            members = by_team.get(team["id"], [])
            team["member_count"] = len(members)
            team["members_preview"] = [
                {
                    "id": member.id,
                    "firstname": member.firstname,
                    "lastname": member.lastname,
                    "avatar": member.avatar,
                    "role": member.role,
                }
                for member in members[: self.PREVIEW_SIZE]
            ]
        return teams

    async def get_all(
        self,
        *,
        db: AsyncSession,
        user_id: str,
        scope: Literal["mine", "organization"] = "mine",
    ) -> list[dict[str, Any]]:
        """The caller's teams with their role in each (`mine`), or every team of
        the caller's organization with the role where they are in it, else None
        (`organization`; the endpoint lets only owners and admins ask)."""
        in_team = and_(UserTeamLink.team_id == Team.id, UserTeamLink.user_id == user_id)
        statement = select(Team, Role.name.label("role"))
        if scope == "organization":
            organization_id = (
                select(User.organization_id).where(User.id == user_id).scalar_subquery()
            )
            statement = (
                statement.join(UserTeamLink, in_team, isouter=True)
                .join(Role, UserTeamLink.role_id == Role.id, isouter=True)
                .where(Team.organization_id == organization_id)
            )
        else:
            statement = statement.join(UserTeamLink, in_team).join(
                Role, UserTeamLink.role_id == Role.id
            )
        rows = (await db.execute(statement)).all()
        return await self._with_members(
            db, [{**row.Team.model_dump(), "role": row.role} for row in rows]
        )

    async def get_by_id(
        self,
        *,
        db: AsyncSession,
        team_id: str,
        user_id: str,
        admin_view: bool = False,
    ) -> dict[str, Any] | None:
        """The team with the caller's role in it; None when the caller is not in
        it, unless `admin_view` (an owner or admin of the team's organization,
        checked by the endpoint), which answers the team with role None."""
        in_team = and_(UserTeamLink.team_id == Team.id, UserTeamLink.user_id == user_id)
        statement = (
            select(Team, Role.name.label("role"))
            .join(UserTeamLink, in_team, isouter=admin_view)
            .join(Role, UserTeamLink.role_id == Role.id, isouter=admin_view)
            .where(Team.id == team_id)
        )
        row = (await db.execute(statement)).first()
        if not row:
            return None
        teams = await self._with_members(
            db, [{**row.Team.model_dump(), "role": row.role}]
        )
        return teams[0]

    async def get_team_members(
        self, *, db: AsyncSession, team_id: str
    ) -> list[TeamMember]:
        statement = (
            select(User, Role.name.label("role"))
            .join(UserTeamLink, UserTeamLink.user_id == User.id)
            .join(Role, UserTeamLink.role_id == Role.id)
            .where(UserTeamLink.team_id == team_id)
        )
        result = await db.execute(statement)
        members = result.all()

        member_list = [
            {
                **member.User.model_dump(),
                "role": member.role,
                "invitation_status": InvitationStatusEnum.accepted,
            }
            for member in members
        ]

        return member_list

    async def get_member_role(
        self, *, db: AsyncSession, team_id: str, user_id: str
    ) -> str | None:
        """The user's role name in the team, or None when they are not in it."""
        statement = (
            select(Role.name)
            .join(UserTeamLink, UserTeamLink.role_id == Role.id)
            .where(UserTeamLink.team_id == team_id, UserTeamLink.user_id == user_id)
        )
        return (await db.execute(statement)).scalar_one_or_none()

    async def change_owner(
        self, *, db: AsyncSession, team_id: str, user_id: str
    ) -> None:
        """`user_id` becomes the team's owner and any other owner a member.

        One UPDATE over every row of the team: the engine commits every
        statement on its own (AUTOCOMMIT), so two statements would leave a
        moment with two owners or none. Writing every row, not only the two
        that change, makes two handovers at the same moment take turns: the
        second waits for the first and then re-reads all the rows it writes,
        so one owner remains. The UPDATE runs only while the new owner is
        still in the team; when they were removed after the caller's check it
        writes nothing and answers 409, instead of leaving the team without
        an owner. The team's space belongs to the team, so nothing else moves.
        """
        ids = dict(
            (
                await db.execute(
                    select(Role.name, Role.id).where(
                        Role.name.in_(
                            [TeamRolesEnum.owner.value, TeamRolesEnum.member.value]
                        )
                    )
                )
            ).all()
        )
        owner_role, member_role = (
            ids[TeamRolesEnum.owner.value],
            ids[TeamRolesEnum.member.value],
        )
        team = UUID(str(team_id))
        new_owner = UUID(str(user_id))
        candidate = aliased(UserTeamLink)
        result = await db.execute(
            update(UserTeamLink)
            .where(
                UserTeamLink.team_id == team,
                select(candidate.id)
                .where(candidate.team_id == team, candidate.user_id == new_owner)
                .exists(),
            )
            .values(
                role_id=case(
                    (UserTeamLink.user_id == new_owner, owner_role),
                    else_=member_role,
                )
            )
            .execution_options(synchronize_session=False)
        )
        await db.commit()
        if result.rowcount == 0:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="The person is no longer a member of the team",
            )

    async def add_team_member(
        self,
        *,
        db: AsyncSession,
        team_id: str,
        user_id: str,
    ) -> TeamMember:
        user = await crud_user.get(db, user_id)
        team = await self.get(db, team_id)
        role = await crud_role.get_by_key(db=db, key="name", value=TeamRolesEnum.member)
        if not role or not role[0]:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=_("Invalid role"),
            )
        role = role[0]
        user_team = UserTeamLink(user=user, team=team, role_id=role.id)
        db.add(user_team)
        await db.commit()
        await db.refresh(user_team)
        new_member = TeamMember(
            **user.model_dump(),
            role=role.name,
            invitation_status=InvitationStatusEnum.accepted,
        )
        return new_member

    async def remove_team_member(
        self, *, db: AsyncSession, user_id: str, team_id: str
    ) -> None:
        statement = (
            select(UserTeamLink, Role.name.label("role"))
            .join(Role, UserTeamLink.role_id == Role.id)
            .where(UserTeamLink.user_id == user_id, UserTeamLink.team_id == team_id)
        )
        result = await db.execute(statement)
        user_team = result.first()
        if not user_team:
            return None
        await db.delete(user_team[0])
        await db.commit()
        return


team = CRUDTeam(Team)
