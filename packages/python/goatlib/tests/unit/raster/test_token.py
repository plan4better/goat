import base64
import json

import pytest
from goatlib.raster.token import TokenError, decode_token, encode_token

RAMP = {
    "v": 1,
    "kind": "ramp",
    "band": 1,
    "noData": [-9999],
    "colors": ["#000000", "#ffffff"],
    "domain": [0, 100],
    "outside": "clamp",
}


def _b64(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode()).decode().rstrip("=")


def test_a_token_round_trips_and_is_canonical() -> None:
    token = encode_token(RAMP)
    assert (
        decode_token(token).model_dump(mode="json", by_alias=True, exclude_none=True)
        == RAMP
    )
    assert encode_token(dict(reversed(list(RAMP.items())))) == token
    assert "=" not in token and "+" not in token and "/" not in token


def test_every_kind_decodes() -> None:
    cases = [
        {
            "v": 1,
            "kind": "stops",
            "band": 2,
            "noData": [],
            "interpolate": "nearest",
            "outside": "hide",
            "stops": [{"value": 0, "color": "#000"}, {"value": 9, "color": "#fff"}],
        },
        {
            "v": 1,
            "kind": "classes",
            "band": "(b4 - b1) / (b4 + b1)",
            "noData": [],
            "classes": [{"to": 0, "color": "#ff0000"}, {"from": 0, "color": None}],
        },
        {
            "v": 1,
            "kind": "categories",
            "band": 1,
            "noData": [0],
            "classes": [{"value": 3, "color": "#00ff00"}, {"value": 6, "color": None}],
            "other": None,
        },
        {"v": 1, "kind": "rgb", "bands": [4, 1, 2], "noData": []},
        {"v": 1, "kind": "rgb", "bands": None, "noData": []},
        {
            "v": 1,
            "kind": "ramp",
            "band": 1,
            "noData": [],
            "colors": ["#000000ff", "#fff"],
            "domain": None,
            "outside": "clamp",
        },
    ]
    for case in cases:
        assert decode_token(encode_token(case)).kind == case["kind"]


def test_a_token_written_by_the_browser_decodes() -> None:
    # JSON.stringify output: no spaces, the browser's key order, base64url without padding.
    text = '{"band":1,"colors":["#000000","#ffffff"],"domain":[0,100],"kind":"ramp","noData":[-9999],"outside":"clamp","v":1}'
    assert (
        decode_token(_b64(text)).model_dump(
            mode="json", by_alias=True, exclude_none=True
        )
        == RAMP
    )


@pytest.mark.parametrize(
    "token",
    [
        "",
        "!!!",
        _b64("not json"),
        _b64("[1, 2]"),
        _b64(json.dumps({**RAMP, "kind": "nope"})),
        _b64(json.dumps({**RAMP, "v": 2})),
        _b64(json.dumps({**RAMP, "band": 0})),
        _b64(json.dumps({**RAMP, "band": True})),
        _b64(json.dumps({**RAMP, "band": "b1 +"})),
        _b64(json.dumps({**RAMP, "band": "__import__('os')"})),
        _b64(json.dumps({**RAMP, "colors": ["red", "#fff"]})),
        _b64(json.dumps({**RAMP, "colors": ["#fff"]})),
        _b64(json.dumps({**RAMP, "domain": [0]})),
        _b64(json.dumps({**RAMP, "extra": 1})),
        _b64(json.dumps({"v": 1, "kind": "rgb", "bands": [1, 2], "noData": []})),
        _b64(json.dumps({**RAMP, "noData": list(range(2000))})),
    ],
)
def test_an_invalid_token_is_a_token_error(token: str) -> None:
    with pytest.raises(TokenError):
        decode_token(token)


def test_every_token_the_browser_writes_decodes_to_its_coloring() -> None:
    from pathlib import Path

    cases = json.loads(
        (Path(__file__).parent / "fixtures" / "web_tokens.json").read_text()
    )
    assert len(cases) > 4

    def without_none(node: object) -> object:
        if isinstance(node, dict):
            return {k: without_none(v) for k, v in node.items() if v is not None}
        if isinstance(node, list):
            return [without_none(v) for v in node]
        return node

    for case in cases:
        coloring = decode_token(case["token"])
        decoded = coloring.model_dump(mode="json", by_alias=True, exclude_none=True)
        assert decoded == without_none({**case["spec"], "v": 1})


def test_a_deeply_nested_token_is_a_token_error_not_a_crash() -> None:
    with pytest.raises(TokenError):
        decode_token(_b64("[" * 12000))
