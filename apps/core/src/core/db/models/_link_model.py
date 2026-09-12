from datetime import datetime
from typing import TYPE_CHECKING, Any, Dict, List, Optional
from uuid import UUID

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as UUID_PG
from sqlmodel import (
    Column,
    Field,
    ForeignKey,
    Index,
    Integer,
    Relationship,
    SQLModel,
    Text,
    UniqueConstraint,
)

from core.core.config import settings
from core.db.models._base_class import DateTimeBase

if TYPE_CHECKING:
    from .bundle import Bundle
    from .layer import Layer
    from .project import Project
    from .role import Role
    from .team import Team
    from .user import User


class LayerProjectLink(DateTimeBase, table=True):
    __tablename__ = "layer_project"
    __table_args__ = {"schema": settings.SCHEMA}

    id: int | None = Field(
        default=None, sa_column=Column(Integer, primary_key=True, autoincrement=True)
    )
    layer_id: UUID = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.layer.id", ondelete="CASCADE"),
        ),
        description="Layer ID",
    )
    project_id: UUID = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.project.id", ondelete="CASCADE"),
            # Every read and reorder of a project's tree filters on it.
            index=True,
        ),
        description="Project ID",
    )
    layer_project_group_id: Optional[int] = Field(
        default=None,
        sa_column=Column(
            Integer,
            ForeignKey(f"{settings.SCHEMA}.layer_project_group.id", ondelete="CASCADE"),
            nullable=True,
        ),
        description="The Group ID this layer belongs to",
    )
    order: int = Field(default=0, sa_column=Column(Integer, default=0, nullable=False))
    name: str = Field(
        sa_column=Column(Text, nullable=False),
        description="Layer name within the project",
        max_length=255,
    )
    properties: Dict[str, Any] | None = Field(
        sa_column=Column(JSONB, nullable=True), description="Layer properties"
    )
    other_properties: Dict[str, Any] | None = Field(
        sa_column=Column(JSONB, nullable=True), description="Layer other properties"
    )
    query: Dict[str, Any] | None = Field(
        default=None,
        sa_column=Column(JSONB, nullable=True),
        description="CQL2-JSON filter to query the layer",
    )
    charts: Dict[str, Any] | None = Field(
        default=None,
        sa_column=Column(JSONB, nullable=True),
        description="Chart configuration",
    )
    shareable: bool = Field(
        default=True,
        sa_column=Column(sa.Boolean, nullable=False, server_default=sa.text("true")),
        description="Whether this layer travels with the project when the project is shared.",
    )

    # Relationships
    project: "Project" = Relationship(back_populates="layer_projects")
    layer: "Layer" = Relationship(back_populates="layer_projects")
    group: Optional["LayerProjectGroup"] = Relationship(back_populates="layers")


class LayerProjectGroup(DateTimeBase, table=True):
    __tablename__ = "layer_project_group"
    __table_args__ = {"schema": settings.SCHEMA}

    id: int | None = Field(
        default=None, sa_column=Column(Integer, primary_key=True, autoincrement=True)
    )
    name: str = Field(sa_column=Column(Text, nullable=False))
    order: int = Field(default=0, sa_column=Column(Integer, default=0, nullable=False))
    properties: Dict[str, Any] | None = Field(
        sa_column=Column(JSONB, nullable=True), description="Layer Group properties"
    )
    project_id: UUID = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.project.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        )
    )

    # Self-referential key for nested groups (Parent Group)
    parent_id: Optional[int] = Field(
        default=None,
        sa_column=Column(
            Integer,
            ForeignKey(f"{settings.SCHEMA}.layer_project_group.id", ondelete="CASCADE"),
            nullable=True,
        ),
    )

    # Bundle-backed group: when set, this group holds a bundle's member layers and
    # its membership is locked (layers cannot be dragged in/out or removed
    # individually). CASCADE so deleting the bundle removes the group everywhere.
    bundle_id: Optional[UUID] = Field(
        default=None,
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.bundle.id", ondelete="CASCADE"),
            nullable=True,
            index=True,
        ),
    )

    # Relationships
    project: "Project" = Relationship(back_populates="layer_groups")

    # Parent/Child relationship for nesting
    parent: Optional["LayerProjectGroup"] = Relationship(
        back_populates="children",
        sa_relationship_kwargs={"remote_side": "LayerProjectGroup.id"},
    )
    children: List["LayerProjectGroup"] = Relationship(
        back_populates="parent",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )

    # Usage: link.group_id
    layers: List["LayerProjectLink"] = Relationship(
        back_populates="group",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )


