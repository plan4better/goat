import json

import asyncpg
from goatlib.config.postgres import asyncpg_connect_args

from assistant.config import AssistantSettings


async def _init_connection(conn: asyncpg.Connection) -> None:
    # JSONB in and out as Python objects.
    await conn.set_type_codec(
        "jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog"
    )


class Database:
    """One asyncpg pool; schema-qualified names via ``t()``."""

    def __init__(self, settings: AssistantSettings) -> None:
        self.settings = settings
        self._pool: asyncpg.Pool | None = None

    async def connect(self) -> None:
        self._pool = await asyncpg.create_pool(
            host=self.settings.postgres_server,
            port=self.settings.postgres_port,
            user=self.settings.postgres_user,
            password=self.settings.postgres_password,
            database=self.settings.postgres_db,
            **asyncpg_connect_args(
                "goat-assistant", self.settings.postgres_transaction_pooler
            ),
            min_size=1,
            max_size=10,
            command_timeout=60,
            init=_init_connection,
        )

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()
            self._pool = None

    @property
    def pool(self) -> asyncpg.Pool:
        if self._pool is None:
            raise RuntimeError("Database.connect() has not been called")
        return self._pool

    def t(self, table: str) -> str:
        """A schema-qualified assistant table name."""
        return f'"{self.settings.db_schema}"."{table}"'

    def customer(self, table: str) -> str:
        return f'"{self.settings.customer_schema}"."{table}"'
