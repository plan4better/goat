"""Bundles, catalog identity, and the legacy layer/scenario columns.

What an `init`-era database gains here:

* the bundle schema — `bundle_type`, `bundle`, `bundle_artifact`,
  `bundle_dependency`, `bundle_layer` — and the `bundle_id` back-reference on
  `layer_project_group`. A bundle is several member layers acquired and
  managed as one unit (a GTFS feed, an Overture street-network extract);
* `layer.catalog_external_uid` and `layer.catalog_version`: which catalog item
  a promoted layer came from and at which version, with the partial unique
  index over the pair that makes promote-on-use idempotent;
* the removal of seventeen nullable `layer` columns, `customer.data_store`,
  `project.active_scenario_id` and the three scenario tables — all left over
  from things GOAT no longer has (the old catalog page with its filter
  vocabulary, the shared-wide-table storage layout that `attribute_mapping`
  translated, an upload path that no longer records what it did, and
  scenarios), together with `customer.job`, `job_test`, `report`, `status` and
  `system_task`: job execution and its history belong to the `processes`
  service, `report_layout` replaced `report`, and nothing reads the rest.
  `organization.odoo_company_id` and `user.odoo_contact_id` are
  deliberately left alone: no revision here creates them and no model declares
  them, so they exist only on a database carrying the unmerged Odoo work, and
  dropping them would take its mapping with them;
* nullable `layer.user_id` / `layer.folder_id`, with every promoted catalog
  layer set to NULL on both and the synthetic `catalog@goat.local` identity
  (its user, folders, roles and `GOAT Catalog` organization) deleted. A catalog
  dataset belongs to the provider that published it, not to anyone here.

`layer.tool_type` and `layer.job_id` stay: nothing reads them, but they record
which tool and which Windmill job produced a layer, across most of the table.
`layer.in_catalog` stays: `check_layer` still grants access through it.

A fresh database is built by `init` from the current models, so it already has
every object created here and none of the dropped ones. Every statement is
guarded, so the whole revision passes through it unchanged.

`bundle.space_id` is the one column of `bundle` this revision does not create:
`customer.space` does not exist until `0004_spaces`, which adds the column,
backfills it and makes it NOT NULL.

Order matters at the end: `layer.folder_id` is `ON DELETE CASCADE`, so the
catalog layers are detached from the synthetic folder **before** that folder
and its user are removed. Dropping the folder first would take the layers with
it, and they are live in users' projects.

Revision ID: 0001_bundles_catalog
Revises: init
"""

import sys
from pathlib import Path

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from core.core.config import settings

_ALEMBIC_DIR = str(Path(__file__).resolve().parents[1])
if _ALEMBIC_DIR not in sys.path:
    sys.path.append(_ALEMBIC_DIR)

import helpers as h  # noqa: E402

revision = "0001_bundles_catalog"
down_revision = "init"
branch_labels = None
depends_on = None

S = settings.SCHEMA

_CREATED_AT_DEFAULT = sa.text(
    "to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', "
    "'YYYY-MM-DD\"T\"HH24:MI:SSOF')::timestamptz"
)

# The old catalog's metadata vocabulary, the generic-column scheme and the
# vestigial upload / data-store fields.
_LEGACY_LAYER_COLUMNS = (
    "lineage",
    "positional_accuracy",
    "attribute_accuracy",
    "completeness",
    "geographical_code",
    "language_code",
    "distributor_name",
    "distributor_email",
    "distribution_url",
    "license",
    "attribution",
    "data_reference_year",
    "data_category",
    "attribute_mapping",
    "upload_reference_system",
    "upload_file_type",
    "data_store_id",
)

# The eight columns `customer.bundle` used to carry, folded into one document.
_BUNDLE_PROVENANCE = (
    "lineage",
    "geographical_code",
    "distributor_name",
    "distributor_email",
    "distribution_url",
    "license",
    "attribution",
    "data_reference_year",
)

# Children first: `scenario_scenario_feature` references both of the others.
_SCENARIO_TABLES = ("scenario_scenario_feature", "scenario_feature", "scenario")

# No model declares these and nothing reads them. Nothing references them
# either, so they drop in any order.
_DEAD_TABLES = ("job", "job_test", "report", "status", "system_task")