class UserProjectLink(DateTimeBase, table=True):
    __tablename__ = "user_project"
    __table_args__ = (
        Index("ix_user_project_project_id_user_id", "project_id", "user_id"),
        {"schema": settings.SCHEMA},
    )

    id: int | None = Field(
        default=None, sa_column=Column(Integer, primary_key=True, autoincrement=True)
    )
    user_id: UUID = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.user.id", ondelete="CASCADE"),
        ),
        description="User ID",
    )
    project_id: UUID = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.project.id", ondelete="CASCADE"),
        ),
        description="Project ID",
    )
    initial_view_state: Dict[str, Any] = Field(
        sa_column=Column(JSONB, nullable=False),
        description="Initial view state of the project",
    )
    last_opened_at: datetime | None = Field(
        default=None,
        sa_column=Column(sa.DateTime(timezone=True), nullable=True),
        description="When this user last opened the project",
    )

    # Relationships
    project: "Project" = Relationship(back_populates="user_projects")

    # Constraints
    (UniqueConstraint("project_id", "user_id", name="unique_user_project"),)


class UserTeamLink(SQLModel, table=True):
    """
    A table representing the relation between users and teams.

    Attributes:
        id (int): The unique identifier for the user team.
        team_id (str): The unique identifier for the team the user belongs to.
        user_id (str): The unique identifier for the user that belongs to the team.
    """

    __tablename__ = "user_team"
    __table_args__ = (
        UniqueConstraint("user_id", "team_id", name="user_team_user_id_team_id_key"),
        {"schema": settings.SCHEMA},
    )

    id: Optional[int] = Field(
        sa_column=Column(Integer, primary_key=True, autoincrement=True)
    )
    team_id: UUID = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.team.id", ondelete="CASCADE"),
            nullable=False,
        )
    )
    user_id: UUID = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.user.id", ondelete="CASCADE"),
            nullable=False,
        )
    )
    role_id: UUID = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.role.id"),
            nullable=False,
        )
    )

    # Relationships
    user: "User" = Relationship(back_populates="team_links")
    team: "Team" = Relationship(back_populates="user_links")


class ResourceGrant(SQLModel, table=True):
    """Generic sharing table: grants a role on any resource to a team or organization."""

    __tablename__ = "resource_grant"
    __table_args__ = (
        UniqueConstraint(
            "resource_type",
            "resource_id",
            "grantee_type",
            "grantee_id",
            name="resource_grant_resource_type_resource_id_grantee_type_grant_key",
        ),
        {"schema": settings.SCHEMA},
    )

    id: Optional[UUID] = Field(
        default=None,
        sa_column=Column(
            UUID_PG(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
    )
    resource_type: str = Field(sa_column=Column(sa.String(length=50), nullable=False))
    resource_id: UUID = Field(sa_column=Column(UUID_PG(as_uuid=True), nullable=False))
    grantee_type: str = Field(sa_column=Column(sa.String(length=50), nullable=False))
    grantee_id: UUID = Field(sa_column=Column(UUID_PG(as_uuid=True), nullable=False))
    role_id: UUID = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.role.id", ondelete="CASCADE"),
            nullable=False,
        )
    )
    granted_by: UUID | None = Field(
        default=None,
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.user.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    created_at: Optional[Any] = Field(
        default=None,
        sa_column=Column(
            sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
    )


# ---------------------------------------------------------------------------
# RBAC link tables. Defined column-only (no ORM Relationship); the authz SQL
# functions and seeds query these tables directly.
# ---------------------------------------------------------------------------


class RolePermissionLink(SQLModel, table=True):
    """Relation between roles and permissions."""

    __tablename__ = "role_permission"
    __table_args__ = {"schema": settings.SCHEMA}

    id: Optional[int] = Field(
        sa_column=Column(Integer, primary_key=True, autoincrement=True)
    )
    role_id: Optional[UUID] = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.role.id", ondelete="CASCADE"),
        ),
    )
    permission_id: Optional[UUID] = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.permission.id", ondelete="CASCADE"),
            nullable=False,
        ),
    )


sa.Index(
    "idx_role_permission",
    RolePermissionLink.__table__.c.role_id,
    RolePermissionLink.__table__.c.permission_id,
    unique=True,
)
sa.Index(
    "idx_role_permission_permission_id", RolePermissionLink.__table__.c.permission_id
)
sa.Index("idx_role_permission_role_id", RolePermissionLink.__table__.c.role_id)


class ResourcePermissionLink(SQLModel, table=True):
    """Relation between resources and permissions."""

    __tablename__ = "resource_permission"
    __table_args__ = {"schema": settings.SCHEMA}

    id: Optional[int] = Field(
        sa_column=Column(Integer, primary_key=True, autoincrement=True)
    )
    resource_id: Optional[UUID] = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.resource.id", ondelete="CASCADE"),
            nullable=False,
        ),
    )
    permission_id: Optional[UUID] = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.permission.id", ondelete="CASCADE"),
            nullable=False,
        ),
    )


