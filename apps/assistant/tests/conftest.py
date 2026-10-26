"""Real Postgres for the assistant's tests, one schema per test process.

Needs the local Postgres (repo `compose.yaml`) configured by the root `.env`.
The tables are built from core's model definitions (core.db.models.ASSISTANT_TABLES),
the same source the migration is checked against, translated into a
throwaway schema so parallel runs never meet.
"""

import importlib.util
import os
import sys
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from pathlib import Path
from types import ModuleType
from uuid import UUID, uuid4

import httpx
import pytest
import pytest_asyncio
from cryptography.fernet import Fernet
from dotenv import load_dotenv
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

load_dotenv(Path(__file__).resolve().parents[3] / ".env")
os.environ.setdefault("AUTH", "false")

# The eval set (apps/assistant/evals) is not part of the package; its graders
# are tested here, so its directory goes on the import path.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core.db.models import ASSISTANT_TABLES  # noqa: E402
from sqlalchemy import MetaData  # noqa: E402
from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402

from assistant.app import AppServices, create_app  # noqa: E402
from assistant.auth import Principal, get_principal  # noqa: E402
from assistant.bus import InMemoryEventBus  # noqa: E402
from assistant.config import AssistantSettings  # noqa: E402
from assistant.db import Database  # noqa: E402
from assistant.llm.types import PROVIDER_TYPES  # noqa: E402
from assistant.org_repo import OrgSettingsRepository  # noqa: E402
from assistant.repo import Repository  # noqa: E402
from assistant.runs.manager import RunManager  # noqa: E402
from assistant.tools.http import ServiceClients  # noqa: E402
from assistant.tools.testing import RecordingTransport  # noqa: E402

TEST_SCHEMA = f"test_assistant_{os.getpid()}"

#: Fixed identities, seeded before every test (tests repeat the literals they use).
#: Organization 100: users 1 and 2 are viewers, user 3 is an admin.
#: Organization 200: user 4 is an admin.
ORG = UUID(int=100)
OTHER_ORG = UUID(int=200)
ADMIN_ROLE = UUID(int=900)
VIEWER_ROLE = UUID(int=901)
SEED_USERS = [
    (UUID(int=1), ORG, VIEWER_ROLE),
    (UUID(int=2), ORG, VIEWER_ROLE),
    (UUID(int=3), ORG, ADMIN_ROLE),
    (UUID(int=4), OTHER_ORG, ADMIN_ROLE),
]

#: One key per test session; tests that need other keys build their own SecretBox.
TEST_SECRETS_KEY = Fernet.generate_key().decode()


def _settings() -> AssistantSettings:
    # Fields with a validation alias are set by alias here: by field name, an init
    # argument is rejected as extra when the variable is also set in the
    # environment. Later tests override settings via `settings.model_copy(update=...)`
    # and never call the constructor with field names.
    # Every model-layer field is set, so a developer's .env never reaches the tests.
    return AssistantSettings(
        **{
            "db_schema": TEST_SCHEMA,
            "ASSISTANT_CUSTOMER_SCHEMA": TEST_SCHEMA,
            "ASSISTANT_REDIS_URL": "memory://",
            "AUTH": False,
            # GOAT AI runs on Pydantic AI's TestModel: no provider is ever called.
            "default_provider": "test",
            "default_model": "test",
            "default_base_url": "",
            "default_api_key": "",
            "default_region": "",
            "allow_org_connections": True,
            "allowed_providers": list(PROVIDER_TYPES),
            "allow_private_endpoints": False,
            "secrets_key": TEST_SECRETS_KEY,
            # Tool layer: unroutable hosts, so no test can reach a real service.
            "core_url": "http://core.test",
            "geoapi_url": "http://geoapi.test",
            "ASSISTANT_PROCESSES_URL": "http://processes.test",
            "catalog_url": "http://catalog.test",
            "tool_timeout_seconds": 5.0,
            "disabled_surfaces": [],
            "enable_mcp": True,
            "mcp_allowed_hosts": ["*"],
            "mcp_audit_retention_days": 30,
            "ASSISTANT_WEB_CLIENT_ID": "",
            "ASSISTANT_WEB_CLIENT_SECRET": "",
            "token_exchange_enabled": False,
            "keycloak_client_id": "",
            "keycloak_client_secret": "",
            "GOAT_CA_BUNDLE": None,
        }
    )


