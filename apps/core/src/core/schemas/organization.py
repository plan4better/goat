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


class FeaturesRead(BaseModel):
    """Which SaaS integrations this installation runs. Both are off on a
    self-hosted install, and the web app shows none of their pages then."""

    # Support tickets (Odoo Helpdesk).
    support: bool
    # Trials, credits and usage, quotas pushed by the billing system.
    billing: bool


class OrganizationCreationRead(BaseModel):
    """Whether the caller may set up an organization
    (`ALLOW_ORGANIZATION_CREATION`, superusers always may)."""

    allowed: bool


class OrganizationPermanentlyDeleted(BaseModel):
    """What `DELETE /organizations/{id}/permanent` removed."""

    id: UUID
    # The former member, whose account stays without an organization; None
    # when the organization had no member left.
    user_id: UUID | None
    # Billing is not touched: a subscription stays in Odoo under this
    # company until someone ends it there.
    odoo_company_id: int | None


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
