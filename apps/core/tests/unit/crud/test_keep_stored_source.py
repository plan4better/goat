"""A link save keeps the link's stored `other_properties.url` (a copy of the
dataset's address), whatever it sends."""

from typing import Any

import pytest
from core.crud.crud_layer_project import keep_stored_source

STORED = {"url": "https://example.org/wfs?key=secret", "layers": ["trees"]}


@pytest.mark.parametrize(
    ("stored", "sent", "written"),
    [
        (
            STORED,
            {"url": "https://example.org/wfs", "table_config": {"a": 1}},
            {"url": STORED["url"], "table_config": {"a": 1}},
        ),
        (STORED, {"table_config": {}}, {"table_config": {}, "url": STORED["url"]}),
        (STORED, None, {"url": STORED["url"]}),
        ({"table_config": {}}, {"url": "https://example.org/x"}, {}),
        (None, None, None),
        (None, {"table_config": {}}, {"table_config": {}}),
        (STORED, "not a dict", "not a dict"),
    ],
)
def test_a_link_save_writes_the_stored_address(
    stored: Any, sent: Any, written: Any
) -> None:
    assert keep_stored_source(stored, sent) == written
