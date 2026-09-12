import asyncio

from sqlalchemy import delete, insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.core.config import settings
from core.db.models import (
    Permission,
    Resource,
    ResourcePermissionLink,
    Role,
    RolePermissionLink,
)
from core.db.session import session_manager

ROLES = [
    {"name": "organization-owner", "resource_type": "organization"},
    {"name": "organization-admin", "resource_type": "organization"},
    {"name": "organization-editor", "resource_type": "organization"},
    {"name": "organization-viewer", "resource_type": "organization"},
    {"name": "team-owner", "resource_type": "team"},
    {"name": "team-member", "resource_type": "team"},
    {"name": "layer-owner", "resource_type": "layer"},
    {"name": "layer-editor", "resource_type": "layer"},
    {"name": "layer-viewer", "resource_type": "layer"},
    {"name": "project-owner", "resource_type": "project"},
    {"name": "project-editor", "resource_type": "project"},
    {"name": "project-viewer", "resource_type": "project"},
    {"name": "bundle-owner", "resource_type": "bundle"},
    {"name": "bundle-editor", "resource_type": "bundle"},
    {"name": "bundle-viewer", "resource_type": "bundle"},
    {"name": "folder-owner", "resource_type": "folder"},
    {"name": "folder-editor", "resource_type": "folder"},
    {"name": "folder-viewer", "resource_type": "folder"},
    {"name": "template-owner", "resource_type": "template"},
    {"name": "template-editor", "resource_type": "template"},
    {"name": "template-viewer", "resource_type": "template"},
]

PERMISSIONS = [
    "manage-folder",
    "read-bundle",
    "manage-bundle",
    "manage-asset",
    "create-layer",
    "read-layer",
    "update-layer",
    "delete-layer",
    "create-project",
    "read-project",
    "update-project",
    "delete-project",
    "create-job",
    "read-job",
    "update-organization",
    "read-organization",
    "delete-organization",
    "create-team",
    "read-team",
    "update-team",
    "delete-team",
    "manage-user",
    "manage-organization-invitation",
    "create-share",
    "read-share",
    "update-share",
    "delete-share",
    "manage-job",
    "read-billing",
    "create-report-layout",
    "read-report-layout",
    "update-report-layout",
    "delete-report-layout",
    "create-workflow",
    "read-workflow",
    "update-workflow",
    "delete-workflow",
]

# Define base permission for each role
ROLE_PERMISSIONS = {
    "organization-owner": [
        "delete-organization",
    ],
    "organization-admin": [
        "manage-organization-invitation",
        "update-organization",
    ],
    "organization-editor": [
        "manage-folder",
        "manage-bundle",
        "manage-asset",
        "create-job",
        "read-job",
        "create-share",
        "read-share",
        "update-share",
        "delete-share",
        "create-team",
        "manage-job",
        "create-project",
        "create-report-layout",
        "create-workflow",
    ],
    "organization-viewer": [
        "read-organization",
        "manage-user",
        "read-billing",
        "read-bundle",
    ],
    "team-owner": ["update-team", "delete-team"],
    "team-member": [
        "read-team",
    ],
    "layer-owner": [
        "create-share",
        "read-share",
        "update-share",
    ],
    "layer-editor": [
        "update-layer",
        "delete-layer",
        "create-layer",
    ],
    "layer-viewer": ["read-layer"],
    "project-owner": [
        "create-share",
        "read-share",
        "update-share",
        "delete-project",
        "delete-report-layout",
        "delete-workflow",
    ],
    "project-editor": [
        "update-project",
        "update-report-layout",
        "create-report-layout",
        "update-workflow",
        "create-workflow",
    ],
    "project-viewer": [
        "read-project",
        "read-report-layout",
        "read-workflow",
    ],
}

