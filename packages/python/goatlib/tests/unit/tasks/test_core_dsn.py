"""core_dsn: the billing tasks' connection to core's database."""

from urllib.parse import unquote, urlsplit

import pytest
from goatlib.tasks._db import core_dsn


def test_any_character_in_the_credentials_survives(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # URL syntax in a password (@ / : % # ?) would otherwise end the user info
    # early or start the path, query or fragment.
    password = "p@ss/w:rd%40#?x"
    for key, value in {
        "POSTGRES_SERVER": "db.example",
        "POSTGRES_PORT": "6432",
        "POSTGRES_USER": "goat user",
        "POSTGRES_PASSWORD": password,
        "POSTGRES_DB": "goat",
    }.items():
        monkeypatch.setenv(key, value)

    parts = urlsplit(core_dsn())

    assert unquote(parts.username or "") == "goat user"
    assert unquote(parts.password or "") == password
    assert (parts.hostname, parts.port, parts.path) == ("db.example", 6432, "/goat")