@pytest.fixture(scope="session")
def settings() -> AssistantSettings:
    return _settings()


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def _schema(settings: AssistantSettings) -> AsyncIterator[None]:
    url = (
        f"postgresql+asyncpg://{settings.postgres_user}:{settings.postgres_password}"
        f"@{settings.postgres_server}:{settings.postgres_port}/{settings.postgres_db}"
    )
    engine = create_async_engine(url).execution_options(
        schema_translate_map={"assistant": TEST_SCHEMA}
    )
    async with engine.begin() as conn:
        await conn.exec_driver_sql(f'DROP SCHEMA IF EXISTS "{TEST_SCHEMA}" CASCADE')
        await conn.exec_driver_sql(f'CREATE SCHEMA "{TEST_SCHEMA}"')
        metadata = MetaData()
        tables = [table.to_metadata(metadata) for table in ASSISTANT_TABLES]
        await conn.run_sync(lambda sync: metadata.create_all(sync, tables=tables))
        # Stands in for core's user table, which `organization_of` reads.
        await conn.exec_driver_sql(
            f'CREATE TABLE "{TEST_SCHEMA}"."user" '
            "(id uuid PRIMARY KEY, organization_id uuid)"
        )
        # Stand in for core's role tables, which the admin check reads (Task 5).
        await conn.exec_driver_sql(
            f'CREATE TABLE "{TEST_SCHEMA}".role (id uuid PRIMARY KEY, name text NOT NULL)'
        )
        await conn.exec_driver_sql(
            f'CREATE TABLE "{TEST_SCHEMA}".user_role (user_id uuid NOT NULL, role_id uuid NOT NULL)'
        )
        # Stand in for core's project table and its authorization function,
        # which the dock's project checks read (plan 4): a user may read a
        # project when a row in project_reader says so.
        await conn.exec_driver_sql(
            f'CREATE TABLE "{TEST_SCHEMA}".project '
            "(id uuid PRIMARY KEY, name text NOT NULL, deleted_at timestamptz)"
        )
        await conn.exec_driver_sql(
            f'CREATE TABLE "{TEST_SCHEMA}".project_reader '
            "(project_id uuid NOT NULL, user_id uuid NOT NULL)"
        )
        await conn.exec_driver_sql(
            f'CREATE FUNCTION "{TEST_SCHEMA}".can(p_type text, p_id uuid, p_user uuid, p_action text) '
            "RETURNS boolean LANGUAGE sql STABLE AS $fn$ "
            "SELECT p_type = 'project' AND p_action = 'read' AND EXISTS ("
            f'SELECT 1 FROM "{TEST_SCHEMA}".project_reader r '
            "WHERE r.project_id = p_id AND r.user_id = p_user) $fn$"
        )
    yield
    async with engine.begin() as conn:
        await conn.exec_driver_sql(f'DROP SCHEMA IF EXISTS "{TEST_SCHEMA}" CASCADE')
    await engine.dispose()


@pytest_asyncio.fixture
async def db(settings: AssistantSettings, _schema: None) -> AsyncIterator[Database]:
    database = Database(settings)
    await database.connect()
    async with database.pool.acquire() as conn:
        await conn.execute(
            f'TRUNCATE "{TEST_SCHEMA}".feedback, "{TEST_SCHEMA}".tool_call, "{TEST_SCHEMA}".usage, "{TEST_SCHEMA}".run_event, "{TEST_SCHEMA}".run, '
            f'"{TEST_SCHEMA}".message, "{TEST_SCHEMA}".conversation, '
            f'"{TEST_SCHEMA}".organization_settings, "{TEST_SCHEMA}".connection, '
            f'"{TEST_SCHEMA}"."user", "{TEST_SCHEMA}".role, "{TEST_SCHEMA}".user_role, '
            f'"{TEST_SCHEMA}".project, "{TEST_SCHEMA}".project_reader CASCADE'
        )
        await conn.executemany(
            f'INSERT INTO "{TEST_SCHEMA}".role (id, name) VALUES ($1, $2)',
            [(ADMIN_ROLE, "organization-admin"), (VIEWER_ROLE, "organization-viewer")],
        )
        await conn.executemany(
            f'INSERT INTO "{TEST_SCHEMA}"."user" (id, organization_id) VALUES ($1, $2)',
            [(user, organization) for user, organization, _ in SEED_USERS],
        )
        await conn.executemany(
            f'INSERT INTO "{TEST_SCHEMA}".user_role (user_id, role_id) VALUES ($1, $2)',
            [(user, role) for user, _, role in SEED_USERS],
        )
    yield database
    await database.close()


