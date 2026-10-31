import importlib

import pytest


def test_cost_model_is_gone():
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("core.db.models.cost")


def test_cost_table_not_registered():
    import core.db.models  # noqa: F401  (triggers model registration)
    from sqlmodel import SQLModel

    tables = set(SQLModel.metadata.tables)
    assert not any(t.endswith(".cost") or t == "cost" for t in tables)