sa.Index(
    "idx_resource_permission",
    ResourcePermissionLink.__table__.c.resource_id,
    ResourcePermissionLink.__table__.c.permission_id,
    unique=True,
)
sa.Index(
    "idx_resource_permission_permission_id",
    ResourcePermissionLink.__table__.c.permission_id,
)
sa.Index(
    "idx_resource_permission_resource_id",
    ResourcePermissionLink.__table__.c.resource_id,
)


class UserRoleLink(SQLModel, table=True):
    """Relation between users and roles."""

    __tablename__ = "user_role"
    __table_args__ = {"schema": settings.SCHEMA}

    id: Optional[int] = Field(
        sa_column=Column(Integer, primary_key=True, autoincrement=True)
    )
    role_id: Optional[UUID] = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.role.id", ondelete="CASCADE"),
            nullable=False,
        )
    )
    user_id: Optional[UUID] = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.user.id", ondelete="CASCADE"),
            nullable=False,
        )
    )

    # Relationships
    role: "Role" = Relationship(back_populates="user_links")
    user: "User" = Relationship(back_populates="role_links")


sa.Index(
    "idx_user_role",
    UserRoleLink.__table__.c.user_id,
    UserRoleLink.__table__.c.role_id,
    unique=True,
)
sa.Index("idx_user_role_role_id", UserRoleLink.__table__.c.role_id)
sa.Index("idx_user_role_user_id", UserRoleLink.__table__.c.user_id)


# ---------------------------------------------------------------------------
# Secondary indexes on the shared link tables. Declared here so the squash
# baseline / autogenerate matches the indexes present in the database.
# ---------------------------------------------------------------------------
sa.Index(
    "idx_user_team", UserTeamLink.__table__.c.user_id, UserTeamLink.__table__.c.team_id
)
sa.Index("idx_user_team_team_id", UserTeamLink.__table__.c.team_id)
sa.Index("idx_user_team_user_id", UserTeamLink.__table__.c.user_id)

sa.Index(
    "idx_resource_grant_resource",
    ResourceGrant.__table__.c.resource_type,
    ResourceGrant.__table__.c.resource_id,
)
sa.Index(
    "idx_resource_grant_grantee",
    ResourceGrant.__table__.c.grantee_type,
    ResourceGrant.__table__.c.grantee_id,
)


class BundleLayerLink(SQLModel, table=True):
    """Membership of a layer within a bundle, tagged with the role the
    layer plays in it (e.g. 'edges', 'stops').

    One bundle per layer (``UNIQUE(layer_id)``) and at most one layer per
    ``(bundle_id, role)`` — Postgres treats NULL roles as distinct, so
    unassigned members are allowed while each named role is filled once. Both FKs
    cascade, so deleting either side drops the membership row.
    """

    __tablename__ = "bundle_layer"
    __table_args__ = (
        UniqueConstraint("layer_id", name="uq_bundle_layer_layer"),
        UniqueConstraint("bundle_id", "role", name="uq_bundle_layer_role"),
        {"schema": settings.SCHEMA},
    )

    id: Optional[int] = Field(
        sa_column=Column(Integer, primary_key=True, autoincrement=True)
    )
    bundle_id: UUID = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.bundle.id", ondelete="CASCADE"),
            nullable=False,
        )
    )
    layer_id: UUID = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.layer.id", ondelete="CASCADE"),
            nullable=False,
        )
    )
    role: Optional[str] = Field(
        default=None,
        sa_column=Column(Text, nullable=True),
        description="Role the layer plays within the bundle (a spec role key)",
    )

    # Relationships
    bundle: "Bundle" = Relationship(back_populates="layer_links")
    layer: "Layer" = Relationship(
        back_populates="bundle_link",
        sa_relationship_kwargs={"uselist": False},
    )


