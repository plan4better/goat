# Standard library imports
import asyncio  # noqa: I001
import contextlib
import logging
import os
import re
from pathlib import Path

# Import Env variables
import core._dotenv  # noqa: E402, F401, I001

# Third party imports
import pytest
import pytest_asyncio

# Local application imports
from core.core.config import settings
from core.crud.base import CRUDBase
from core.crud.crud_space import space as crud_space
from core.db.models import Folder, User
from core.db.sql.create_functions import AsyncFunctionManager
from core.endpoints.deps import get_db, session_manager
from core.main import app
from httpx import AsyncClient
from sqlalchemy import select, text


# One schema per test process. The session fixture DROPs the schema it owns
# before creating it, so a shared name lets two concurrent runs in the same
# worktree destroy each other's tables mid-test. `GOAT_TEST_SCHEMA` pins the
# name when something outside pytest needs to know it.
TEST_SCHEMA_PREFIX = "test_schema"
_WORKER = os.environ.get("PYTEST_XDIST_WORKER")
# Any fixed number works; it only has to be the same in every worker.
_SETUP_LOCK = 870_421_117
TEST_SCHEMA = os.environ.get("GOAT_TEST_SCHEMA") or (
    f"{TEST_SCHEMA_PREFIX}_{_WORKER}_{os.getpid()}"
    if _WORKER
    else f"{TEST_SCHEMA_PREFIX}_{os.getpid()}"
)


def set_test_mode():
    settings.SCHEMA = TEST_SCHEMA
    settings.MAX_FOLDER_COUNT = 15
    settings.TEST_MODE = True
    settings.AUTH = False
    # Billing is switched on per test (tests/billing.py), never by a local .env.
    settings.BILLING_ENABLED = False
    # No test reaches a real Odoo through a local .env: the support tests turn
    # support on with fakes, the staging integration tests read the env.
    settings.ODOO_SUPPORT_API_KEY = None


set_test_mode()


def _owning_pid(schema: str) -> int | None:
    match = re.fullmatch(rf"{TEST_SCHEMA_PREFIX}(?:_gw\d+)?_(\d+)", schema)
    return int(match.group(1)) if match else None


async def _drop_abandoned_test_schemas(connection) -> None:
    """Drop test schemas left behind by processes that are no longer running.

    Each run now owns a schema named after its pid, so an interrupted run
    leaks one. Only schemas whose pid is dead are dropped, so a concurrent
    run's schema is never touched.
    """
    names = (
        (
            await connection.execute(
                text("SELECT nspname FROM pg_namespace WHERE nspname LIKE :like"),
                {"like": f"{TEST_SCHEMA_PREFIX}%"},
            )
        )
        .scalars()
        .all()
    )
    for name in names:
        if name == TEST_SCHEMA_PREFIX:
            # The single shared schema every run used before this split.
            await connection.execute(text(f"DROP SCHEMA IF EXISTS {name} CASCADE"))
            continue
        pid = _owning_pid(name)
        if pid is None or pid == os.getpid():
            continue
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            await connection.execute(text(f"DROP SCHEMA IF EXISTS {name} CASCADE"))
        except OSError:
            continue


@pytest_asyncio.fixture
async def client():
    async with AsyncClient(
        app=app,
        base_url="http://test",
    ) as ac:
        yield ac


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()


@pytest_asyncio.fixture(scope="session", autouse=True)
async def session_fixture(event_loop):
    session_manager.init(settings.ASYNC_SQLALCHEMY_DATABASE_URI)
    session_manager._engine.update_execution_options(
        schema_translate_map={
            "customer": settings.SCHEMA,
        }
    )
    # xdist workers run this setup at the same time, and parts of it touch
    # objects they share (CREATE EXTENSION, the functions in the `basic`
    # schema), which Postgres does not allow concurrently even with IF NOT
    # EXISTS. A session-level advisory lock makes the workers take turns; the
    # engine runs in AUTOCOMMIT, so a transaction-level lock would be released
    # at once.
    async with session_manager.connect() as lock_connection:
        await lock_connection.execute(text(f"SELECT pg_advisory_lock({_SETUP_LOCK})"))
        try:
            async with session_manager.connect() as connection:
                await connection.execute(
                    text('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')
                )
                await _drop_abandoned_test_schemas(connection)
                for schema in [settings.SCHEMA]:
                    await connection.execute(
                        text(f"""DROP SCHEMA IF EXISTS {schema} CASCADE""")
                    )
                    await connection.execute(
                        text(f"""CREATE SCHEMA IF NOT EXISTS {schema}""")
                    )
                await session_manager.drop_all(connection)
                await session_manager.create_all(connection)
                await connection.commit()
            # `get_my_role` and other listing paths call `effective_role` /
            # `can` — install the authz SQL functions into the test schema so any
            # test hitting a project/layer/bundle endpoint has them, not just tests
            # under tests/authz/ that install them again themselves (add-only, so
            # re-running this is a no-op there).
            async with session_manager.session() as function_session:
                manager = AsyncFunctionManager(
                    session=function_session,
                    path="functions",
                    schema="basic",
                    schema_mapping={"basic": "basic", "customer": settings.SCHEMA},
                )
                await manager.add_functions()
            # `folder_depth_check` enforces folder nesting depth <= 3 and same-space
            # parents at the DB level too, and `content_space_default` backfills
            # space_id from the folder on insert — install both the same way
            # init_triggers.py does for a real deploy (`customer.` substituted to
            # the active schema), so any test that inserts/updates folder/layer/
            # project/bundle rows runs against them, not just the tests that target
            # them directly.
            triggers_dir = (
                Path(__file__).resolve().parent.parent
                / "src"
                / "core"
                / "db"
                / "sql"
                / "triggers"
            )
            for trigger_name in ("folder_depth.sql", "content_space_default.sql"):
                trigger_sql = (
                    (triggers_dir / trigger_name)
                    .read_text()
                    .replace("customer.", f"{settings.SCHEMA}.")
                )
                async with session_manager.session() as trigger_session:
                    await trigger_session.execute(text(trigger_sql))
        finally:
            await lock_connection.execute(
                text(f"SELECT pg_advisory_unlock({_SETUP_LOCK})")
            )
    yield
    logging.info("Starting session_fixture finalizer")
    async with session_manager.connect() as connection:
        await connection.execute(
            text(f"DROP SCHEMA IF EXISTS {settings.SCHEMA} CASCADE")
        )
        await connection.commit()
    await session_manager.close()
    logging.info("Finished session_fixture finalizer")


