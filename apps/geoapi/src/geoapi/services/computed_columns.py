"""Helpers for handling computed columns within feature_write_service.

`parse_computed_columns` turns the layer's `field_config` JSONB blob
into a list of specs (name + dependency-set + compute SQL fragment).
`select_recompute_specs` filters those specs against a set of changed
source columns. `fetch_field_config` reads the JSONB from PG.

This module knows nothing about HTTP. Task D1 wires these helpers into
INSERT/UPDATE statements on customer layer tables.
"""

import json
import logging
from typing import Any
from uuid import UUID

import asyncpg
from goatlib.utils.field_config import (
    DEPENDS_ON_ANY,
    ComputedColumnSpec,
    allowed_value_columns,
    column_defaults,
)

logger = logging.getLogger(__name__)


def apply_defaults(
    field_config: dict[str, Any] | None,
    properties: dict[str, Any],
    blank_is_absent: bool = False,
) -> dict[str, Any]:
    """Fill in what a feature did not state. Returns a new dict.

    Creation only, for the per-feature paths. An update that omits a column
    means "leave it alone", so applying defaults there would silently reset
    columns the caller never mentioned.

    ``blank_is_absent`` is the second rule, for a write that replaces a row
    whole: a null or an empty string then means the column was left blank
    rather than deliberately cleared, so it takes the default too. The bundle
    editor writes that way — it sends the whole edge back on every save, and an
    edge with no class is not a routable street. Without the flag an explicit
    null stays null, because clearing a column is a choice and a default that
    overrode it could not be cleared at all.

    This is the only thing that applies a default. A column created with one
    also carries a DuckDB ``DEFAULT``, which would cover an INSERT that omitted
    it, but every write goes through here and names the column explicitly — so
    the ``field_config`` entry is the default of record and the DDL default is
    never consulted.
    """
    return fill_defaults(
        column_defaults(field_config), properties, blank_is_absent=blank_is_absent
    )


def fill_defaults(
    defaults: dict[str, Any],
    properties: dict[str, Any],
    blank_is_absent: bool = False,
) -> dict[str, Any]:
    """``apply_defaults`` against an already-derived default map.

    Separate so a bulk write derives the map once for the whole request rather
    than once per feature.
    """
    filled = dict(properties)
    for name, value in defaults.items():
        if name not in filled or (blank_is_absent and filled[name] in (None, "")):
            filled[name] = value
    return filled


def validate_allowed_values(
    field_config: dict[str, Any] | None, properties: dict[str, Any]
) -> None:
    """Refuse a write that sets a constrained column to something else.

    Refused rather than dropped, which is how a computed or locked column is
    handled: those the caller was never invited to set, so ignoring the value is
    right. Here the caller *is* invited to set it and got it wrong, and silently
    keeping the old value would look like a successful edit.

    A null clears the column, which is not a vocabulary violation — a column
    with no value is a different thing from one holding a value nobody allows.
    """
    check_allowed_values(allowed_value_columns(field_config), properties)


def check_allowed_values(
    constrained: dict[str, list[Any]], properties: dict[str, Any]
) -> None:
    """``validate_allowed_values`` against an already-derived vocabulary map.

    Separate for the same reason as ``fill_defaults``: a bulk write derives the
    map once rather than once per feature.
    """
    for name, value in properties.items():
        if value is None or name not in constrained:
            continue
        if value not in constrained[name]:
            allowed = ", ".join(str(v) for v in constrained[name])
            raise ValueError(
                f"'{value}' is not an accepted value for '{name}'. "
                f"Accepted: {allowed}."
            )


def select_recompute_specs(
    specs: list[ComputedColumnSpec],
    changed_source_cols: set[str],
) -> list[ComputedColumnSpec]:
    """Return the subset whose dependencies overlap the changed cols."""
    if not changed_source_cols:
        return []
    return [
        s
        for s in specs
        if DEPENDS_ON_ANY in s.depends_on
        or changed_source_cols.intersection(s.depends_on)
    ]


async def fetch_field_config(
    conn: asyncpg.Connection,
    layer_id: UUID,
) -> dict[str, Any]:
    """Read `field_config` JSONB from `customer.layer` for one layer.

    Returns an empty dict if the layer is not found or has no
    field_config. The caller is expected to have already verified the
    layer exists via the normal route auth flow.
    """
    row = await conn.fetchrow(
        "SELECT field_config FROM customer.layer WHERE id = $1::uuid",
        str(layer_id),
    )
    if row is None or row["field_config"] is None:
        return {}
    raw = row["field_config"]
    # asyncpg returns JSONB as either a dict (if a codec is registered) or
    # a JSON string. Handle both.
    if isinstance(raw, str):
        raw = json.loads(raw)
    return dict(raw or {})


def _normalize_layer_uuid(layer_id: str) -> str:
    """Hex-only UUIDs (no dashes) are common in customer.layer; normalise."""
    if "-" not in layer_id and len(layer_id) == 32:
        return f"{layer_id[:8]}-{layer_id[8:12]}-{layer_id[12:16]}-{layer_id[16:20]}-{layer_id[20:]}"
    return layer_id


async def write_field_config(
    conn: asyncpg.Connection,
    layer_id: str,
    field_config: dict[str, Any],
) -> None:
    """Replace the entire `field_config` JSONB for one layer."""
    await conn.execute(
        "UPDATE customer.layer SET field_config = $2::jsonb WHERE id = $1::uuid",
        _normalize_layer_uuid(layer_id),
        json.dumps(field_config),
    )