class BundleDependencyLink(SQLModel, table=True):
    """A dependency of one bundle on another.

    e.g. a GTFS bundle depends on a street network bundle to build its routable
    graph and stop-to-street mapping. One dependency per
    ``(bundle_id, dependency_kind)``; both FKs point at
    ``bundle`` and cascade.
    """

    __tablename__ = "bundle_dependency"
    __table_args__ = (
        UniqueConstraint(
            "bundle_id",
            "dependency_kind",
            name="uq_bundle_dependency_kind",
        ),
        {"schema": settings.SCHEMA},
    )

    id: Optional[int] = Field(
        sa_column=Column(Integer, primary_key=True, autoincrement=True)
    )
    bundle_id: UUID = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.bundle.id", ondelete="CASCADE"),
            nullable=False,
        ),
        description="The dependent bundle (e.g. the GTFS bundle)",
    )
    depends_on_bundle_id: UUID = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.bundle.id", ondelete="CASCADE"),
            nullable=False,
        ),
        description="The bundle depended on (e.g. the street network bundle)",
    )
    dependency_kind: str = Field(
        sa_column=Column(Text, nullable=False),
        description="Dependency slot (a spec dependency kind, e.g. 'street_network')",
    )
    built_revision: Optional[int] = Field(
        default=None,
        sa_column=Column(Integer, nullable=True),
        description=(
            "The dependency's layers_revision at the time this bundle's "
            "artifacts were last built from it. Compared with that bundle's "
            "current layers_revision to derive whether they are still current; "
            "null means linked but never built from — which is what a fresh "
            "link is, so re-pointing a bundle at another one invalidates on "
            "its own"
        ),
    )

    # Two FKs to bundle -> relationships must name their foreign key.
    bundle: "Bundle" = Relationship(
        back_populates="dependency_links",
        sa_relationship_kwargs={"foreign_keys": "[BundleDependencyLink.bundle_id]"},
    )
    depends_on_bundle: "Bundle" = Relationship(
        back_populates="dependent_links",
        sa_relationship_kwargs={
            "foreign_keys": "[BundleDependencyLink.depends_on_bundle_id]"
        },
    )


# No index on bundle_id alone: uq_bundle_dependency_kind (bundle_id,
# dependency_kind) already indexes it as the leading column. The reverse
# direction (finding dependents of a bundle) is not covered by that, so it
# keeps its own index.
sa.Index(
    "idx_bundle_dependency_depends_on",
    BundleDependencyLink.__table__.c.depends_on_bundle_id,
)


class ContentTransfer(SQLModel, table=True):
    """Audit row for one top-level item moved by transfer (D3, D6,
    D14): who moved what, from which space to which. ``details`` carries at
    least ``{"status": "pending" | "done"}``, written before the move's
    UPDATEs run and flipped to "done" once every step (moves, grants,
    shortcuts) has completed — a crash between the two leaves a "pending"
    row that says what was in flight.
    """

    __tablename__ = "content_transfer"
    __table_args__ = (
        Index("idx_content_transfer_item", "item_type", "item_id"),
        {"schema": settings.SCHEMA},
    )

    id: UUID | None = Field(
        default=None,
        sa_column=Column(
            UUID_PG(as_uuid=True),
            primary_key=True,
            server_default=sa.text("uuid_generate_v4()"),
        ),
    )
    item_type: str = Field(sa_column=Column(Text, nullable=False))
    item_id: UUID = Field(sa_column=Column(UUID_PG(as_uuid=True), nullable=False))
    from_space_id: UUID | None = Field(
        default=None,
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.space.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    to_space_id: UUID | None = Field(
        default=None,
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.space.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    actor_id: UUID | None = Field(
        default=None,
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.user.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    details: Dict[str, Any] = Field(
        default_factory=dict,
        sa_column=Column(JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
    )
    created_at: Optional[Any] = Field(
        default=None,
        sa_column=Column(
            sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
    )


class ContentShortcut(SQLModel, table=True):
    """A badged pointer left in the source folder after a transfer, when the
    caller asked to ``leave_shortcut``. One per (space, folder, target) —
    transferring the same item twice from the same folder does not stack
    shortcuts.
    """

    __tablename__ = "content_shortcut"
    __table_args__ = (
        UniqueConstraint(
            "space_id",
            "folder_id",
            "target_type",
            "target_id",
            name="content_shortcut_unique",
        ),
        {"schema": settings.SCHEMA},
    )

    id: UUID | None = Field(
        default=None,
        sa_column=Column(
            UUID_PG(as_uuid=True),
            primary_key=True,
            server_default=sa.text("uuid_generate_v4()"),
        ),
    )
    space_id: UUID = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.space.id", ondelete="CASCADE"),
            nullable=False,
        )
    )
    folder_id: UUID | None = Field(
        default=None,
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.folder.id", ondelete="CASCADE"),
            nullable=True,
        ),
    )
    target_type: str = Field(sa_column=Column(Text, nullable=False))
    target_id: UUID = Field(sa_column=Column(UUID_PG(as_uuid=True), nullable=False))
    created_by: UUID | None = Field(
        default=None,
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.user.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    created_at: Optional[Any] = Field(
        default=None,
        sa_column=Column(
            sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
    )