def _create_bundle_tables() -> None:
    if not h.table_exists("bundle_type", S):
        op.create_table(
            "bundle_type",
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=_CREATED_AT_DEFAULT,
                nullable=False,
            ),
            sa.Column("type", sa.Text(), nullable=False),
            sa.Column("name", sa.Text(), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column(
                "structure", postgresql.JSONB(astext_type=sa.Text()), nullable=False
            ),
            sa.PrimaryKeyConstraint("type"),
            schema=S,
        )

    if not h.table_exists("bundle", S):
        op.create_table(
            "bundle",
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=_CREATED_AT_DEFAULT,
                nullable=False,
            ),
            sa.Column("folder_id", sa.UUID(), nullable=False),
            sa.Column("name", sa.Text(), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column(
                "id",
                sa.UUID(),
                server_default=sa.text("uuid_generate_v4()"),
                nullable=False,
            ),
            # "created by": survives the user being deleted.
            sa.Column("user_id", sa.UUID(), nullable=True),
            sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column(
                "restricted",
                sa.Boolean(),
                server_default=sa.text("false"),
                nullable=False,
            ),
            sa.Column("bundle_type", sa.Text(), nullable=False),
            sa.Column("thumbnail_url", sa.Text(), nullable=True),
            # Dataset-level provenance as one document rather than a column
            # each: nothing filters or joins on these, importers already
            # produce a sparse dict, and a source that starts stating a new
            # field costs no migration.
            sa.Column(
                "dataset_metadata",
                postgresql.JSONB(astext_type=sa.Text()),
                nullable=True,
            ),
            sa.Column("status", sa.Text(), server_default="processing", nullable=False),
            # Bumped on every member-layer edit; artifact builds record the
            # revision they read and publish only if it is still current.
            sa.Column(
                "layers_revision", sa.Integer(), server_default="0", nullable=False
            ),
            sa.ForeignKeyConstraint(
                ["bundle_type"], [f"{S}.bundle_type.type"], ondelete="RESTRICT"
            ),
            sa.ForeignKeyConstraint(
                ["folder_id"], [f"{S}.folder.id"], ondelete="CASCADE"
            ),
            sa.ForeignKeyConstraint(["user_id"], [f"{S}.user.id"], ondelete="SET NULL"),
            sa.PrimaryKeyConstraint("id"),
            schema=S,
        )
    h.create_index_if_missing(
        "ix_customer_bundle_bundle_type", "bundle", ["bundle_type"], S
    )

    if not h.table_exists("bundle_artifact", S):
        op.create_table(
            "bundle_artifact",
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=_CREATED_AT_DEFAULT,
                nullable=False,
            ),
            sa.Column(
                "id",
                sa.UUID(),
                server_default=sa.text("uuid_generate_v4()"),
                nullable=False,
            ),
            sa.Column("bundle_id", sa.UUID(), nullable=False),
            sa.Column("kind", sa.Text(), nullable=False),
            # What the last build attempt did. Whether the artifact may be
            # routed on is derived from this, `revision` against the bundle's
            # `layers_revision`, and whether a file is there — see
            # goatlib.models.bundle.artifact_state.
            sa.Column("build_status", sa.Text(), nullable=False),
            # Path on the bundles data volume, relative to the data dir.
            sa.Column("storage_path", sa.Text(), nullable=True),
            sa.Column("size", sa.BigInteger(), nullable=True),
            sa.Column("job_id", sa.UUID(), nullable=True),
            # bundle.layers_revision the build read its member layers at.
            sa.Column("revision", sa.Integer(), nullable=True),
            sa.ForeignKeyConstraint(
                ["bundle_id"], [f"{S}.bundle.id"], ondelete="CASCADE"
            ),
            sa.PrimaryKeyConstraint("id"),
            # (bundle_id, kind) is unique and indexes bundle_id as its leading
            # column, so bundle_id needs no separate index.
            sa.UniqueConstraint("bundle_id", "kind", name="uq_bundle_artifact_kind"),
            schema=S,
        )

    if not h.table_exists("bundle_dependency", S):
        op.create_table(
            "bundle_dependency",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("bundle_id", sa.UUID(), nullable=False),
            sa.Column("depends_on_bundle_id", sa.UUID(), nullable=False),
            sa.Column("dependency_kind", sa.Text(), nullable=False),
            sa.ForeignKeyConstraint(
                ["bundle_id"], [f"{S}.bundle.id"], ondelete="CASCADE"
            ),
            sa.ForeignKeyConstraint(
                ["depends_on_bundle_id"], [f"{S}.bundle.id"], ondelete="CASCADE"
            ),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint(
                "bundle_id", "dependency_kind", name="uq_bundle_dependency_kind"
            ),
            schema=S,
        )
    # Reverse lookup (dependents of a bundle) is not covered by the unique
    # constraint's leading column, so it keeps its own index.
    h.create_index_if_missing(
        "idx_bundle_dependency_depends_on",
        "bundle_dependency",
        ["depends_on_bundle_id"],
        S,
    )

    if not h.table_exists("bundle_layer", S):
        op.create_table(
            "bundle_layer",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("bundle_id", sa.UUID(), nullable=False),
            sa.Column("layer_id", sa.UUID(), nullable=False),
            sa.Column("role", sa.Text(), nullable=True),
            sa.ForeignKeyConstraint(
                ["bundle_id"], [f"{S}.bundle.id"], ondelete="CASCADE"
            ),
            sa.ForeignKeyConstraint(
                ["layer_id"], [f"{S}.layer.id"], ondelete="CASCADE"
            ),
            sa.PrimaryKeyConstraint("id"),
            # (bundle_id, role) unique indexes bundle_id as its leading column.
            sa.UniqueConstraint("bundle_id", "role", name="uq_bundle_layer_role"),
            sa.UniqueConstraint("layer_id", name="uq_bundle_layer_layer"),
            schema=S,
        )

    # Back-reference on the project layer group: a group that holds a bundle's
    # layers (locked membership).
    h.add_column_if_missing(
        "layer_project_group", sa.Column("bundle_id", sa.UUID(), nullable=True), S
    )
    h.create_index_if_missing(
        "ix_customer_layer_project_group_bundle_id",
        "layer_project_group",
        ["bundle_id"],
        S,
    )
    h.ensure_fk(
        "layer_project_group_bundle_id_fkey",
        "layer_project_group",
        "bundle",
        ["bundle_id"],
        ["id"],
        S,
        ondelete="CASCADE",
    )


