"""The database privileges the assistant needs, and a check that reports what
the running role lacks (spec §5).

Every deployment connects the assistant as GOAT's database role, which owns
the database, so nothing is missing there. The check is for operators who
give the assistant a role of its own (``apps/assistant/sql/grants.sql``):
``customer.can`` is a plain SQL function, not SECURITY DEFINER, so it reads
core's tables with the caller's privileges, and a missing SELECT would only
show up as a failed permission check on the first project question. Core's
AI credit functions are SECURITY DEFINER and not executable by everyone, so a
missing EXECUTE would only show up as an unchecked and uncharged answer. The
check runs when the assistant starts. Core's initial_data replaces the
functions in place on every deploy, which keeps their grants; grants.sql's
default privileges give the role's EXECUTE to functions core adds later or
re-creates after a drop.

``python -m assistant.dbcheck`` runs it with the service's environment.
"""

import asyncio
import sys

import asyncpg
from asyncpg.pool import PoolConnectionProxy
from goatlib.config.postgres import asyncpg_connect_args

from assistant.config import AssistantSettings

#: DML on every table of the assistant's schema.
ASSISTANT_PRIVILEGES = ("SELECT", "INSERT", "UPDATE", "DELETE")

#: Core's tables the assistant reads: its own lookups (user, role, user_role,
#: project) and every table the authz functions read
#: (apps/core/src/core/db/sql/functions/authz). Keep grants.sql equal.
CUSTOMER_READS: tuple[str, ...] = (
    "bundle",
    "bundle_layer",
    "folder",
    "layer",
    "layer_project",
    "organization",
    "permission",
    "project",
    "resource",
    "resource_grant",
    "resource_permission",
    "role",
    "role_permission",
    "space",
    "team",
    "template",
    "user",
    "user_role",
    "user_team",
)

#: The authz functions; customer.can calls the others.
AUTHZ_FUNCTIONS: tuple[str, ...] = (
    "authorization",
    "can",
    "check_layer",
    "check_organization",
    "check_project",
    "check_resource",
    "check_team",
    "check_user",
    "direct_grant_rank",
    "effective_rank",
    "effective_role",
    "extract_params_request",
    "folder_chain",
    "get_needed_roles",
    "layer_is_catalog",
    "layer_write_allowed",
    "rank_role",
    "restricted_applies",
    "role_rank",
    "space_admins",
    "space_rank",
)

#: Core's AI credit functions (assistant.credits); EXECUTE is granted to the
#: assistant's role (grants.sql), not to everyone.
CREDIT_FUNCTIONS: tuple[str, ...] = ("ai_credits_left", "charge_ai_answer")

#: Every function of core's schema the check looks for.
CHECKED_FUNCTIONS: tuple[str, ...] = (*AUTHZ_FUNCTIONS, *CREDIT_FUNCTIONS)


def _ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


async def missing_privileges(
    conn: asyncpg.Connection | PoolConnectionProxy, *, schema: str, customer_schema: str
) -> list[str]:
    """What ``current_user`` lacks, one readable item each; empty when complete.

    Objects are looked up in the catalogs and checked by OID. A lookup by name
    (``to_regclass``, ``has_table_privilege(user, 'schema.table', ...)``)
    resolves the name and raises "permission denied for schema" for a role
    without USAGE, which is exactly the role this reports on. Such a schema is
    reported as missing USAGE and its objects are not checked further.
    """
    missing: list[str] = []
    usable: set[str] = set()
    # dict.fromkeys: one entry when both schemas are the same one.
    for name in dict.fromkeys((schema, customer_schema)):
        row = await conn.fetchrow(
            "SELECT has_schema_privilege(current_user, n.oid, 'USAGE') AS usage "
            "FROM pg_namespace n WHERE n.nspname = $1",
            name,
        )
        if row is None:
            missing.append(f"schema {_ident(name)} (run core's migration)")
        elif not row["usage"]:
            missing.append(f"USAGE ON SCHEMA {_ident(name)}")
        else:
            usable.add(name)
    if schema in usable:
        tables = await conn.fetch(
            "SELECT c.relname, "
            "has_table_privilege(current_user, c.oid, 'SELECT') AS can_select, "
            "has_table_privilege(current_user, c.oid, 'INSERT') AS can_insert, "
            "has_table_privilege(current_user, c.oid, 'UPDATE') AS can_update, "
            "has_table_privilege(current_user, c.oid, 'DELETE') AS can_delete "
            "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
            "WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') ORDER BY c.relname",
            schema,
        )
        if not tables:
            missing.append(f"tables in schema {_ident(schema)} (run core's migration)")
        for row in tables:
            qualified = f"{_ident(schema)}.{_ident(row['relname'])}"
            for privilege in ASSISTANT_PRIVILEGES:
                if not row[f"can_{privilege.lower()}"]:
                    missing.append(f"{privilege} ON {qualified}")
    if customer_schema not in usable:
        return missing
    reads = {
        row["relname"]: row["can_select"]
        for row in await conn.fetch(
            "SELECT c.relname, "
            "has_table_privilege(current_user, c.oid, 'SELECT') AS can_select "
            "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
            "WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') "
            "AND c.relname = ANY($2::text[])",
            customer_schema,
            list(CUSTOMER_READS),
        )
    }
    for table in CUSTOMER_READS:
        qualified = f"{_ident(customer_schema)}.{_ident(table)}"
        if table not in reads:
            missing.append(f"table {qualified} (run core's migration)")
        elif not reads[table]:
            missing.append(f"SELECT ON {qualified}")
    functions = await conn.fetch(
        "SELECT p.proname, p.oid::regprocedure::text AS signature, "
        "has_function_privilege(current_user, p.oid, 'EXECUTE') AS allowed "
        "FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
        "WHERE n.nspname = $1 AND p.proname = ANY($2::text[]) ORDER BY 2",
        customer_schema,
        list(CHECKED_FUNCTIONS),
    )
    found = {row["proname"] for row in functions}
    for name in CHECKED_FUNCTIONS:
        if name not in found:
            missing.append(
                f"function {_ident(customer_schema)}.{name} (run core's initial_data)"
            )
    for row in functions:
        if not row["allowed"]:
            missing.append(f"EXECUTE ON FUNCTION {row['signature']}")
    return missing


async def _main() -> int:
    settings = AssistantSettings()
    conn = await asyncpg.connect(
        host=settings.postgres_server,
        port=settings.postgres_port,
        user=settings.postgres_user,
        password=settings.postgres_password,
        database=settings.postgres_db,
        **asyncpg_connect_args(
            "goat-assistant-dbcheck", settings.postgres_transaction_pooler
        ),
    )
    try:
        missing = await missing_privileges(
            conn, schema=settings.db_schema, customer_schema=settings.customer_schema
        )
    finally:
        await conn.close()
    if missing:
        print(f"The database role {settings.postgres_user} lacks:")
        for item in missing:
            print(f"  {item}")
        print("See apps/assistant/sql/grants.sql.")
        return 1
    print("ok")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(_main()))