# Extend permissions for roles with permissions of roles with lower access
ROLE_PERMISSIONS["project-viewer"].extend(ROLE_PERMISSIONS["layer-viewer"])
ROLE_PERMISSIONS["project-editor"].extend(ROLE_PERMISSIONS["project-viewer"])
ROLE_PERMISSIONS["project-owner"].extend(ROLE_PERMISSIONS["project-editor"])
ROLE_PERMISSIONS["layer-editor"].extend(ROLE_PERMISSIONS["layer-viewer"])
ROLE_PERMISSIONS["layer-owner"].extend(ROLE_PERMISSIONS["layer-editor"])
ROLE_PERMISSIONS["team-owner"].extend(ROLE_PERMISSIONS["team-member"])
ROLE_PERMISSIONS["organization-editor"].extend(ROLE_PERMISSIONS["organization-viewer"])
ROLE_PERMISSIONS["organization-viewer"].extend(ROLE_PERMISSIONS["team-member"])
ROLE_PERMISSIONS["organization-viewer"].extend(ROLE_PERMISSIONS["layer-viewer"])
ROLE_PERMISSIONS["organization-viewer"].extend(ROLE_PERMISSIONS["project-viewer"])
ROLE_PERMISSIONS["organization-editor"].extend(ROLE_PERMISSIONS["team-owner"])
ROLE_PERMISSIONS["organization-editor"].extend(ROLE_PERMISSIONS["layer-owner"])
ROLE_PERMISSIONS["organization-editor"].extend(ROLE_PERMISSIONS["project-owner"])
ROLE_PERMISSIONS["organization-admin"].extend(ROLE_PERMISSIONS["organization-editor"])
ROLE_PERMISSIONS["organization-owner"].extend(ROLE_PERMISSIONS["organization-admin"])


# Make sure that the permissions are unique
for role_name, permissions in ROLE_PERMISSIONS.items():
    ROLE_PERMISSIONS[role_name] = list(set(permissions))