def _fold_bundle_provenance() -> None:
    """Move the eight flat provenance columns into `dataset_metadata`.

    Only reachable on a database that created `bundle` with those columns; a
    database that gets `bundle` from this revision or from `init` arrives with
    `dataset_metadata` already and skips the move.
    """
    if not h.table_exists("bundle", S):
        return
    present = [c for c in _BUNDLE_PROVENANCE if h.column_exists("bundle", c, S)]
    if not h.column_exists("bundle", "dataset_metadata", S):
        op.add_column(
            "bundle",
            sa.Column("dataset_metadata", postgresql.JSONB(astext_type=sa.Text())),
            schema=S,
        )
        # jsonb_strip_nulls so an untouched bundle gets `{}`, not eight nulls.
        if present:
            pairs = ", ".join(f"'{c}', {c}" for c in present)
            op.execute(
                f"""
                UPDATE {S}.bundle
                SET dataset_metadata = jsonb_strip_nulls(jsonb_build_object({pairs}))
                """
            )
    for name in present:
        op.drop_column("bundle", name, schema=S)
    # Never read or written anywhere.
    h.drop_column_if_present("bundle", "properties", S)


def _bundle_status_shape() -> None:
    """Bring a pre-existing `bundle`/`bundle_artifact` pair to the current shape.

    A database that got both tables from `_create_bundle_tables` above, or from
    `init`, already has this shape and every statement here is skipped. One that
    carried the tables before them needs three things.

    `bundle_artifact.status` becomes `build_status`. The old column conflated
    what the last build did with whether the artifact still matches the layers,
    and only the first is a fact the row can hold: the second is `revision`
    against the bundle's `layers_revision`, so storing it as well meant a second
    write on every layer change, and one missed write meant routing on a graph
    that no longer matched the data. `ready` and `stale` both meant a build
    completed and become `complete`. `pending` meant a row existed before
    anything was built; nothing creates that state now (the row is written when
    a build starts), so those become `failed`, which is how the UI offers the
    way back.

    A `ready` row is stamped with the bundle's current `layers_revision` first.
    Currency is derived from the revisions now, and artifacts built by an import
    never recorded one — without this they would all read `outdated`, and a
    bundle whose artifacts cannot be rebuilt from its member layers (GTFS) would
    have no way back but a re-import.

    `bundle.status` defaults to `processing`. The row is committed before its
    import job runs — it is the foreign key its member layers and dependencies
    point at — so it exists holding nothing until the job finishes, and
    defaulting to `ready` claimed the opposite. `status` also loses its `failed`
    value in this release: an import that fails deletes its own bundle, because
    nothing can complete a half-ingested one and the job carries the failure.
    Rows written by earlier releases are left alone — they still read back (the
    column is text) and removing them is an operator's decision:

        DELETE FROM customer.bundle WHERE status = 'failed';
    """
    h.add_column_if_missing(
        "bundle",
        sa.Column("layers_revision", sa.Integer(), server_default="0", nullable=False),
        S,
    )
    h.add_column_if_missing(
        "bundle_artifact", sa.Column("revision", sa.Integer(), nullable=True), S
    )

    if h.column_exists("bundle_artifact", "status", S) and not h.column_exists(
        "bundle_artifact", "build_status", S
    ):
        op.alter_column(
            "bundle_artifact",
            "status",
            new_column_name="build_status",
            server_default=None,
            schema=S,
        )
        op.execute(
            f"""
            UPDATE {S}.bundle_artifact a
            SET revision = b.layers_revision
            FROM {S}.bundle b
            WHERE b.id = a.bundle_id
              AND a.build_status = 'ready'
              AND a.revision IS NULL
            """
        )
        op.execute(
            f"""
            UPDATE {S}.bundle_artifact
            SET build_status = CASE build_status
                WHEN 'ready' THEN 'complete'
                WHEN 'stale' THEN 'complete'
                WHEN 'pending' THEN 'failed'
                ELSE build_status
            END
            """
        )

    if h.column_exists("bundle", "status", S):
        op.execute(
            f"ALTER TABLE {S}.bundle ALTER COLUMN status SET DEFAULT 'processing'"
        )


