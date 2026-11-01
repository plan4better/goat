"""One organization with a resource of every kind a core route can name.

Shared by the route sweeps: `build_org_world` creates organization A, an owner
of every resource (`owner`) and a second member (`member`, the target of
routes that name a user), and returns the ids the route placeholders take.
Rows are inserted directly, not through the API, so a broken create route
cannot take the sweeps down with it.
"""

import re
from collections.abc import Awaitable, Callable
from typing import Any
from uuid import UUID, uuid4

from core.core.config import settings
from core.db.models._link_model import (
    LayerProjectGroup,
    LayerProjectLink,
    ResourceGrant,
    UserTeamLink,
)
from core.db.models.asset import AssetType, UploadedAsset
from core.db.models.bundle import Bundle
from core.db.models.invitation import Invitation, InvitationStatusEnum, InvitationType
from core.db.models.organization import Organization
from core.db.models.organization_analytics import OrganizationAnalytics
from core.db.models.organization_domain import OrganizationDomain
from core.db.models.report_layout import ReportLayout
from core.db.models.space import Space, SpaceKind
from core.db.models.team import Team
from core.db.models.template import Template, TemplatePayloadKind
from core.db.models.user import User
from core.db.models.workflow import Workflow
from core.main import app
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.authz.conftest import _personal_space

S = settings.SCHEMA
API = settings.API_V2_STR
PLACEHOLDER = re.compile(r"\{([a-z_]+)\}")


async def give_org_role(db_session: AsyncSession, user_id: UUID, role_id: UUID) -> None:
    await db_session.execute(
        text(f"INSERT INTO {S}.user_role (user_id, role_id) VALUES (:u, :r)"),
        {"u": user_id, "r": role_id},
    )


def fill(pattern: str, ids: dict[str, Any]) -> str:
    """The route pattern with every placeholder replaced by its test id."""
    unknown = set(PLACEHOLDER.findall(pattern)) - set(ids)
    assert not unknown, f"{pattern}: no test resource for {unknown}"
    return PLACEHOLDER.sub(lambda m: str(ids[m.group(1)]), pattern)


def sweep_client() -> AsyncClient:
    """A client on which an unhandled exception becomes a 500 response, so a
    sweep reports a crashing route instead of stopping at it."""
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    return AsyncClient(transport=transport, base_url="http://test")


def body(method: str, pattern: str, ids: dict[str, Any], grantee_org: UUID) -> Any:
    """A valid body for write routes that would otherwise answer 422. Grants
    name `grantee_org`: the attempt is to share the resource with it."""
    org = str(grantee_org)
    bodies: dict[tuple[str, str], Any] = {
        ("POST", "bundle/{bundle_id}/dependencies"): {
            "depends_on_bundle_id": str(ids["bundle_id"]),
            "dependency_kind": "street_network",
        },
        ("POST", "bundle/{bundle_id}/layers"): {"layer_id": str(ids["layer_id"])},
        ("POST", "bundle/{bundle_id}/share"): {
            "grantee_type": "organization",
            "grantee_id": org,
            "role": "bundle-editor",
        },
        ("PATCH", "content/{resource_type}/{resource_id}/restricted"): {
            "restricted": True
        },
        ("POST", "folder/{folder_id}/share"): {
            "grantee_type": "organization",
            "grantee_id": org,
            "role": "folder-editor",
        },
        ("PATCH", "space/{space_id}"): {"default_role": "editor"},
        ("POST", "template/{template_id}/grant"): {
            "grantee_type": "organization",
            "grantee_id": org,
            "role": "template-editor",
        },
        ("POST", "template/{template_id}/use/preview"): {
            "project_id": str(ids["project_id"])
        },
    }
    return bodies.get((method, pattern), {})


