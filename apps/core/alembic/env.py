from __future__ import with_statement

import asyncio
from logging.config import fileConfig

from alembic import context
from core._dotenv import load_dotenv  # noqa: F401
from core.core.config import settings
from core.db.session import engine_connect_args
from core.db.models import *  # noqa: F403
from sqlalchemy import pool
from sqlalchemy.ext.asyncio import async_engine_from_config
from sqlmodel import SQLModel

# this is the Alembic Config object, which provides
# access to the values within the .ini file in use.
config = context.config

# Interpret the config file for Python logging.
# This line sets up loggers basically.
fileConfig(config.config_file_name)


target_metadata = SQLModel.metadata

# other values from the config, defined by the needs of env.py,
# can be acquired:
# my_important_option = config.get_main_option("my_important_option")
# ... etc.


# Autogenerate only considers tables in the configurable data schema.
MANAGED_SCHEMAS = [settings.SCHEMA]


def include_object(object, name, type_, reflected, compare_to):
    if type_ == "table" and object.schema not in MANAGED_SCHEMAS:
        return False
    if type_ in ["table"] and reflected and compare_to is None:
        return False
    else:
        return True


def include_name(name, type_, parent_names):
    if type_ == "schema":
        return name in MANAGED_SCHEMAS
    else:
        return True


_db_url = settings.ASYNC_SQLALCHEMY_DATABASE_URI
assert _db_url is not None, "ASYNC_SQLALCHEMY_DATABASE_URI must be configured"
# The config is a ConfigParser, which reads "%" as interpolation; a password
# with URI-special characters is percent-encoded in the URL, so double them.
config.set_main_option("sqlalchemy.url", _db_url.replace("%", "%%"))


def run_migrations_offline():
    """Run migrations in 'offline' mode.

    This configures the context with just a URL
    and not an Engine, though an Engine is acceptable
    here as well.  By skipping the Engine creation
    we don't even need a DBAPI to be available.

    Calls to context.execute() here emit the given string to the
    script output.

    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        compare_type=True,
        include_object=include_object,
    )

    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection):
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
        include_object=include_object,
        include_schemas=True,
        include_name=include_name,
    )

    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    """In this scenario we need to create an Engine and associate a connection with the context."""

    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
        connect_args=engine_connect_args(_db_url),
    )

    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)

    await connectable.dispose()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode."""

    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