def upgrade() -> None:
    # Every ALTER and DROP on customer.layer below takes ACCESS EXCLUSIVE until
    # this revision commits. The statements are metadata-only and fast,
    # but *acquiring* the lock is not: one long-lived reader (a pinned geoapi
    # connection, a running tool) blocks it, and then every query on the table
    # queues behind the waiting migration. Fail fast instead and let the
    # operator retry — set before the first lock this revision takes. LOCAL:
    # behind a transaction pooler a session setting would outlive the
    # migration on a server connection other clients get next.
    op.execute("SET LOCAL lock_timeout = '5s'")

    _create_bundle_tables()
    _bundle_status_shape()

    h.add_column_if_missing(
        "layer", sa.Column("catalog_external_uid", sa.Text(), nullable=True), S
    )
    h.add_column_if_missing(
        "layer", sa.Column("catalog_version", sa.Text(), nullable=True), S
    )
    # The arbiter of promote-on-use: catalog_promote inserts with
    # ON CONFLICT (catalog_external_uid, catalog_version) WHERE
    # catalog_external_uid IS NOT NULL, which resolves to this index and to no
    # other. The predicate is the same one the model declares.
    h.create_index_if_missing(
        "uq_layer_catalog_identity",
        "layer",
        ["catalog_external_uid", "catalog_version"],
        S,
        unique=True,
        postgresql_where=sa.text("catalog_external_uid IS NOT NULL"),
    )

    h.drop_constraint_if_present(
        "layer_data_store_id_fkey", "layer", S, type_="foreignkey"
    )
    for name in _LEGACY_LAYER_COLUMNS:
        h.drop_column_if_present("layer", name, S)

    # After the FK column, so the drop cannot fail on a dependency.
    h.drop_table_if_present("data_store", S)

    h.drop_column_if_present("project", "active_scenario_id", S)
    for name in _SCENARIO_TABLES:
        h.drop_table_if_present(name, S)

    for name in _DEAD_TABLES:
        h.drop_table_if_present(name, S)

    _fold_bundle_provenance()

    # A catalog layer belongs to the provider that published it, not to anyone
    # here, so it gets no owner.
    h.alter_column_nullable("layer", "user_id", S, nullable=True)
    h.alter_column_nullable("layer", "folder_id", S, nullable=True)
    op.execute(
        f"""
        UPDATE {S}.layer
        SET user_id = NULL, folder_id = NULL
        WHERE catalog_external_uid IS NOT NULL
        """
    )

    # Detached first: layer.folder_id is ON DELETE CASCADE, so removing the
    # folder while rows still point at it would delete layers that are live in
    # users' projects.
    op.execute(
        f"""
        WITH identity AS (
            SELECT id, organization_id FROM {S}."user"
            WHERE email = 'catalog@goat.local'
        ),
        dropped_folders AS (
            DELETE FROM {S}.folder
            WHERE user_id IN (SELECT id FROM identity)
        ),
        dropped_roles AS (
            DELETE FROM {S}.user_role
            WHERE user_id IN (SELECT id FROM identity)
        ),
        dropped_user AS (
            DELETE FROM {S}."user" WHERE id IN (SELECT id FROM identity)
        )
        DELETE FROM {S}.organization o
        WHERE o.id IN (SELECT organization_id FROM identity WHERE organization_id IS NOT NULL)
          -- Only if the synthetic user was its sole member. `user.organization_id`
          -- is ON DELETE CASCADE, so deleting an organization deletes everyone in
          -- it along with all their content; if someone was ever added to this
          -- one by hand, leave the organization behind rather than take them
          -- with it.
          AND NOT EXISTS (
              SELECT 1 FROM {S}."user" u
              WHERE u.organization_id = o.id
                AND u.id NOT IN (SELECT id FROM identity)
          )
        """
    )


def downgrade() -> None:
    raise NotImplementedError(
        "downgrade is not supported for the consolidated migrations"
    )
