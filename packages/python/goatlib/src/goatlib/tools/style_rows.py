"""The style rows of layers goatlib writes (spec 10), with asyncpg.

A dataset has one default style; a project layer starts with one named style,
"Default", copied from it, active, with its revision 1 row. core writes the same
rows with its own driver (`core.services.style`); both meet the same schema
rules (one default per dataset, one active style per project layer).

Documents are sent as text and cast, so the statements work on connections with
or without a JSONB codec.
"""

import json
from typing import Any

#: The name of a dataset's default style and of a project layer's first style.
DEFAULT_NAME = "Default"


async def insert_dataset_default(
    conn: Any, schema: str, layer_id: Any, document: dict[str, Any]
) -> None:
    """The dataset's default style row, unless it has one."""
    await conn.execute(
        f"INSERT INTO {schema}.layer_style (layer_id, name, document) "
        "VALUES ($1, $2, $3::text::jsonb) "
        "ON CONFLICT (layer_id) WHERE layer_id IS NOT NULL DO NOTHING",
        layer_id,
        DEFAULT_NAME,
        json.dumps(document),
    )


async def insert_first_style(
    conn: Any, schema: str, link_id: int, document: dict[str, Any] | None = None
) -> None:
    """The project layer's first style, active: `document`, else a copy of its
    dataset's default. Nothing for a project layer that has styles already, or
    whose dataset has no default (a table)."""
    await conn.execute(
        f"""
        WITH doc AS (
            SELECT coalesce(
                $2::text::jsonb,
                (SELECT d.document FROM {schema}.layer_style d
                 JOIN {schema}.layer_project lp ON d.layer_id = lp.layer_id
                 WHERE lp.id = $1)
            ) AS document
        ),
        ins AS (
            INSERT INTO {schema}.layer_style
                (layer_project_id, name, position, document, revision)
            SELECT $1, $3, 0, document, 1 FROM doc
            WHERE document IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM {schema}.layer_style s WHERE s.layer_project_id = $1
              )
            RETURNING id, document
        ),
        rev AS (
            INSERT INTO {schema}.layer_style_revision (style_id, revision, document)
            SELECT id, 1, document FROM ins
        )
        UPDATE {schema}.layer_project lp SET active_style_id = ins.id
        FROM ins WHERE lp.id = $1
        """,
        link_id,
        json.dumps(document) if document is not None else None,
        DEFAULT_NAME,
    )
