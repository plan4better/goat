from datetime import datetime
from typing import Any, Dict
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, TIMESTAMP
from sqlalchemy.dialects.postgresql import UUID as UUID_PG
from sqlmodel import Column, Field, SQLModel

from core.core.config import settings


class LayerStyle(SQLModel, table=True):
    """A GOAT Style document (spec 10): a named style of a project layer, or the
    default style of a dataset.

    A project layer has up to ten named styles, one of them active
    (`layer_project.active_style_id`); a dataset has at most one default, which a
    project layer's first style is copied from. The document is stored whole and
    written by one conditional statement on `revision` (spec 13.1).
    """

    __tablename__ = "layer_style"
    __table_args__ = (
        CheckConstraint(
            "(layer_project_id IS NULL) <> (layer_id IS NULL)",
            name="layer_style_owner_check",
        ),
        Index(
            "layer_style_layer_id_key",
            "layer_id",
            unique=True,
            postgresql_where=text("layer_id IS NOT NULL"),
        ),
        Index("layer_style_layer_project_position_idx", "layer_project_id", "position"),
        {"schema": settings.SCHEMA},
    )

    id: UUID | None = Field(
        default=None,
        sa_column=Column(
            UUID_PG(as_uuid=True),
            primary_key=True,
            nullable=False,
            server_default=text("uuid_generate_v4()"),
        ),
    )
    layer_project_id: int | None = Field(
        default=None,
        sa_column=Column(
            Integer,
            ForeignKey(f"{settings.SCHEMA}.layer_project.id", ondelete="CASCADE"),
            nullable=True,
        ),
    )
    layer_id: UUID | None = Field(
        default=None,
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.layer.id", ondelete="CASCADE"),
            nullable=True,
        ),
    )
    name: str = Field(sa_column=Column(Text, nullable=False))
    position: int = Field(
        default=0,
        sa_column=Column(SmallInteger, nullable=False, server_default=text("0")),
    )
    document: Dict[str, Any] = Field(sa_column=Column(JSONB, nullable=False))
    revision: int = Field(
        default=1, sa_column=Column(Integer, nullable=False, server_default=text("1"))
    )
    created_at: datetime | None = Field(
        default=None,
        sa_column=Column(
            TIMESTAMP(timezone=True), nullable=False, server_default=text("now()")
        ),
    )
    updated_at: datetime | None = Field(
        default=None,
        sa_column=Column(
            TIMESTAMP(timezone=True), nullable=False, server_default=text("now()")
        ),
    )
    updated_by: UUID | None = Field(
        default=None, sa_column=Column(UUID_PG(as_uuid=True), nullable=True)
    )


class LayerStyleRevision(SQLModel, table=True):
    """The last documents of a named style, kept only to merge a save that is
    based on an older revision (spec 13.1: twenty per style). Undo and redo stay
    in the browser; this is no history."""

    __tablename__ = "layer_style_revision"
    __table_args__ = {"schema": settings.SCHEMA}

    style_id: UUID = Field(
        sa_column=Column(
            UUID_PG(as_uuid=True),
            ForeignKey(f"{settings.SCHEMA}.layer_style.id", ondelete="CASCADE"),
            primary_key=True,
            nullable=False,
        )
    )
    revision: int = Field(sa_column=Column(Integer, primary_key=True, nullable=False))
    document: Dict[str, Any] = Field(sa_column=Column(JSONB, nullable=False))
    created_at: datetime | None = Field(
        default=None,
        sa_column=Column(
            TIMESTAMP(timezone=True), nullable=False, server_default=text("now()")
        ),
    )


class DataSnapshotCursor(SQLModel, table=True):
    """How far the DuckLake change log has been read into `layer.data_snapshot`
    (spec 12): one row, moved by goatlib's `advance_data_snapshots_sql`."""

    __tablename__ = "data_snapshot_cursor"
    __table_args__ = (
        CheckConstraint("id = 1", name="data_snapshot_cursor_one_row"),
        {"schema": settings.SCHEMA},
    )

    id: int = Field(default=1, sa_column=Column(SmallInteger, primary_key=True))
    snapshot_id: int = Field(
        default=0,
        sa_column=Column(BigInteger, nullable=False, server_default=text("0")),
    )


class StyleMigrationUndo(SQLModel, table=True):
    """The original `config` of the rows migration 0013 rewrote in place (workflow
    and template `outputStyle`, layout and template `locked_layer_styles`), so its
    downgrade can restore them. Dropped with the `properties` columns one release
    after the switch."""

    __tablename__ = "style_migration_undo"
    __table_args__ = {"schema": settings.SCHEMA}

    table_name: str = Field(sa_column=Column(Text, primary_key=True, nullable=False))
    row_id: str = Field(sa_column=Column(Text, primary_key=True, nullable=False))
    config: Dict[str, Any] = Field(sa_column=Column(JSONB, nullable=False))
