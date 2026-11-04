"""`GET /stac/suggest`: the term probe the assistant's catalog_suggest_terms
tool calls (was the MCP tool `suggest_terms`)."""

from fastapi.testclient import TestClient


def test_suggest_finds_a_word_by_its_stem(client: TestClient) -> None:
    response = client.get("/stac/suggest", params={"prefix": "radver"})
    assert response.status_code == 200
    body = response.json()
    assert body["prefix"] == "radver"
    assert body["matches"], "the fixture has Radverkehrsnetz titles"
    assert any("Radverkehrsnetz" in match["title"] for match in body["matches"])
    assert all(set(match) == {"title", "id"} for match in body["matches"])


def test_suggest_anchors_at_word_boundaries(client: TestClient) -> None:
    """'erkehrsnetz' must not match 'Radverkehrsnetz' mid-word: a term probe
    that reported a hit for any infix would claim a word exists when it does not."""
    response = client.get("/stac/suggest", params={"prefix": "erkehrsnetz"})
    assert response.json()["matches"] == []


def test_suggest_blank_prefix_is_empty_not_everything(client: TestClient) -> None:
    response = client.get("/stac/suggest", params={"prefix": "   "})
    assert response.json() == {"prefix": "   ", "matches": []}


def test_suggest_limit_is_clamped(client: TestClient) -> None:
    assert (
        len(
            client.get("/stac/suggest", params={"prefix": "r", "limit": 1}).json()[
                "matches"
            ]
        )
        == 1
    )
    many = client.get("/stac/suggest", params={"prefix": "r", "limit": 1000}).json()[
        "matches"
    ]
    assert 1 <= len(many) <= 50
    assert (
        client.get("/stac/suggest", params={"prefix": "r", "limit": 0}).status_code
        == 200
    )


def test_suggest_treats_the_prefix_as_text(client: TestClient) -> None:
    response = client.get("/stac/suggest", params={"prefix": "rad(.*"})
    assert response.status_code == 200
    assert response.json()["matches"] == []


def test_suggest_rejects_a_huge_prefix(client: TestClient) -> None:
    assert client.get("/stac/suggest", params={"prefix": "x" * 101}).status_code == 400
