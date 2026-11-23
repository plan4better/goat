"""Unit tests for ToolDatabaseService (goatlib/tools/db.py).

Covers the space_id derivation added in create_layer/create_bundle: every
row a tool writes must be reachable through a space, so both INSERTs
resolve space_id from the target folder before writing.
"""

import uuid
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator
from unittest.mock import AsyncMock, MagicMock

import pytest
from goatlib.tools.db import ToolDatabaseService

FOLDER_ID = str(uuid.uuid4())
SPACE_ID = uuid.uuid4()
USER_ID = str(uuid.uuid4())


def make_pool(
    space_id: uuid.UUID | None = SPACE_ID, folder_exists: bool = True
) -> MagicMock:
    pool = MagicMock()
    if not folder_exists:
        pool.fetchrow = AsyncMock(return_value=None)
    else:
        pool.fetchrow = AsyncMock(return_value={"space_id": space_id})
    pool.execute = AsyncMock(return_value=None)
    # The connection a transaction runs on: `create_layer` writes the layer row
    # and its default style together.
    pool.conn = MagicMock()
    pool.conn.execute = AsyncMock(return_value=None)

    @asynccontextmanager
    async def transaction() -> AsyncIterator[None]:
        yield

    @asynccontextmanager
    async def acquire() -> AsyncIterator[Any]:
        yield pool.conn

    pool.conn.transaction = transaction
    pool.acquire = acquire
    return pool


class TestCreateLayerSpaceId:
    """create_layer must derive space_id from the folder and write it."""

    async def test_insert_carries_folder_space_id(self) -> None:
        pool = make_pool()
        db = ToolDatabaseService(pool, schema="customer")

        await db.create_layer(
            layer_id=str(uuid.uuid4()),
            user_id=USER_ID,
            folder_id=FOLDER_ID,
            name="My Layer",
            layer_type="feature",
            geometry_type="POINT",
        )

        # The folder's space_id was looked up ...
        pool.fetchrow.assert_awaited_once()
        lookup_sql = pool.fetchrow.await_args.args[0]
        assert "space_id" in lookup_sql
        assert "customer.folder" in lookup_sql

        # ... and passed as an INSERT parameter.
        layer_insert, style_insert = pool.conn.execute.await_args_list
        assert "space_id" in layer_insert.args[0]
        assert SPACE_ID in layer_insert.args[1:]
        # The layer's default style is written in the same transaction.
        assert "layer_style" in style_insert.args[0]

    async def test_orphan_folder_raises_clear_error(self) -> None:
        """A folder with no space must not produce an unreachable layer row."""
        pool = make_pool(space_id=None)
        db = ToolDatabaseService(pool, schema="customer")

        with pytest.raises(ValueError, match="space"):
            await db.create_layer(
                layer_id=str(uuid.uuid4()),
                user_id=USER_ID,
                folder_id=FOLDER_ID,
                name="My Layer",
                layer_type="feature",
                geometry_type="POINT",
            )

        pool.conn.execute.assert_not_awaited()

    async def test_missing_folder_raises_clear_error(self) -> None:
        pool = make_pool(folder_exists=False)
        db = ToolDatabaseService(pool, schema="customer")

        with pytest.raises(ValueError, match="does not exist"):
            await db.create_layer(
                layer_id=str(uuid.uuid4()),
                user_id=USER_ID,
                folder_id=FOLDER_ID,
                name="My Layer",
                layer_type="feature",
                geometry_type="POINT",
            )

        pool.conn.execute.assert_not_awaited()


class TestCreateBundleSpaceId:
    """create_bundle must derive space_id from the folder and write it."""

    async def test_insert_carries_folder_space_id(self) -> None:
        pool = make_pool()
        db = ToolDatabaseService(pool, schema="customer")

        await db.create_bundle(
            bundle_id=str(uuid.uuid4()),
            user_id=USER_ID,
            folder_id=FOLDER_ID,
            name="My Bundle",
            bundle_type="dataset",
        )

        pool.fetchrow.assert_awaited_once()
        insert_sql = pool.execute.await_args.args[0]
        insert_params = pool.execute.await_args.args[1:]
        assert "space_id" in insert_sql
        assert SPACE_ID in insert_params

    async def test_orphan_folder_raises_clear_error(self) -> None:
        pool = make_pool(space_id=None)
        db = ToolDatabaseService(pool, schema="customer")

        with pytest.raises(ValueError, match="space"):
            await db.create_bundle(
                bundle_id=str(uuid.uuid4()),
                user_id=USER_ID,
                folder_id=FOLDER_ID,
                name="My Bundle",
                bundle_type="dataset",
            )

        pool.execute.assert_not_awaited()