async def build_org_world(
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_org: Callable[[], Awaitable[Organization]],
    make_user: Callable[..., Awaitable[User]],
    make_folder: Callable[..., Awaitable[Any]],
    make_layer: Callable[..., Awaitable[Any]],
    make_project: Callable[..., Awaitable[Any]],
    *,
    owner_role: str = "organization-editor",
    in_organization_space: bool = False,
) -> dict[str, Any]:
    """Organization A and one resource of each kind, all owned by `owner`.

    The content sits in the owner's personal space, or with
    `in_organization_space` in the organization's shared space, where every
    member gets the space's default role."""
    org_a = await make_org()
    a_owner, a_member = await make_user(org_a.id), await make_user(org_a.id)
    await give_org_role(db_session, a_owner.id, roles[owner_role])
    await give_org_role(db_session, a_member.id, roles["organization-editor"])

    folder = await make_folder(a_owner)
    layer = await make_layer(a_owner, folder)
    project = await make_project(a_owner, folder)
    space_id = await _personal_space(db_session, a_owner)
    org_space_id = (
        await db_session.execute(
            select(Space.id).where(
                Space.kind == SpaceKind.organization, Space.organization_id == org_a.id
            )
        )
    ).scalar_one()

    team = Team(id=uuid4(), name="A team", avatar="", organization_id=org_a.id)
    db_session.add(team)
    await db_session.flush()
    db_session.add(
        UserTeamLink(user_id=a_owner.id, team_id=team.id, role_id=roles["team-owner"])
    )

    link = LayerProjectLink(
        layer_id=layer.id, project_id=project.id, name="A layer", order=0
    )
    group = LayerProjectGroup(name="A group", project_id=project.id)
    bundle = Bundle(
        id=uuid4(),
        user_id=a_owner.id,
        folder_id=folder.id,
        space_id=space_id,
        name="A bundle",
        bundle_type="street_network",
    )
    template = Template(
        id=uuid4(),
        name="A template",
        space_id=space_id,
        folder_id=folder.id,
        user_id=a_owner.id,
        payload_kind=TemplatePayloadKind.project,
    )
    workflow = Workflow(id=uuid4(), project_id=project.id, name="A flow", config={})
    layout = ReportLayout(id=uuid4(), project_id=project.id, name="A layout", config={})
    asset = UploadedAsset(
        id=uuid4(),
        user_id=a_owner.id,
        s3_key=f"assets/{uuid4()}.png",
        file_name="a.png",
        mime_type="image/png",
        file_size=1,
        asset_type=AssetType.IMAGE,
        content_hash=uuid4().hex,
    )
    domain = OrganizationDomain(
        id=uuid4(),
        organization_id=org_a.id,
        base_domain=f"{uuid4().hex[:8]}.example.org",
    )
    analytics = OrganizationAnalytics(
        id=uuid4(),
        organization_id=org_a.id,
        name="A analytics",
        provider="matomo",
        config={"url": "https://matomo.example.org", "site_id": "1"},
    )
    invitation = Invitation(
        send_by=a_owner.id,
        type=InvitationType.organization,
        payload={
            "user_email": "invited@goat.test",
            "organization_id": str(org_a.id),
            "role": "organization-viewer",
        },
        status=InvitationStatusEnum.pending,
    )
    for row in (
        link,
        group,
        bundle,
        template,
        workflow,
        layout,
        asset,
        domain,
        analytics,
        invitation,
    ):
        db_session.add(row)
    await db_session.flush()
    grant = ResourceGrant(
        resource_type="template",
        resource_id=template.id,
        grantee_type="team",
        grantee_id=team.id,
        role_id=roles["template-viewer"],
    )
    db_session.add(grant)
    if in_organization_space:
        for table, row_id in (
            ("folder", folder.id),
            ("layer", layer.id),
            ("project", project.id),
            ("bundle", bundle.id),
            ("template", template.id),
        ):
            await db_session.execute(
                text(f"UPDATE {S}.{table} SET space_id = :s WHERE id = :i"),
                {"s": org_space_id, "i": row_id},
            )
    await db_session.commit()

    ids = {
        "organization_id": org_a.id,
        "team_id": team.id,
        "project_id": project.id,
        "layer_id": layer.id,
        "member_layer_id": layer.id,
        "folder_id": folder.id,
        "bundle_id": bundle.id,
        "template_id": template.id,
        "workflow_id": workflow.id,
        "layout_id": layout.id,
        "analytics_id": analytics.id,
        "domain_id": domain.id,
        "asset_id": asset.id,
        "invitation_id": invitation.id,
        "user_id": a_member.id,
        "grantee_type": "team",
        "grantee_id": team.id,
        "item_type": "project",
        "item_id": project.id,
        "group_id": group.id,
        "layer_project_id": link.id,
        "space_id": org_space_id,
        "dependency_kind": "street_network",
        "resource_type": "project",
        "resource_id": project.id,
        "grant_id": grant.id,
        # Support tickets live in Odoo, not in GOAT's database; support is off
        # in the tests (set_test_mode), so these routes answer 404.
        "ref": "00001",
        "attachment_id": 1,
    }
    return {"org": org_a, "owner": a_owner.id, "member": a_member.id, "ids": ids}
