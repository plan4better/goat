"""geoapi meters traffic only with BILLING_ENABLED, the variable processes and the
workers read too (not GEOAPI_-prefixed like geoapi's own settings)."""

import importlib

import pytest


@pytest.fixture(autouse=True)
def _restore_config():
    # The default is read at import: reload once more with the real environment.
    yield
    import geoapi.config

    importlib.reload(geoapi.config)


def _settings(monkeypatch, value):
    if value is None:
        monkeypatch.delenv("BILLING_ENABLED", raising=False)
    else:
        monkeypatch.setenv("BILLING_ENABLED", value)
    import geoapi.config

    return importlib.reload(geoapi.config).Settings()


def test_billing_is_read_from_the_shared_variable(monkeypatch):
    assert _settings(monkeypatch, "true").BILLING_ENABLED is True


def test_billing_is_off_without_it(monkeypatch):
    assert _settings(monkeypatch, None).BILLING_ENABLED is False
