from datetime import datetime
from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, StringConstraints
from sqlmodel import Field

from core.db.models.invitation import InvitationStatusEnum
from core.db.models.team import TeamBase, TeamRolesEnum

# A team's name as a caller sends it: surrounding spaces dropped, then 1 to
# 255 characters (TeamBase's limit). An empty name, a number or null is
# invalid input (422).
TeamName = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)
]


class TeamMemberPreview(BaseModel):
    """One face of a team's card: the owner first, then by name (B1)."""

    id: UUID
    firstname: str | None = None
    lastname: str | None = None
    avatar: str | None = None
    role: TeamRolesEnum


class TeamRead(TeamBase):
    id: UUID
    created_at: datetime | None = None
    updated_at: datetime | None = None
    # The caller's role in the team; None for an owner or admin of the
    # organization who is not in it (scope "organization" and GET /teams/{id}).
    role: TeamRolesEnum | None = None
    member_count: int = 0
    members_preview: list[TeamMemberPreview] = Field(default_factory=list)


class TeamUpdate(BaseModel):
    """A team's profile; a field left out keeps its value."""

    # Left out, the name stays; sent, it must be a name (null is not).
    name: TeamName = Field(default=None)
    avatar: str | None = None
    description: str | None = None


class TeamCreate(BaseModel):
    name: TeamName
    description: str | None = None
    avatar: str | None = None


class TeamOwnerUpdate(BaseModel):
    """The member who becomes the team's owner (B7)."""

    user_id: UUID


class TeamMember(BaseModel):
    id: UUID
    firstname: str | None
    lastname: str | None
    email: str
    role: str
    avatar: str | None
    invitation_status: InvitationStatusEnum


request_examples = {
    "team": {
        "create": {
            "name": "team_1",
            "description": "team_1_description",
            "avatar": "team_1_avatar",
        },
        "update": {"description": "team_1_description_updated"},
        "owner": {"user_id": "744e4fd1-685c-495c-8b02-efebce875359"},
    }
}
