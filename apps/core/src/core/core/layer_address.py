"""Which layers' addresses a caller gets shortened.

The rule itself is goatlib's (`goatlib.utils.layer_address`, shared with the
project export): a remote raster file's address (`url`) and a WFS copy's
source address (`other_properties.url`) come without their query string,
fragment and credentials to whoever cannot edit the layer. "Can edit" is
`layer_write_allowed`, the one write rule for a layer.
"""

from collections.abc import Iterable, Mapping
from typing import Any
from uuid import UUID

from goatlib.utils.layer_address import layer_shown
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from core.core.config import settings


async def writable_layer_ids(
    session: AsyncSession, layer_ids: Iterable[UUID], user_id: UUID | None
) -> set[UUID]:
    """Which of these layers the user may edit (`layer_write_allowed`), in
    one round trip; none without a user (a public read)."""
    ids = list(layer_ids)
    if user_id is None or not ids:
        return set()
    result = await session.execute(
        text(
            "SELECT l FROM unnest(CAST(:ids AS uuid[])) AS l "
            f"WHERE {settings.SCHEMA}.layer_write_allowed(l, :u)"
        ),
        {"ids": [str(layer_id) for layer_id in ids], "u": str(user_id)},
    )
    return {row[0] for row in result}


async def shortened_layers(
    session: AsyncSession,
    user_id: UUID | None,
    layers: Iterable[tuple[UUID, Mapping[str, Any], bool]],
) -> set[UUID]:
    """Of these layers (id, a row with `data_type` and `url` or
    `other_properties`, whether it is a catalog layer), those whose addresses
    this user gets shortened: `layer_shown` would change them and the user may
    not edit them; the caller passes those rows through `layer_shown`. The
    write rule runs only for rows with something to shorten, so most reads
    cost nothing; without a user, every such row is shortened."""
    changed = {
        layer_id
        for layer_id, row, catalog in layers
        if layer_shown(row, catalog=catalog, can_edit=False) is not row
    }
    if not changed:
        return set()
    return changed - await writable_layer_ids(session, changed, user_id)
