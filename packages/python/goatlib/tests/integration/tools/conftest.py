"""Fixtures for integration testing tools with real PostgreSQL and DuckLake.

These fixtures provide:
- PostgreSQL connection pool with test schemas
- DuckLake connection with test catalog
- Test user, folder, project, and layer fixtures
- ToolSettings configured for testing
- ToolDatabaseService for database operations

Usage:
    # Run all integration tests
    pytest tests/integration/tools/ -v

    # Run only integration tests (using marker)
    pytest -m integration -v

    # Skip integration tests
    pytest -m "not integration" -v

Environment variables (defaults work with docker-compose):
    POSTGRES_SERVER: PostgreSQL host (default: db)
    POSTGRES_PORT: PostgreSQL port (default: 5432)
    POSTGRES_USER: PostgreSQL user (default: postgres)
    POSTGRES_PASSWORD: PostgreSQL password (default: postgres)
    POSTGRES_DB: PostgreSQL database (default: goat)
    DUCKLAKE_DATA_DIR: DuckLake data directory (default: /app/data/ducklake)
    DUCKLAKE_CATALOG_SCHEMA: DuckLake catalog schema (default: ducklake)

NOTE ON DB MODELS:
    The test schemas below (user, folder, project, layer, layer_project) are
    defined as raw SQL to avoid importing from apps/core which would create
    a circular dependency.

    TODO: When the DB models are moved to goatlib (planned refactor), this
    conftest should be updated to:
    1. Import the actual SQLAlchemy/Pydantic models from goatlib
    2. Use model metadata to create test tables (e.g., Base.metadata.create_all)
    3. Remove the hardcoded CREATE TABLE statements

    This will ensure test schemas stay in sync with production schemas and
    reduce maintenance burden.
"""

import logging
import os
import uuid
from pathlib import Path
from typing import Any, Generator

import asyncpg
import duckdb
import pytest
import pytest_asyncio
from goatlib.tools.base import ToolSettings
from goatlib.tools.db import ToolDatabaseService
from goatlib.utils.layer import layer_schema_name

logger = logging.getLogger(__name__)


async def get_pg_connection(settings: ToolSettings) -> asyncpg.Connection:
    """Create a fresh PostgreSQL connection.

    Use this instead of pool.acquire() in factory fixtures to avoid
    event loop issues when running tests from VS Code UI.
    """
    return await asyncpg.connect(
        host=settings.postgres_server,
        port=settings.postgres_port,
        user=settings.postgres_user,
        password=settings.postgres_password,
        database=settings.postgres_db,
    )


def pytest_collection_modifyitems(config, items):
    """Mark all tests in this directory as integration tests."""
    for item in items:
        if "integration" in str(item.fspath):
            item.add_marker(pytest.mark.integration)


# Test schema name - isolated from production data
TEST_CUSTOMER_SCHEMA = "test_customer"

# Test user/folder/project IDs - consistent across test runs
TEST_USER_ID = "00000000-0000-0000-0000-000000000001"
TEST_FOLDER_ID = "00000000-0000-0000-0000-000000000002"
TEST_PROJECT_ID = "00000000-0000-0000-0000-000000000003"


def get_test_settings() -> ToolSettings:
    """Create ToolSettings configured for integration tests."""
    pg_server = os.environ.get("POSTGRES_SERVER", "db")
    pg_port = int(os.environ.get("POSTGRES_PORT", "5432"))
    pg_user = os.environ.get("POSTGRES_USER", "rds")
    pg_password = os.environ.get("POSTGRES_PASSWORD", "ctDQ4E2Wg9Cye37vupYzAf")
    pg_db = os.environ.get("POSTGRES_DB", "goat")

    ducklake_uri = f"postgresql://{pg_user}:{pg_password}@{pg_server}:{pg_port}/{pg_db}"

    return ToolSettings(
        postgres_server=pg_server,
        postgres_port=pg_port,
        postgres_user=pg_user,
        postgres_password=pg_password,
        postgres_db=pg_db,
        ducklake_postgres_uri=ducklake_uri,
        ducklake_catalog_schema=os.environ.get("DUCKLAKE_CATALOG_SCHEMA", "ducklake"),
        ducklake_data_dir=os.environ.get("DUCKLAKE_DATA_DIR", "/app/data/ducklake"),
        tiles_data_dir=os.environ.get("TILES_DATA_DIR", "/app/data/tiles"),
        od_matrix_base_path=os.environ.get(
            "OD_MATRIX_BASE_PATH", "/app/data/traveltime_matrices"
        ),
        customer_schema=TEST_CUSTOMER_SCHEMA,
        # S3/MinIO settings for local testing
        s3_provider=os.environ.get("S3_PROVIDER", "minio"),
        s3_endpoint_url=os.environ.get("S3_ENDPOINT_URL", "http://minio:9000"),
        s3_access_key_id=os.environ.get("S3_ACCESS_KEY_ID", "minioadmin"),
        s3_secret_access_key=os.environ.get("S3_SECRET_ACCESS_KEY", "minioadmin"),
        s3_region_name=os.environ.get("S3_REGION", "us-east-1"),
        s3_bucket_name=os.environ.get("S3_BUCKET_NAME", "goat"),
        # Routing settings (optional for tool tests)
        goat_routing_url=os.environ.get(
            "GOAT_ROUTING_URL", "http://localhost:8200/api/v2/routing"
        ),
        # Disable PMTiles generation in tests for speed
        pmtiles_enabled=False,
    )