RESOURCES_PERMISSIONS = [
    {
        "url_pattern": "project/{project_id}/group",
        "method": ["DELETE", "POST", "PUT"],
        "permissions": ["update-project"],
    },
    {
        "url_pattern": "project/{project_id}/group",
        "method": ["GET"],
        "permissions": ["read-project"],
    },
    {
        "url_pattern": "project/{project_id}/layer-tree",
        "method": ["PUT"],
        "permissions": ["update-project"],
    },
    {
        # No permissions: any authenticated user may call it — per-item
        # access is enforced in code via `effective_role`/`authz.can`
        # the same way `job`/`system` below are gated.
        "url_pattern": "content/trash",
        "method": ["GET"],
    },
    {
        "url_pattern": "content/restore",
        "method": ["POST"],
    },
    {
        # Ownership is enforced in code (`CRUDContent.set_restricted` requires
        # space owner/admin rank on the target) — this only gates the endpoint
        # to any authenticated user, like `content/restore` above.
        "url_pattern": "content/{resource_type}/{resource_id}/restricted",
        "method": ["PATCH"],
    },
    {
        # Per-item visibility is enforced by `effective_role` inside the feed
        # — this permission only gates the endpoint itself to any
        # authenticated user who can read content at all.
        "url_pattern": "content",
        "method": ["GET"],
        "permissions": ["read-layer"],
    },
    {
        # The real ownership/membership/organisation rights check is done by
        # `CRUDTransfer` — this only gates the endpoint to any authenticated
        # user who can read content at all.
        "url_pattern": "content/transfer/preview",
        "method": ["POST"],
        "permissions": ["read-layer"],
    },
    {
        "url_pattern": "content/transfer",
        "method": ["POST"],
        "permissions": ["read-layer"],
    },
    {
        "url_pattern": "datasets/request-upload",
        "method": ["POST"],
        "permissions": ["create-layer"],
    },
    {
        "url_pattern": "datasets",
        "method": ["POST"],
        "permissions": ["read-layer"],
    },
    {
        "url_pattern": "favorite",
        "method": ["GET", "PUT", "DELETE"],
        "permissions": ["read-layer"],
    },
    {
        "url_pattern": "folder",
        "method": ["GET", "POST", "PUT", "DELETE"],
        "permissions": [
            "manage-folder",
        ],
    },
    {
        "url_pattern": "bundle",
        "method": ["GET"],
        "permissions": [
            "read-bundle",
        ],
    },
    {
        "url_pattern": "bundle",
        "method": ["POST", "PUT", "DELETE"],
        "permissions": [
            "manage-bundle",
        ],
    },
    {
        "url_pattern": "asset",
        "method": ["GET", "POST", "PUT", "DELETE"],
        "permissions": [
            "manage-asset",
        ],
    },
    {
        "url_pattern": "layer/file-upload",
        "method": ["POST"],
        "permissions": ["create-layer"],
    },
    {
        "url_pattern": "layer/feature-standard",
        "method": ["POST"],
        "permissions": ["create-layer"],
    },
    {
        "url_pattern": "layer/raster",
        "method": ["POST"],
        "permissions": ["create-layer"],
    },
    {"url_pattern": "layer/table", "method": ["POST"], "permissions": ["create-layer"]},
    {
        "url_pattern": "layer/{layer_id}/export",
        "method": ["POST"],
        "permissions": ["update-layer"],
    },
    {
        "url_pattern": "layer/{layer_id}",
        "method": ["GET"],
        "permissions": ["read-layer"],
    },
    {
        "url_pattern": "layer/{layer_id}",
        "method": ["PUT"],
        "permissions": ["update-layer"],
    },
    {
        "url_pattern": "layer/{layer_id}",
        "method": ["DELETE"],
        "permissions": ["delete-layer"],
    },
    {"url_pattern": "layer", "method": ["POST"], "permissions": ["read-layer"]},
    {"url_pattern": "project", "method": ["GET"], "permissions": ["read-project"]},
    {
        "url_pattern": "project",
        "method": ["POST"],
        "permissions": ["create-project"],
        "quota_types": ["projects"],
    },
    {
        "url_pattern": "project/{project_id}/layer",
        "method": ["POST"],
        "permissions": ["create-project", "read-layer", "update-project"],
    },
    {
        # Its own row: check_resource's `LIKE url_pattern || '/%'` fallback does
        # not match here (the '-' in 'layer-catalog' breaks the '/layer/%'
        # pattern), so without this every add-from-catalog 401s under AUTH.
        "url_pattern": "project/{project_id}/layer-catalog",
        "method": ["POST"],
        "permissions": ["read-layer", "update-project"],
    },
    {
        "url_pattern": "project/{project_id}/bundle/{bundle_id}",
        "method": ["POST"],
        "permissions": ["update-project"],
    },
    {"url_pattern": "project", "method": ["PUT"], "permissions": ["update-project"]},
    {"url_pattern": "project", "method": ["DELETE"], "permissions": ["delete-project"]},
    {
        "url_pattern": "project/{project_id}/copy",
        "method": ["POST"],
        "permissions": ["create-project", "read-project"],
        "quota_types": ["projects"],
    },
    {
        "url_pattern": "project/{project_id}/layer",
        "method": ["DELETE"],
        "permissions": [
            "update-project",
        ],
    },
    {
        "url_pattern": "project/{project_id}/publish",
        "method": ["POST"],
        "permissions": [
            "update-project",
        ],
    },
    {
        "url_pattern": "project/{project_id}/unpublish",
        "method": ["DELETE"],
        "permissions": [
            "update-project",
        ],
    },
    {
        "url_pattern": "job",
        "method": ["GET", "PUT"],
    },
    {
        "url_pattern": "system",
        "method": ["GET", "PUT"],
    },
    {
        "url_pattern": "active-mobility",
        "method": ["POST"],
        "quota_types": ["storage", "credits"],
        "permissions": ["update-project", "read-layer"],
    },
    {
        "url_pattern": "motorized-mobility",
        "method": ["POST"],
        "quota_types": ["storage", "credits"],
        "permissions": ["update-project", "read-layer"],
    },
    {
        "url_pattern": "tool",
        "method": ["POST"],
        "quota_types": ["storage", "credits"],
        "permissions": ["update-project", "read-layer"],
    },
    {
        "url_pattern": "collections",
        "method": ["GET"],
        "quota_types": ["credits"],
        "permissions": ["read-layer"],
    },
    {
        "url_pattern": "organizations/{organization_id}",
        "method": ["GET"],
        "permissions": ["read-organization"],
    },
    {
        "url_pattern": "organizations/{organization_id}",
        "method": ["DELETE"],
        "permissions": ["delete-organization"],
    },
    {
        "url_pattern": "organizations/{organization_id}/profile",
        "method": ["PATCH"],
        "permissions": ["update-organization"],
    },
    {
        "url_pattern": "organizations/{organization_id}/users",
        "method": ["GET"],
        "permissions": ["read-organization"],
    },
    {
        "url_pattern": "organizations/{organization_id}/users/{user_id}",
        "method": ["DELETE", "PATCH"],
        "permissions": ["update-organization"],
    },
    {
        "url_pattern": "organizations/{organization_id}/invitations",
        "method": ["GET", "POST", "DELETE", "PATCH"],
        "permissions": ["manage-organization-invitation"],
    },
    {
        "url_pattern": "organizations/{organization_id}/invitations/{invitation_id}",
        "method": ["DELETE", "PATCH"],
        "permissions": ["manage-organization-invitation"],
    },
    {
        "url_pattern": "space",
        "method": ["GET"],
        "permissions": ["read-team"],
    },
    {
        "url_pattern": "space/{space_id}",
        "method": ["PATCH"],
        "permissions": ["update-team"],
    },
    {
        # Per-space membership (space_rank >= 1) is enforced in code by
        # `crud_space.usage` — this only gates the endpoint to any
        # authenticated user, like `GET /space` above.
        "url_pattern": "space/{space_id}/usage",
        "method": ["GET"],
        "permissions": ["read-team"],
    },
    {
        "url_pattern": "teams",
        "method": ["GET", "POST"],
        "permissions": ["read-team"],
    },
    {
        "url_pattern": "teams/{team_id}",
        "method": ["GET"],
        "permissions": ["read-team"],
    },
    {
        "url_pattern": "teams/{team_id}",
        "method": ["DELETE"],
        "permissions": ["delete-team"],
    },
    {
        "url_pattern": "teams/{team_id}/profile",
        "method": ["PATCH"],
        "permissions": ["update-team"],
    },
    {
        "url_pattern": "teams/{team_id}/users",
        "method": ["GET"],
        "permissions": ["read-team"],
    },
    {
        "url_pattern": "teams/invite/{user_id}",
        "method": ["POST"],
        "permissions": ["update-team"],
    },
    {
        "url_pattern": "teams/invite/accept",
        "method": ["POST"],
        "permissions": ["read-team"],
    },
    {
        "url_pattern": "teams/{team_id}/leave",
        "method": ["DELETE"],
        "permissions": ["read-team"],
    },
    {
        "url_pattern": "users",
        "method": ["GET", "DELETE", "PATCH", "POST"],
        "permissions": ["manage-user"],
    },
    {
        "url_pattern": "share/layer/{layer_id}",
        "method": ["POST"],
        "permissions": ["create-share"],
    },
    {
        "url_pattern": "share/layer/{layer_id}",
        "method": ["GET"],
        "permissions": ["read-share"],
    },
    {
        "url_pattern": "share/project/{project_id}",
        "method": ["POST"],
        "permissions": ["create-share"],
    },
    {
        "url_pattern": "share/project/{project_id}",
        "method": ["GET"],
        "permissions": ["read-share"],
    },
    {
        "url_pattern": "billing",
        "method": ["GET"],
        "permissions": ["read-billing"],
    },
    {
        "url_pattern": "project/{project_id}/report-layout",
        "method": ["GET"],
        "permissions": ["read-report-layout"],
    },
    {
        "url_pattern": "project/{project_id}/report-layout/{layout_id}",
        "method": ["GET"],
        "permissions": ["read-report-layout"],
    },
    {
        "url_pattern": "project/{project_id}/report-layout",
        "method": ["POST"],
        "permissions": ["create-report-layout"],
    },
    {
        "url_pattern": "project/{project_id}/report-layout/{layout_id}",
        "method": ["PUT"],
        "permissions": ["update-report-layout"],
    },
    {
        "url_pattern": "project/{project_id}/report-layout/{layout_id}",
        "method": ["DELETE"],
        "permissions": ["delete-report-layout"],
    },
    {
        "url_pattern": "project/{project_id}/report-layout/{layout_id}/duplicate",
        "method": ["POST"],
        "permissions": ["create-report-layout"],
    },
    {
        "url_pattern": "project/{project_id}/workflow",
        "method": ["GET"],
        "permissions": ["read-workflow"],
    },
    {
        "url_pattern": "project/{project_id}/workflow/{workflow_id}",
        "method": ["GET"],
        "permissions": ["read-workflow"],
    },
    {
        "url_pattern": "project/{project_id}/workflow",
        "method": ["POST"],
        "permissions": ["create-workflow"],
    },
    {
        "url_pattern": "project/{project_id}/workflow/{workflow_id}",
        "method": ["PUT"],
        "permissions": ["update-workflow"],
    },
    {
        "url_pattern": "project/{project_id}/workflow/{workflow_id}",
        "method": ["DELETE"],
        "permissions": ["delete-workflow"],
    },
    {
        "url_pattern": "project/{project_id}/workflow/{workflow_id}/duplicate",
        "method": ["POST"],
        "permissions": ["create-workflow"],
    },
    # ---------------------------------------------------------------
    # White Label — Custom Domains
    # ---------------------------------------------------------------
    {
        "url_pattern": "organizations/{organization_id}/domains",
        "method": ["GET"],
        "permissions": ["read-organization"],
    },
    {
        "url_pattern": "organizations/{organization_id}/domains",
        "method": ["POST"],
        "permissions": ["update-organization"],
    },
    {
        "url_pattern": "organizations/{organization_id}/domains/{domain_id}",
        "method": ["GET"],
        "permissions": ["read-organization"],
    },
    {
        "url_pattern": "organizations/{organization_id}/domains/{domain_id}",
        "method": ["DELETE"],
        "permissions": ["update-organization"],
    },
    {
        "url_pattern": "organizations/{organization_id}/domains/{domain_id}/recheck",
        "method": ["POST"],
        "permissions": ["update-organization"],
    },
    {
        "url_pattern": "project/{project_id}/public/custom-domain",
        "method": ["POST"],
        "permissions": ["update-project"],
        "plan_names": ["goat_professional", "goat_enterprise"],
    },
    {
        "url_pattern": "project/{project_id}/public/custom-domain",
        "method": ["DELETE"],
        "permissions": ["update-project"],
        "plan_names": ["goat_professional", "goat_enterprise"],
    },
    # ---------------------------------------------------------------
    # White-label: organization analytics instances + per-project tracking
    # opt-in. Reads are org-wide; mutations require update-organization. The
    # per-project tracking selection gates on project ownership instead.
    # ---------------------------------------------------------------
    {
        "url_pattern": "organizations/{organization_id}/analytics",
        "method": ["GET"],
        "permissions": ["read-organization"],
    },
    {
        "url_pattern": "organizations/{organization_id}/analytics",
        "method": ["POST"],
        "permissions": ["update-organization"],
    },
    {
        "url_pattern": "organizations/{organization_id}/analytics/{analytics_id}",
        "method": ["PUT", "DELETE"],
        "permissions": ["update-organization"],
    },
    {
        "url_pattern": "organizations/{organization_id}/analytics/dashboards",
        "method": ["GET"],
        "permissions": ["read-organization"],
    },
    {
        "url_pattern": "organizations/{organization_id}/analytics/{analytics_id}/dashboards",
        "method": ["PUT"],
        "permissions": ["update-organization"],
    },
    {
        "url_pattern": "project/{project_id}/public/tracking",
        "method": ["PUT"],
        "permissions": ["update-project"],
        "plan_names": ["goat_professional", "goat_enterprise"],
    },
    # ---------------------------------------------------------------
    # Templates (T1/T3/T4). No permissions: any authenticated user may call
    # these — per-item access is enforced in code via `effective_role`/
    # `authz.can`, the same pattern as `content/trash` above.
    # ---------------------------------------------------------------
    {
        "url_pattern": "template",
        "method": ["GET", "POST"],
    },
    {
        "url_pattern": "template/preview",
        "method": ["POST"],
    },
    {
        "url_pattern": "template/{template_id}",
        "method": ["GET", "PATCH", "DELETE"],
    },
    {
        "url_pattern": "template/{template_id}/use",
        "method": ["POST"],
    },
    {
        "url_pattern": "template/{template_id}/refresh",
        "method": ["POST"],
    },
    {
        "url_pattern": "template/{template_id}/publish",
        "method": ["POST"],
    },
    {
        "url_pattern": "template/{template_id}/unpublish",
        "method": ["POST"],
    },
    {
        "url_pattern": "template/{template_id}/grant",
        "method": ["GET", "POST"],
    },
    {
        "url_pattern": "template/{template_id}/grant/{grant_id}",
        "method": ["DELETE"],
    },
]