@pytest_asyncio.fixture(autouse=True)
async def session_override(session_fixture):
    async def get_db_override():
        async with session_manager.session() as session:
            yield session

    app.dependency_overrides[get_db] = get_db_override


@pytest_asyncio.fixture
async def db_session():
    async with session_manager.session() as session:
        yield session


@pytest.fixture
async def fixture_create_user(client: AsyncClient, db_session):
    # Get base user_id
    user_id = settings.DEFAULT_USER_ID

    # Create the default user if a previous test (or JIT provisioning) hasn't
    user = await db_session.get(User, user_id)
    if user is None:
        user = User(
            id=user_id,
            email="green.goat@plan4better.de",
            firstname="Green",
            lastname="GOAT",
            avatar="https://assets.plan4better.de/img/goat_app_subscription_professional.jpg",
        )
        db_session.add(user)
        await db_session.commit()
        await db_session.refresh(user)

    # Setup: create the user's home folder (created lazily in the auth dependency
    # for real requests; created explicitly here for a deterministic fixture)
    existing_home = await db_session.execute(
        select(Folder.id).where(Folder.user_id == user_id, Folder.name == "home")
    )
    if existing_home.first() is None:
        space_id = (await crud_space.ensure_personal(db_session, user_id)).id
        db_session.add(Folder(user_id=user_id, name="home", space_id=space_id))
        await db_session.commit()
    yield user.id
    # Teardown: Delete the user after the test
    await CRUDBase(User).delete(db_session, id=user_id)


@pytest.fixture
async def fixture_create_folder(client: AsyncClient, fixture_create_user):
    # Setup: Create the folder
    response = await client.post(f"{settings.API_V2_STR}/folder", json={"name": "test"})
    folder = response.json()
    yield folder
    # Teardown: Delete the folder after the test (the test may have deleted it)
    with contextlib.suppress(Exception):
        await client.delete(f"{settings.API_V2_STR}/folder/{folder['id']}")


@pytest.fixture
async def fixture_get_home_folder(client: AsyncClient):
    response = await client.get(
        f"{settings.API_V2_STR}/folder?search=home&order=descendent&page=1&size=1",
    )
    assert response.status_code == 200
    return response.json()[0]


@pytest.fixture
async def fixture_create_exceed_folders(client: AsyncClient, fixture_create_user):
    max_folder_cnt = settings.MAX_FOLDER_COUNT
    folder_names = [f"test{i}" for i in range(1, max_folder_cnt + 1)]

    # Setup: Create multiple folders
    cnt = 0
    folder_ids = []
    for name in folder_names:
        cnt += 1
        # Request to create a folder
        response = await client.post(
            f"{settings.API_V2_STR}/folder", json={"name": name}
        )
        if cnt >= max_folder_cnt:
            assert response.status_code == 429  # Too Many Requests
        else:
            assert response.status_code == 201
            folder_ids.append(response.json()["id"])

    yield
    # Delete the folders after the test
    for id in folder_ids:
        await client.delete(f"{settings.API_V2_STR}/folder/{id}")


@pytest.fixture
async def fixture_create_folders(client: AsyncClient, fixture_create_user):
    folder_names = ["test1", "test2", "test3"]
    created_folders = []

    # Setup: Create multiple folders
    for name in folder_names:
        response = await client.post(
            f"{settings.API_V2_STR}/folder", json={"name": name}
        )
        folder = response.json()
        created_folders.append(folder)

    yield created_folders

    # Teardown: Delete the folders after the test
    for folder in created_folders:
        await client.delete(f"{settings.API_V2_STR}/folder/{folder['id']}")
