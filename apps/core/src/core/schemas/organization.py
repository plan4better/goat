from datetime import datetime
from enum import Enum
from uuid import UUID
from uuid import UUID as _UUID

from pydantic import BaseModel
from sqlmodel import SQLModel

from core.db.models.invitation import InvitationStatusEnum
from core.db.models.organization import (
    AvailableRegionsEnum,
    OrganizationBase,
    OrganizationRolesEnum,
    OrganizationTypeEnum,
)
from core.utils.partial import optional


class OrganizationRead(OrganizationBase):
    id: _UUID
    created_at: datetime | None = None
    updated_at: datetime | None = None


class OrganizationCreateUpdateBase(BaseModel):
    name: str
    newsletter_subscribe: bool | None = None
    type: OrganizationTypeEnum
    avatar: str | None = None


class OrganizationCreate(OrganizationCreateUpdateBase):
    name: str
    region: AvailableRegionsEnum = AvailableRegionsEnum.eu


@optional
class OrganizationUpdate(OrganizationCreateUpdateBase):
    pass


class OrganizationMemberRoleUpdateEnum(str, Enum):
    admin = OrganizationRolesEnum.admin.value
    editor = OrganizationRolesEnum.editor.value
    viewer = OrganizationRolesEnum.viewer.value


class OrganizationUpdateMemberRole(SQLModel):
    role: OrganizationMemberRoleUpdateEnum


class OrganizationUser(BaseModel):
    id: UUID
    firstname: str | None
    lastname: str | None
    email: str
    roles: list[str]
    invitation_status: InvitationStatusEnum
    avatar: str | None


request_examples = {
    "organization": {
        "create": {
            "name": "test",
            "type": "government",
            "newsletter_subscribe": True,
        },
        "update": {"name": "test renamed"},
        "update_user_role": {"role": "organization-admin"},
        "invite": {
            "user_email": "majkshkurti94@gmail.com",
            "organization_id": "e1c0c0b7-8e9c-4c4a-9a3c-0b5a2c1f6b6b",
            "role": "owner",
        },
        "invite_update": {"role": "admin"},
    }
}
