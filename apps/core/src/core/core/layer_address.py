"""Which layers' addresses a caller gets shortened.

The rule itself is goatlib's `address_shown` (`goatlib.utils.layer_address`,
shared with the project export): a remote raster file's address comes without
its query string, fragment and credentials to whoever cannot edit the layer.
"Can edit" is `layer_write_allowed`, the one write rule for a layer.
"""

from collections.abc import Iterable
from typing import Any
from uuid import UUID

from goatlib.utils.layer_address import address_shown
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


async def addresses_for(
    session: AsyncSession, user_id: UUID | None, layers: Iterable[Any]
) -> dict[UUID, str | None]:
    """The layers (rows with `id`, `url`, `data_type`, `catalog_external_uid`)
    whose address this user gets shortened, with that address. A layer not in
    the result is returned as stored. The write rule runs only for remote
    files whose address has something to shorten, so most reads cost nothing."""
    shortened: dict[UUID, str | None] = {}
    for layer in layers:
        shown = address_shown(
            layer.url,
            data_type=layer.data_type,
            catalog=layer.catalog_external_uid is not None,
            can_edit=False,
        )
        if shown != layer.url:
            shortened[layer.id] = shown
    if not shortened:
        return {}
    editable = await writable_layer_ids(session, shortened, user_id)
    return {
        layer_id: shown
        for layer_id, shown in shortened.items()
        if layer_id not in editable
    }
