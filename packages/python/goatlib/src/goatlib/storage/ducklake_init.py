"""One-shot DuckLake catalog bootstrap.

Idempotent ATTACH that creates the DuckLake catalog (Postgres metadata
schema + S3/local data layout) if missing, no-op against an existing
catalog. Intended as a pre-flight step before any read-only consumer
(geoapi, processes) starts up — DuckDB refuses to attach a non-existent
catalog in READ_ONLY mode.

Usage:
    python -m goatlib.storage.ducklake_init

Env-var contract matches the legacy `scripts/db/init-ducklake.py` so the
script in the goat monorepo can later become a thin wrapper that just
calls `bootstrap_from_env()` here, without breaking the docker-compose
`ducklake-init` service or any other consumer reading the same env vars.

Kept in a sibling module to ducklake.py (rather than appended to it)
because the long-running connection manager + pool there carry state
that's irrelevant to a zero-state one-shot bootstrap; the two pieces
have different lifecycles, different tests, different reviewers.
"""

from __future__ import annotations

import os
import sys

import duckdb

from goatlib.storage.s3_config import apply_duckdb_s3_settings, duckdb_s3_endpoint

# DuckDB extensions the DuckLake ATTACH needs loaded in the connection.
# Matches BaseDuckLakeManager.REQUIRED_EXTENSIONS in ducklake.py — kept in
# sync intentionally; if you change one, change both. We don't reach into
# the other module to avoid an import-cycle / accidental coupling to its
# class-level state.
_REQUIRED_EXTENSIONS = ("spatial", "httpfs", "postgres", "ducklake")


def bootstrap_from_env() -> None:
    """Idempotent DuckLake catalog ATTACH driven by env vars.

    Required:
        POSTGRES_PASSWORD

    Optional (with defaults):
        POSTGRES_SERVER         (default: "db")
        POSTGRES_PORT           (default: "5432")
        POSTGRES_USER           (default: "postgres")
        POSTGRES_DB             (default: "goat")
        DUCKLAKE_DATA_DIR       (default: "/app/data/ducklake")
        DUCKLAKE_CATALOG_SCHEMA (default: "ducklake")

    Optional (no defaults — S3 only configured if endpoint is set):
        S3_ENDPOINT_URL         e.g. "http://minio:9000"
        S3_ACCESS_KEY_ID
        S3_SECRET_ACCESS_KEY

    Raises SystemExit(1) on missing POSTGRES_PASSWORD, otherwise prints
    progress to stdout and returns normally on success.
    """
    pg_host = os.environ.get("POSTGRES_SERVER", "db")
    pg_port = os.environ.get("POSTGRES_PORT", "5432")
    pg_user = os.environ.get("POSTGRES_USER", "postgres")
    pg_password = os.environ.get("POSTGRES_PASSWORD")
    pg_db = os.environ.get("POSTGRES_DB", "goat")
    storage_path = os.environ.get("DUCKLAKE_DATA_DIR", "/app/data/ducklake")
    catalog_schema = os.environ.get("DUCKLAKE_CATALOG_SCHEMA", "ducklake")
    s3_endpoint = os.environ.get("S3_ENDPOINT_URL", "")
    s3_access_key = os.environ.get("S3_ACCESS_KEY_ID", "")
    s3_secret_key = os.environ.get("S3_SECRET_ACCESS_KEY", "")

    if not pg_password:
        print("ERROR: POSTGRES_PASSWORD is required", file=sys.stderr)
        sys.exit(1)

    os.makedirs(storage_path, exist_ok=True)

    print("Initializing DuckLake...")
    print(f"  PostgreSQL: {pg_host}:{pg_port}/{pg_db}")
    print(f"  Catalog schema: {catalog_schema}")
    print(f"  Data directory: {storage_path}")

    con = duckdb.connect()

    print("Installing DuckDB extensions...")
    for ext in _REQUIRED_EXTENSIONS:
        con.execute(f"INSTALL {ext}; LOAD {ext};")

    if s3_endpoint:
        print(f"  S3 endpoint: {duckdb_s3_endpoint(s3_endpoint)[0]}")
        apply_duckdb_s3_settings(
            con,
            endpoint_url=s3_endpoint,
            access_key=s3_access_key,
            secret_key=s3_secret_key,
        )

    pg_uri = (
        f"host={pg_host} port={pg_port} "
        f"user={pg_user} password={pg_password} dbname={pg_db} "
        f"keepalives=1 keepalives_idle=30 keepalives_interval=5 "
        f"keepalives_count=5"
    )

    print("Attaching DuckLake catalog...")
    # No READ_ONLY → DuckDB creates the catalog if missing, otherwise no-op.
    con.execute(
        f"ATTACH 'ducklake:postgres:{pg_uri}' AS lake ("
        f"  DATA_PATH '{storage_path}', "
        f"  METADATA_SCHEMA '{catalog_schema}'"
        f")"
    )

    print("DuckLake initialized successfully!")
    print(f"  Catalog: {catalog_schema}")
    print(f"  Data path: {storage_path}")

    con.close()


if __name__ == "__main__":
    bootstrap_from_env()