@pytest.fixture(scope="session")
def tool_settings() -> ToolSettings:
    """Get ToolSettings configured for integration tests."""
    return get_test_settings()


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def postgres_pool(tool_settings: ToolSettings) -> asyncpg.Pool:
    """Create PostgreSQL connection pool for the test session.

    This pool is used for setting up test schemas and fixtures.
    """
    pool = await asyncpg.create_pool(
        host=tool_settings.postgres_server,
        port=tool_settings.postgres_port,
        user=tool_settings.postgres_user,
        password=tool_settings.postgres_password,
        database=tool_settings.postgres_db,
        min_size=1,
        max_size=5,
    )
    yield pool
    await pool.close()


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def test_schemas(postgres_pool: asyncpg.Pool) -> None:
    """Create the test schema and its tables.

    Creates an isolated test schema that mirrors the production schema structure.
    The schema is dropped and recreated at the start of each test session.
    """
    async with postgres_pool.acquire() as conn:
        # Drop existing test schemas (clean slate)
        for schema in [TEST_CUSTOMER_SCHEMA]:
            await conn.execute(f"DROP SCHEMA IF EXISTS {schema} CASCADE")
            await conn.execute(f"CREATE SCHEMA {schema}")
            logger.info(f"Created test schema: {schema}")

        # Create the user table (minimal - just what tools need)
        await conn.execute(f"""
            CREATE TABLE {TEST_CUSTOMER_SCHEMA}.user (
                id UUID PRIMARY KEY,
                firstname TEXT,
                lastname TEXT,
                avatar TEXT
            )
        """)

        # Create customer.space table (minimal - one personal space per user)
        await conn.execute(f"""
            CREATE TABLE {TEST_CUSTOMER_SCHEMA}.space (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                kind TEXT NOT NULL DEFAULT 'personal',
                user_id UUID REFERENCES {TEST_CUSTOMER_SCHEMA}.user(id) ON DELETE CASCADE,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # Create customer.folder table
        await conn.execute(f"""
            CREATE TABLE {TEST_CUSTOMER_SCHEMA}.folder (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES {TEST_CUSTOMER_SCHEMA}.user(id) ON DELETE CASCADE,
                space_id UUID REFERENCES {TEST_CUSTOMER_SCHEMA}.space(id) ON DELETE SET NULL,
                name TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(user_id, name)
            )
        """)

        # Create customer.project table
        await conn.execute(f"""
            CREATE TABLE {TEST_CUSTOMER_SCHEMA}.project (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES {TEST_CUSTOMER_SCHEMA}.user(id) ON DELETE CASCADE,
                folder_id UUID NOT NULL REFERENCES {TEST_CUSTOMER_SCHEMA}.folder(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                description TEXT,
                tags TEXT[],
                thumbnail_url TEXT,
                layer_order INTEGER[],
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # Create customer.layer table (matches production schema)
        await conn.execute(f"""
            CREATE TABLE {TEST_CUSTOMER_SCHEMA}.layer (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES {TEST_CUSTOMER_SCHEMA}.user(id) ON DELETE CASCADE,
                folder_id UUID NOT NULL REFERENCES {TEST_CUSTOMER_SCHEMA}.folder(id) ON DELETE CASCADE,
                space_id UUID REFERENCES {TEST_CUSTOMER_SCHEMA}.space(id) ON DELETE SET NULL,
                name TEXT NOT NULL,
                description TEXT,
                tags TEXT[],
                thumbnail_url TEXT,
                type TEXT NOT NULL DEFAULT 'feature',
                feature_layer_type TEXT,
                feature_layer_geometry_type TEXT,
                extent GEOMETRY(MultiPolygon, 4326),
                size BIGINT DEFAULT 0,
                properties JSONB,
                other_properties JSONB,
                data_type TEXT,
                tool_type TEXT,
                job_id UUID,
                field_config JSONB NOT NULL DEFAULT '{{}}'::jsonb,
                deleted_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # Create customer.layer_project table (link table)
        await conn.execute(f"""
            CREATE TABLE {TEST_CUSTOMER_SCHEMA}.layer_project (
                id SERIAL PRIMARY KEY,
                layer_id UUID NOT NULL REFERENCES {TEST_CUSTOMER_SCHEMA}.layer(id) ON DELETE CASCADE,
                project_id UUID NOT NULL REFERENCES {TEST_CUSTOMER_SCHEMA}.project(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                "order" INTEGER NOT NULL DEFAULT 0,
                properties JSONB,
                other_properties JSONB,
                layer_project_group_id INTEGER,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(layer_id, project_id)
            )
        """)

        # What finalize and the workflow runner read besides the tables
        # above, with core's columns (core/db/models/_link_model.py and
        # workflow.py): the layer group a project entry can sit in, the
        # workflow a result belongs to (finalize's overwrite reads its
        # config), and core's authorization functions (`customer.can`, and
        # `customer.layer_write_allowed`, which finalize asks before it
        # overwrites a layer). The stubs allow everything: these tests run
        # tools, core's suite proves the authorization.
        await conn.execute(f"""
            CREATE TABLE {TEST_CUSTOMER_SCHEMA}.layer_project_group (
                id SERIAL PRIMARY KEY,
                project_id UUID NOT NULL REFERENCES {TEST_CUSTOMER_SCHEMA}.project(id) ON DELETE CASCADE,
                name TEXT NOT NULL DEFAULT '',
                "order" INTEGER NOT NULL DEFAULT 0,
                properties JSONB,
                parent_id INTEGER REFERENCES {TEST_CUSTOMER_SCHEMA}.layer_project_group(id) ON DELETE CASCADE
            )
        """)
        await conn.execute(f"""
            CREATE TABLE {TEST_CUSTOMER_SCHEMA}.workflow (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                project_id UUID NOT NULL REFERENCES {TEST_CUSTOMER_SCHEMA}.project(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                description TEXT,
                is_default BOOLEAN NOT NULL DEFAULT FALSE,
                config JSONB NOT NULL,
                thumbnail_url TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        await conn.execute(f"""
            CREATE FUNCTION {TEST_CUSTOMER_SCHEMA}.can(text, uuid, uuid, text)
            RETURNS boolean LANGUAGE sql STABLE AS 'SELECT true'
        """)
        await conn.execute(f"""
            CREATE FUNCTION {TEST_CUSTOMER_SCHEMA}.layer_write_allowed(uuid, uuid)
            RETURNS boolean LANGUAGE sql STABLE AS 'SELECT true'
        """)

        logger.info("Created all test tables")

    yield

    # Cleanup: Drop test schemas after all tests
    async with postgres_pool.acquire() as conn:
        for schema in [TEST_CUSTOMER_SCHEMA]:
            await conn.execute(f"DROP SCHEMA IF EXISTS {schema} CASCADE")
            logger.info(f"Dropped test schema: {schema}")


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def test_user(postgres_pool: asyncpg.Pool, test_schemas: None) -> dict[str, Any]:
    """Create a test user in the test schema.

    Returns:
        Dict with user info: id, firstname, lastname
    """
    user_id = uuid.UUID(TEST_USER_ID)

    async with postgres_pool.acquire() as conn:
        await conn.execute(
            f"""
            INSERT INTO {TEST_CUSTOMER_SCHEMA}.user (id, firstname, lastname, avatar)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (id) DO NOTHING
            """,
            user_id,
            "Test",
            "User",
            "https://example.com/avatar.png",
        )

    return {
        "id": TEST_USER_ID,
        "firstname": "Test",
        "lastname": "User",
    }


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def test_folder(
    postgres_pool: asyncpg.Pool, test_user: dict[str, Any]
) -> dict[str, Any]:
    """Create a test folder for the test user.

    Returns:
        Dict with folder info: id, user_id, name
    """
    folder_id = uuid.UUID(TEST_FOLDER_ID)
    user_id = uuid.UUID(test_user["id"])

    async with postgres_pool.acquire() as conn:
        space_id = await conn.fetchval(
            f"""
            INSERT INTO {TEST_CUSTOMER_SCHEMA}.space (kind, user_id)
            VALUES ('personal', $1)
            RETURNING id
            """,
            user_id,
        )
        await conn.execute(
            f"""
            INSERT INTO {TEST_CUSTOMER_SCHEMA}.folder (id, user_id, space_id, name)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (id) DO NOTHING
            """,
            folder_id,
            user_id,
            space_id,
            "Test Folder",
        )

    return {
        "id": TEST_FOLDER_ID,
        "user_id": TEST_USER_ID,
        "name": "Test Folder",
    }


@pytest_asyncio.fixture(scope="function", loop_scope="session")
async def test_project(
    postgres_pool: asyncpg.Pool,
    test_user: dict[str, Any],
    test_folder: dict[str, Any],
) -> dict[str, Any]:
    """Create a test project.

    Returns:
        Dict with project info: id, user_id, folder_id, name
    """
    project_id = uuid.UUID(TEST_PROJECT_ID)
    user_id = uuid.UUID(test_user["id"])
    folder_id = uuid.UUID(test_folder["id"])

    async with postgres_pool.acquire() as conn:
        await conn.execute(
            f"""
            INSERT INTO {TEST_CUSTOMER_SCHEMA}.project (id, user_id, folder_id, name)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (id) DO NOTHING
            """,
            project_id,
            user_id,
            folder_id,
            "Test Project",
        )

    return {
        "id": TEST_PROJECT_ID,
        "user_id": TEST_USER_ID,
        "folder_id": TEST_FOLDER_ID,
        "name": "Test Project",
    }


@pytest.fixture(scope="session")
def ducklake_connection(
    tool_settings: ToolSettings,
) -> Generator[duckdb.DuckDBPyConnection, None, None]:
    """Create a DuckDB connection with DuckLake attached.

    This connection is configured the same way as in BaseToolRunner,
    allowing tests to read/write data to DuckLake.
    """
    con = duckdb.connect()

    # Install and load required extensions
    for ext in ["spatial", "httpfs", "postgres", "ducklake"]:
        con.execute(f"INSTALL {ext}; LOAD {ext};")

    # Configure S3 if endpoint is set (for MinIO)
    if tool_settings.s3_endpoint_url:
        con.execute(f"""
            SET s3_endpoint = '{tool_settings.s3_endpoint_url}';
            SET s3_access_key_id = '{tool_settings.s3_access_key_id or ""}';
            SET s3_secret_access_key = '{tool_settings.s3_secret_access_key or ""}';
            SET s3_url_style = 'path';
            SET s3_use_ssl = false;
        """)

    # Attach DuckLake
    storage_path = tool_settings.ducklake_data_dir
    con.execute(f"""
        ATTACH 'ducklake:postgres:{tool_settings.ducklake_postgres_uri}' AS lake (
            DATA_PATH '{storage_path}',
            METADATA_SCHEMA '{tool_settings.ducklake_catalog_schema}',
            OVERRIDE_DATA_PATH true
        )
    """)

    logger.info(
        f"DuckLake attached: catalog={tool_settings.ducklake_catalog_schema}, "
        f"data_dir={storage_path}"
    )

    yield con

    con.close()


@pytest.fixture
def db_service(
    postgres_pool: asyncpg.Pool,
) -> ToolDatabaseService:
    """Create a ToolDatabaseService for database operations.

    Uses the test customer schema.
    """
    return ToolDatabaseService(postgres_pool, schema=TEST_CUSTOMER_SCHEMA)


@pytest.fixture
def test_layer_id() -> str:
    """Generate a unique layer ID for each test."""
    return str(uuid.uuid4())


def get_user_schema_name(user_id: str) -> str:  # noqa: ARG001 - kept for call sites
    """The DuckLake schema a layer table lives in.

    Storage is flat now: every layer goes in the one shared schema and the
    owner is not part of the path, so the user id no longer participates.
    """
    return layer_schema_name()


def get_table_name(layer_id: str) -> str:
    """Get the DuckLake table name for a layer."""
    return f"t_{layer_id.replace('-', '')}"


def get_full_table_path(user_id: str, layer_id: str) -> str:
    """Get the full DuckLake table path for a layer."""
    return f"lake.{get_user_schema_name(user_id)}.{get_table_name(layer_id)}"


@pytest.fixture
def create_test_layer_in_ducklake(
    ducklake_connection: duckdb.DuckDBPyConnection,
    test_user: dict[str, Any],
):
    """Factory fixture to create test layers in DuckLake.

    Returns a function that creates a layer with the given data.

    Usage:
        def test_something(create_test_layer_in_ducklake):
            layer_id = create_test_layer_in_ducklake(
                layer_id="...",
                data=[
                    {"id": 1, "name": "Point 1", "geometry": "POINT(11.5 48.1)"},
                    {"id": 2, "name": "Point 2", "geometry": "POINT(11.6 48.2)"},
                ],
                geometry_type="POINT",
            )
    """
    created_tables: list[str] = []

    def _create_layer(
        layer_id: str,
        data: list[dict[str, Any]],
        geometry_type: str = "POINT",
        user_id: str | None = None,
    ) -> str:
        """Create a test layer in DuckLake.

        Args:
            layer_id: UUID string for the layer
            data: List of dicts with feature data. Must include 'geometry' as WKT.
            geometry_type: Geometry type (POINT, LINESTRING, POLYGON, etc.)
            user_id: Optional user ID (defaults to test user)

        Returns:
            The layer_id
        """
        user_id = user_id or test_user["id"]
        schema_name = get_user_schema_name(user_id)
        table_name = get_table_name(layer_id)
        full_path = f"lake.{schema_name}.{table_name}"

        # Ensure user schema exists
        ducklake_connection.execute(f"CREATE SCHEMA IF NOT EXISTS lake.{schema_name}")

        # Build column definitions from first row
        if not data:
            raise ValueError("Data must not be empty")

        first_row = data[0]
        columns = []
        for key, value in first_row.items():
            if key == "geometry":
                columns.append(f"{key} GEOMETRY")
            elif isinstance(value, int):
                columns.append(f'"{key}" INTEGER')
            elif isinstance(value, float):
                columns.append(f'"{key}" DOUBLE')
            else:
                columns.append(f'"{key}" VARCHAR')

        # Create table
        col_defs = ", ".join(columns)
        ducklake_connection.execute(f"CREATE TABLE {full_path} ({col_defs})")

        # Insert data
        for row in data:
            col_names = []
            values = []
            for key, value in row.items():
                col_names.append(f'"{key}"' if key != "geometry" else key)
                if key == "geometry":
                    values.append(f"ST_GeomFromText('{value}')")
                elif isinstance(value, str):
                    values.append(f"'{value}'")
                else:
                    values.append(str(value))

            insert_sql = f"INSERT INTO {full_path} ({', '.join(col_names)}) VALUES ({', '.join(values)})"
            ducklake_connection.execute(insert_sql)

        created_tables.append(full_path)
        logger.info(f"Created test layer: {full_path} with {len(data)} features")

        return layer_id

    yield _create_layer

    # Cleanup: Drop all created tables
    for table_path in created_tables:
        try:
            ducklake_connection.execute(f"DROP TABLE IF EXISTS {table_path}")
            logger.info(f"Dropped test table: {table_path}")
        except Exception as e:
            logger.warning(f"Failed to drop table {table_path}: {e}")


@pytest.fixture
def create_test_layer_metadata(
    tool_settings: ToolSettings,
    test_user: dict[str, Any],
    test_folder: dict[str, Any],
):
    """Factory fixture to create layer metadata in PostgreSQL.

    Returns an async function that creates layer metadata.
    Uses fresh connections to avoid event loop issues with VS Code test runner.

    Usage:
        async def test_something(create_test_layer_metadata):
            await create_test_layer_metadata(
                layer_id="...",
                name="Test Layer",
                geometry_type="point",
            )
    """

    async def _create_metadata(
        layer_id: str,
        name: str,
        geometry_type: str = "point",
        feature_layer_type: str = "standard",
        user_id: str | None = None,
        folder_id: str | None = None,
    ) -> str:
        """Create layer metadata in PostgreSQL.

        Args:
            layer_id: UUID string for the layer
            name: Layer display name
            geometry_type: Geometry type (point, line, polygon)
            feature_layer_type: Feature layer type (standard, tool)
            user_id: Optional user ID (defaults to test user)
            folder_id: Optional folder ID (defaults to test folder)

        Returns:
            The layer_id
        """
        user_id = user_id or test_user["id"]
        folder_id = folder_id or test_folder["id"]

        conn = await get_pg_connection(tool_settings)
        try:
            await conn.execute(
                f"""
                INSERT INTO {TEST_CUSTOMER_SCHEMA}.layer (
                    id, user_id, folder_id, name, type, feature_layer_type,
                    feature_layer_geometry_type
                ) VALUES ($1, $2, $3, $4, 'feature', $5, $6)
                """,
                uuid.UUID(layer_id),
                uuid.UUID(user_id),
                uuid.UUID(folder_id),
                name,
                feature_layer_type,
                geometry_type,
            )
        finally:
            await conn.close()

        logger.info(f"Created layer metadata: {layer_id} ({name})")

        return layer_id

    return _create_metadata


@pytest.fixture
def test_data_dir() -> Path:
    """Get the path to the test data directory."""
    return Path(__file__).parent.parent.parent / "data"


@pytest.fixture
def vector_data_dir(test_data_dir: Path) -> Path:
    """Get the path to the vector test data directory."""
    return test_data_dir / "vector"


@pytest.fixture
def create_layer_from_parquet(
    ducklake_connection: duckdb.DuckDBPyConnection,
    test_user: dict[str, Any],
):
    """Factory fixture to create DuckLake layers from parquet test files.

    This reuses existing test data from tests/data/vector/*.parquet files.

    Usage:
        def test_something(create_layer_from_parquet, vector_data_dir):
            layer_id = create_layer_from_parquet(
                parquet_path=vector_data_dir / "overlay_points.parquet",
            )
    """
    created_tables: list[str] = []

    def _create_from_parquet(
        parquet_path: Path,
        layer_id: str | None = None,
        user_id: str | None = None,
    ) -> str:
        """Create a DuckLake layer by importing a parquet file.

        Args:
            parquet_path: Path to the parquet file
            layer_id: Optional UUID string (auto-generated if not provided)
            user_id: Optional user ID (defaults to test user)

        Returns:
            The layer_id
        """
        layer_id = layer_id or str(uuid.uuid4())
        user_id = user_id or test_user["id"]
        schema_name = get_user_schema_name(user_id)
        table_name = get_table_name(layer_id)
        full_path = f"lake.{schema_name}.{table_name}"

        # Ensure user schema exists
        ducklake_connection.execute(f"CREATE SCHEMA IF NOT EXISTS lake.{schema_name}")

        # Create table from parquet
        ducklake_connection.execute(
            f"CREATE TABLE {full_path} AS SELECT * FROM read_parquet('{parquet_path}')"
        )

        created_tables.append(full_path)
        logger.info(f"Created layer from parquet: {full_path} <- {parquet_path.name}")

        return layer_id

    yield _create_from_parquet

    # Cleanup: Drop all created tables
    for table_path in created_tables:
        try:
            ducklake_connection.execute(f"DROP TABLE IF EXISTS {table_path}")
            logger.info(f"Dropped test table: {table_path}")
        except Exception as e:
            logger.warning(f"Failed to drop table {table_path}: {e}")


@pytest.fixture
def cleanup_output_layer(
    ducklake_connection: duckdb.DuckDBPyConnection,
    tool_settings: ToolSettings,
    test_user: dict[str, Any],
):
    """Factory fixture to clean up output layers created by tool runners.

    Handles cleanup of both DuckLake tables and PostgreSQL metadata.
    Uses fresh connections to avoid event loop issues with VS Code test runner.

    Usage:
        async def test_something(cleanup_output_layer):
            result = await asyncio.to_thread(runner.run, params)
            output_layer_id = result["layer_id"]
            # ... assertions ...
            await cleanup_output_layer(output_layer_id)
    """

    async def _cleanup(
        layer_id: str,
        user_id: str | None = None,
        cleanup_project_link: bool = False,
        project_id: str | None = None,
    ) -> None:
        """Clean up an output layer from DuckLake and PostgreSQL.

        Args:
            layer_id: The output layer ID to clean up
            user_id: Optional user ID (defaults to test user)
            cleanup_project_link: If True, also delete layer_project link
            project_id: Project ID if cleaning up project link
        """
        user_id = user_id or test_user["id"]
        output_table = get_full_table_path(user_id, layer_id)

        # Drop DuckLake table
        try:
            ducklake_connection.execute(f"DROP TABLE IF EXISTS {output_table}")
            logger.info(f"Dropped output table: {output_table}")
        except Exception as e:
            logger.warning(f"Failed to drop table {output_table}: {e}")

        # Delete PostgreSQL metadata
        conn = await get_pg_connection(tool_settings)
        try:
            if cleanup_project_link and project_id:
                await conn.execute(
                    f"DELETE FROM {TEST_CUSTOMER_SCHEMA}.layer_project WHERE layer_id = $1",
                    uuid.UUID(layer_id),
                )
                await conn.execute(
                    f"UPDATE {TEST_CUSTOMER_SCHEMA}.project SET layer_order = NULL WHERE id = $1",
                    uuid.UUID(project_id),
                )
            await conn.execute(
                f"DELETE FROM {TEST_CUSTOMER_SCHEMA}.layer WHERE id = $1",
                uuid.UUID(layer_id),
            )
            logger.info(f"Deleted layer metadata: {layer_id}")
        finally:
            await conn.close()

    return _cleanup


@pytest.fixture
def verify_output_layer(
    ducklake_connection: duckdb.DuckDBPyConnection,
    tool_settings: ToolSettings,
    test_user: dict[str, Any],
):
    """Factory fixture to verify output layers exist correctly.

    Uses fresh connections to avoid event loop issues with VS Code test runner.

    Usage:
        async def test_something(verify_output_layer):
            result = await asyncio.to_thread(runner.run, params)
            await verify_output_layer(
                result=result,
                expected_name="My Output",
                min_features=1,
            )
    """

    async def _verify(
        result: dict[str, Any],
        expected_name: str,
        min_features: int = 0,
        expected_geometry_type: str | None = None,
        user_id: str | None = None,
    ) -> str:
        """Verify output layer exists in DuckLake and PostgreSQL.

        Args:
            result: The result dict from runner.run()
            expected_name: Expected layer name in PostgreSQL
            min_features: Minimum expected feature count (default 0)
            expected_geometry_type: Expected geometry type (e.g., "POINT", "POLYGON")
            user_id: Optional user ID (defaults to test user)

        Returns:
            The output layer_id for cleanup
        """
        user_id = user_id or test_user["id"]

        # Verify result structure
        assert "layer_id" in result, "Result should contain layer_id"
        assert "user_id" in result, "Result should contain user_id"
        assert result["user_id"] == user_id, f"user_id should be {user_id}"

        output_layer_id = result["layer_id"]
        output_table = get_full_table_path(user_id, output_layer_id)

        # Verify DuckLake table exists and has features
        count_result = ducklake_connection.execute(
            f"SELECT COUNT(*) FROM {output_table}"
        ).fetchone()
        assert (
            count_result[0] >= min_features
        ), f"Output should have at least {min_features} features, got {count_result[0]}"

        # Verify geometry type if specified
        if expected_geometry_type and count_result[0] > 0:
            geom_type = ducklake_connection.execute(
                f"SELECT ST_GeometryType(geometry) FROM {output_table} LIMIT 1"
            ).fetchone()[0]
            assert (
                expected_geometry_type.upper() in geom_type.upper()
            ), f"Expected geometry type {expected_geometry_type}, got {geom_type}"

        # Verify PostgreSQL metadata
        conn = await get_pg_connection(tool_settings)
        try:
            layer_row = await conn.fetchrow(
                f"SELECT * FROM {TEST_CUSTOMER_SCHEMA}.layer WHERE id = $1",
                uuid.UUID(output_layer_id),
            )
            assert layer_row is not None, "Layer metadata should exist in PostgreSQL"
            assert (
                layer_row["name"] == expected_name
            ), f"Expected name '{expected_name}', got '{layer_row['name']}'"
            assert (
                layer_row["feature_layer_type"] == "tool"
            ), "feature_layer_type should be 'tool'"
        finally:
            await conn.close()

        return output_layer_id

    return _verify
