import os


def core_dsn() -> str:
    from goatlib.tools.base import ToolSettings

    s = ToolSettings.from_env()
    return (
        f"postgresql://{s.postgres_user}:{s.postgres_password}"
        f"@{s.postgres_server}:{s.postgres_port}/{s.postgres_db}"
    )


def customer_schema() -> str:
    return os.getenv("CUSTOMER_SCHEMA", "customer")