@pytest_asyncio.fixture
async def repo(db: Database) -> Repository:
    return Repository(db)


@pytest_asyncio.fixture
async def org_repo(db: Database) -> OrgSettingsRepository:
    return OrgSettingsRepository(db)


CATALOG_FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "catalog"
    / "tests"
    / "fixtures"
    / "gen_catalog.py"
)


def _catalog_fixture_module() -> ModuleType:
    # Not a package: loaded by path. Registered in sys.modules before running,
    # because dataclasses look their module up there.
    spec = importlib.util.spec_from_file_location(
        "catalog_fixture_gen", CATALOG_FIXTURE
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["catalog_fixture_gen"] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="session")
def catalog_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """The catalog service's own fixture catalog, generated once per session."""
    generator = _catalog_fixture_module()
    path = tmp_path_factory.mktemp("catalog")
    generator.write_catalog(path)
    generator.write_nuts(path)
    return path


@pytest.fixture
def catalog_app(catalog_dir: Path, monkeypatch: pytest.MonkeyPatch) -> FastAPI:
    from catalog.app import create_app as create_catalog_app
    from catalog.config import CatalogSettings
    from catalog.store import CatalogStore

    # As the catalog's own conftest does: a developer's .env must not reach these
    # settings (an aliased variable plus a keyword is an "extra input" error, and
    # a non-JSON list value fails to parse).
    for field in CatalogSettings.model_fields.values():
        alias = field.validation_alias
        for name in getattr(alias, "choices", [alias]) if alias is not None else []:
            if isinstance(name, str):
                monkeypatch.delenv(name, raising=False)
    # By alias, like the catalog's tests.
    catalog_settings = CatalogSettings(**{"data_dir": catalog_dir, "AUTH": False})
    app = create_catalog_app(catalog_settings)
    # What the catalog's lifespan does; ASGITransport does not run lifespans.
    app.state.store = CatalogStore(catalog_settings)
    app.state.preview_reader = None
    app.state.asset_reader = None
    return app


@pytest.fixture
def catalog_transport(catalog_app: FastAPI) -> RecordingTransport:
    return RecordingTransport(httpx.ASGITransport(app=catalog_app))


ApiFactory = Callable[..., AbstractAsyncContextManager[AsyncClient]]
ProjectFactory = Callable[..., Awaitable[UUID]]


@pytest.fixture
def api(db: Database, repo: Repository, settings: AssistantSettings) -> ApiFactory:
    """``async with api(user=..., app_settings=..., tools=...) as client``: the
    app on the test database with a real run manager (no tools), signed in as
    ``user``. ``tools`` are the service clients the routes call (the dock's
    Undo calls core)."""

    @asynccontextmanager
    async def open_(
        user: UUID = UUID(int=1),
        app_settings: AssistantSettings | None = None,
        tools: ServiceClients | None = None,
    ) -> AsyncIterator[AsyncClient]:
        used = app_settings or settings
        bus = InMemoryEventBus()
        runs = RunManager(repo, bus, used, owner="t")
        await runs.start()
        try:
            app = create_app(
                used,
                services=AppServices(db=db, repo=repo, bus=bus, runs=runs, tools=tools),
            )
            app.dependency_overrides[get_principal] = lambda: Principal(
                user_id=user, token=None
            )
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://t"
            ) as client:
                yield client
        finally:
            await runs.stop()

    return open_


@pytest.fixture
def make_project(db: Database) -> ProjectFactory:
    """A row in the project stub, readable by ``readers``; ``deleted`` trashes it."""

    async def make(
        name: str = "Radverkehr",
        readers: tuple[UUID, ...] = (UUID(int=1),),
        deleted: bool = False,
    ) -> UUID:
        project_id = uuid4()
        async with db.pool.acquire() as conn:
            await conn.execute(
                f"INSERT INTO {db.customer('project')} (id, name, deleted_at) "
                "VALUES ($1, $2, CASE WHEN $3::boolean THEN now() END)",
                project_id,
                name,
                deleted,
            )
            await conn.executemany(
                f"INSERT INTO {db.customer('project_reader')} (project_id, user_id) VALUES ($1, $2)",
                [(project_id, reader) for reader in readers],
            )
        return project_id

    return make
