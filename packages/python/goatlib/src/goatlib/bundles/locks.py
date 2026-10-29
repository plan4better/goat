"""The Postgres advisory lock that orders writes to a bundle's member layers.

A write to a bundle's layers moves two things that live apart: the bundle's
``layers_revision`` (Postgres) and the layers' data (a DuckLake commit). A
reader that needs the data *of* a revision — the Explorer's snapshot, built
once per revision — must see both at the same point. Between a writer's
revision claim and its DuckLake commit, the revision already says "new" while
the data is still old.

So a writer holds this lock exclusively from its claim until its DuckLake
commit (``pg_advisory_xact_lock``), and a reader takes it shared
(``pg_advisory_xact_lock_shared``) while it reads the revision and the
DuckLake snapshot id together. Transaction-scoped on both sides, so it can
never be left held.
"""


def bundle_layers_lock_key_sql(param: str = "$1") -> str:
    """SQL for the lock key of the bundle whose id is ``param``.

    ``param`` is a placeholder (``$1``) or any SQL expression for the id."""
    return f"hashtextextended('goat.bundle_layers:' || ({param})::text, 0)"
