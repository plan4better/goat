import os


def core_dsn() -> str:
    from goatlib.tools.base import ToolSettings

    s = ToolSettings.from_env()
    return (
        f"postgresql://{s.postgres_user}:{s.postgres_password}"
        f"@{s.postgres_server}:{s.postgres_port}/{s.postgres_db}"
    )


def billing_enabled() -> bool:
    """BILLING_ENABLED on the worker: the SaaS install meters credits and runs
    trials. Self-hosted installs leave it unset, and the billing and metering
    tasks then do nothing (core reads the same BILLING_ENABLED)."""
    return os.getenv("BILLING_ENABLED", "").strip().lower() in ("1", "true", "yes")


SKIPPED = {"skipped": "billing is off (BILLING_ENABLED unset)"}


def customer_schema() -> str:
    return os.getenv("CUSTOMER_SCHEMA", "customer")
