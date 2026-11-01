"""Usage counts: every organization's `used_projects` and `used_storage`
counted from its projects and layers, by the rule the triggers
log_project_count and log_storage_usage follow.

A project or layer is the organization's of its creator; when the creator's
account was removed (`user_id` NULL), of the space it lives in: the
organization's own space, one of its teams' spaces or a member's personal
space. `used_projects` counts its projects without the hidden copies of
project templates (`is_template_source`), the projects in the trash
included. `used_storage` is the size of its layers in MB (bytes / 1048576, as
the trigger adds them), the layers in the trash included; a catalog layer has
no creator and no space and counts for nobody. An organization without any
counts 0.

The triggers are installed by core.scripts.initial_data, which every deploy
runs after the migrations. Downgrade: nothing to undo, the counts are derived
data.

Revision ID: 0020_project_count
Revises: 0019_ai_credits
"""

from alembic import op
from core.core.config import settings

revision = "0020_project_count"
down_revision = "0019_ai_credits"
branch_labels = None
depends_on = None

S = settings.SCHEMA

#: The organization of a project or layer `x`: the creator's, else its space's.
_OWNER = """
    LEFT JOIN "{s}"."user" creator ON creator.id = x.user_id
    LEFT JOIN "{s}".space s ON s.id = x.space_id
    LEFT JOIN "{s}".team t ON t.id = s.team_id
    LEFT JOIN "{s}"."user" member ON member.id = s.user_id
"""
_ORGANIZATION = (
    "COALESCE(creator.organization_id, s.organization_id, t.organization_id, "
    "member.organization_id)"
)

#: Every organization's counts in one pass over the projects and one over the
#: layers; an organization without any gets 0. The counts are materialized
#: once, so the lookup per organization reads them instead of the tables.
RECOUNT = f"""
WITH projects AS MATERIALIZED (
    SELECT {_ORGANIZATION} AS organization_id, count(*) AS n
    FROM "{{s}}".project x
    {_OWNER}
    WHERE NOT x.is_template_source
    GROUP BY 1
),
storage AS MATERIALIZED (
    SELECT {_ORGANIZATION} AS organization_id,
           COALESCE(sum(x.size), 0) / 1048576::float AS mb
    FROM "{{s}}".layer x
    {_OWNER}
    GROUP BY 1
)
UPDATE "{{s}}".organization o
SET used_projects = COALESCE(
        (SELECT p.n FROM projects p WHERE p.organization_id = o.id), 0),
    used_storage = COALESCE(
        (SELECT st.mb FROM storage st WHERE st.organization_id = o.id), 0)
"""


def upgrade() -> None:
    op.execute(RECOUNT.format(s=S))


def downgrade() -> None:
    pass