async def seed_roles(session: AsyncSession) -> None:
    """Sync the authorization reference data (roles, permissions, resources).

    Idempotent — safe to re-run on every deploy. Everything happens in a single
    transaction, so concurrent requests keep reading the previous graph until
    commit; there is no window where the authz tables are empty.

    Roles are only ever added, never deleted: their ids are referenced by user
    assignments (``user_role``, ``user_team``, ``resource_grant``).
    The permission/resource graph carries no external references, so it is
    rebuilt from scratch to also drop entries removed from this file.
    """
    # Roles: insert the ones missing by name.
    existing_roles = set((await session.execute(select(Role.name))).scalars())
    missing_roles = [r for r in ROLES if r["name"] not in existing_roles]
    if missing_roles:
        await session.execute(insert(Role).values(missing_roles))

    # Rebuild the permission/resource graph. Link rows go first (their FKs
    # would also cascade, but explicit ordering keeps this independent of FK
    # configuration).
    await session.execute(delete(RolePermissionLink))
    await session.execute(delete(ResourcePermissionLink))
    await session.execute(delete(Permission))
    await session.execute(delete(Resource))

    await session.execute(insert(Permission).values([{"slug": p} for p in PERMISSIONS]))

    role_ids = dict((await session.execute(select(Role.name, Role.id))).all())
    permission_ids = dict(
        (await session.execute(select(Permission.slug, Permission.id))).all()
    )

    role_permission_links = [
        {"role_id": role_ids[role_name], "permission_id": permission_ids[slug]}
        for role_name, slugs in ROLE_PERMISSIONS.items()
        for slug in slugs
        if slug in permission_ids
    ]
    await session.execute(insert(RolePermissionLink).values(role_permission_links))

    resource_permission_links = []
    for resource_dict in RESOURCES_PERMISSIONS:
        resource_id = (
            await session.execute(
                insert(Resource)
                .values(
                    url_pattern=resource_dict["url_pattern"],
                    method=resource_dict["method"],
                    quota_types=resource_dict.get("quota_types"),
                    plan_names=resource_dict.get("plan_names"),
                )
                .returning(Resource.id)
            )
        ).scalar_one()
        resource_permission_links.extend(
            {"resource_id": resource_id, "permission_id": permission_ids[slug]}
            for slug in resource_dict.get("permissions", [])
            if slug in permission_ids
        )
    if resource_permission_links:
        await session.execute(
            insert(ResourcePermissionLink).values(resource_permission_links)
        )

    await session.commit()


async def main() -> None:
    session_manager.init(settings.ASYNC_SQLALCHEMY_DATABASE_URI)
    try:
        async with session_manager.session() as session:
            await seed_roles(session)
    finally:
        await session_manager.close()


if __name__ == "__main__":
    asyncio.run(main())
