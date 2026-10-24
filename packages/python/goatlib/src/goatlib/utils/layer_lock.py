"""The per-layer write lock, shared by geoapi's feature writes and the
workflow's "Save as dataset" into an existing dataset.

Dependency-free on purpose: geoapi installs goatlib without its "full" extra.

A Postgres advisory lock keyed by the layer, taken with
``pg_advisory_xact_lock`` inside a transaction, so the server releases it when
the transaction ends, also when the worker dies mid-write.

The serial high-water marks it guards (core's ``layer_serial_counter``) are
read and advanced here too, so both writers count the same way. asyncpg is
not imported: a missing counter table is told by its SQLSTATE.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from typing import Any

logger = logging.getLogger(__name__)

#: Namespaces the advisory-lock key, so it cannot collide with another feature
#: that hashes a layer id into an advisory lock.
LAYER_LOCK_NAMESPACE = "goat.layer_serial:"


def layer_lock_key(layer_id: str) -> str:
    """The layer id in one spelling, whichever form the caller holds."""
    return LAYER_LOCK_NAMESPACE + layer_id.replace("-", "").lower()


async def lock_layer(conn: Any, layer_id: str) -> None:
    """Take the layer's write lock until the caller's transaction ends."""
    await conn.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        layer_lock_key(layer_id),
    )


#: SQLSTATE of "relation does not exist" (asyncpg's UndefinedTableError).
_UNDEFINED_TABLE = "42P01"


def _missing_table(exc: BaseException) -> bool:
    return getattr(exc, "sqlstate", None) == _UNDEFINED_TABLE


async def read_marks(
    conn: Any, layer_id: str, names: list[str], table: str
) -> dict[str, int]:
    """The stored marks of these columns; none for a column that has no row."""
    try:
        async with conn.transaction():
            rows = await conn.fetch(
                f"SELECT field_name, last_value FROM {table} "
                "WHERE layer_id = $1::uuid AND field_name = ANY($2::text[])",
                layer_id,
                names,
            )
    except Exception as exc:
        if not _missing_table(exc):
            raise
        # Core's migration has not run yet: numbers continue from max.
        logger.warning("%s is missing; serial numbers fall back to max", table)
        return {}
    return {row["field_name"]: int(row["last_value"]) for row in rows}


async def advance_marks(
    conn: Any, layer_id: str, assigned: dict[str, int], table: str
) -> None:
    """Store the highest numbers handed out; a mark never moves down."""
    try:
        async with conn.transaction():
            await conn.executemany(
                f"INSERT INTO {table} AS c "
                "(layer_id, field_name, last_value, updated_at) "
                "VALUES ($1::uuid, $2, $3, now()) "
                "ON CONFLICT (layer_id, field_name) DO UPDATE SET "
                "last_value = greatest(c.last_value, excluded.last_value), "
                "updated_at = now()",
                [(layer_id, name, value) for name, value in assigned.items()],
            )
    except Exception as exc:
        if not _missing_table(exc):
            raise
        logger.warning("%s is missing; serial high-water mark not stored", table)


@contextmanager
def hold_layer_lock(
    connect: Callable[[], Awaitable[Any]],
    layer_id: str,
    loop: asyncio.AbstractEventLoop,
) -> Iterator[Any]:
    """Hold the layer's write lock around a block of synchronous tool code.

    Yields the dedicated connection whose transaction holds the lock, so the
    block can read and advance the layer's serial marks in that transaction.
    """
    conn = loop.run_until_complete(connect())
    try:
        tx = conn.transaction()
        loop.run_until_complete(tx.__aenter__())
        try:
            loop.run_until_complete(lock_layer(conn, layer_id))
            yield conn
        except BaseException as exc:
            loop.run_until_complete(tx.__aexit__(type(exc), exc, exc.__traceback__))
            raise
        loop.run_until_complete(tx.__aexit__(None, None, None))
    finally:
        loop.run_until_complete(conn.close())
