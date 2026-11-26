"""catalog served under a path prefix (ROOT_PATH / CATALOG_ROOT_PATH)."""

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from catalog.app import create_app
from catalog.config import CatalogSettings


@pytest.fixture()
def prefixed_client(catalog_dir: Path) -> Iterator[TestClient]:
    settings = CatalogSettings(data_dir=catalog_dir, auth=False, root_path="catalog/")
    assert settings.root_path == "/catalog"
    with TestClient(create_app(settings)) as c:
        yield c


# The gateway either strips the prefix before forwarding or passes the full
# path through; both must work.
@pytest.mark.parametrize("path", ["/stac", "/catalog/stac"])
def test_stac_links_carry_the_prefix(prefixed_client: TestClient, path: str) -> None:
    r = prefixed_client.get(path)
    assert r.status_code == 200
    links = {link["rel"]: link["href"] for link in r.json()["links"]}
    assert links["self"].startswith("http://testserver/catalog/stac")
    assert links["conformance"].startswith("http://testserver/catalog/")
    assert links["search"].startswith("http://testserver/catalog/")


def test_collection_item_links_carry_the_prefix(prefixed_client: TestClient) -> None:
    collections = prefixed_client.get("/stac/collections").json()["collections"]
    assert collections
    hrefs = [link["href"] for c in collections for link in c["links"]]
    stac_hrefs = [h for h in hrefs if "/stac" in h]
    assert stac_hrefs and all(
        h.startswith("http://testserver/catalog/stac") for h in stac_hrefs
    )


@pytest.mark.parametrize("path", ["/stac/search", "/stac/collections"])
def test_a_stripped_prefix_revalidates_per_language(
    prefixed_client: TestClient, path: str
) -> None:
    """The tag a ranked route stamps is the one its 304 check compares, also
    when the gateway stripped the prefix."""
    tag = prefixed_client.get(path, headers={"Accept-Language": "de"}).headers["etag"]

    hit = prefixed_client.get(
        path, headers={"Accept-Language": "de", "If-None-Match": tag}
    )
    assert hit.status_code == 304
    assert "Accept-Language" in hit.headers["vary"]

    other = prefixed_client.get(
        path, headers={"Accept-Language": "en", "If-None-Match": tag}
    )
    assert other.status_code == 200


def test_a_kept_prefix_names_the_language_in_vary(
    prefixed_client: TestClient,
) -> None:
    """A proxy that keeps the prefix still learns the ranked answer depends on
    ``Accept-Language``, beside what compression sets."""
    headers = {"Accept-Language": "de", "Accept-Encoding": "gzip"}
    for path in ("/catalog/stac/search", "/catalog/stac/collections"):
        r = prefixed_client.get(path, params={"limit": 50}, headers=headers)
        assert r.status_code == 200
        vary = {value.strip() for value in r.headers["vary"].split(",")}
        assert {"Accept-Encoding", "Accept-Language"} <= vary

    nuts = prefixed_client.get("/catalog/stac/nuts", headers=headers)
    assert nuts.status_code == 200
    assert "Accept-Language" not in nuts.headers.get("vary", "")


def test_stac_links_unprefixed_by_default(client: TestClient) -> None:
    links = {link["rel"]: link["href"] for link in client.get("/stac").json()["links"]}
    assert links["self"].startswith("http://testserver/stac")
