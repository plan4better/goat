from typing import Any

import pytest
from goatlib.storage.s3_config import (
    apply_duckdb_s3_settings,
    boto_client_kwargs,
    duckdb_s3_endpoint,
    duckdb_url_style,
)


def addressing(kwargs: dict[str, Any]) -> str | None:
    config = kwargs.get("config")
    return None if config is None else config.s3["addressing_style"]


@pytest.mark.unit
def test_aws_without_endpoint_keeps_boto_defaults() -> None:
    assert (
        boto_client_kwargs(endpoint_url=None, provider="aws", force_path_style=False)
        == {}
    )


@pytest.mark.unit
def test_minio_is_always_path_style() -> None:
    kwargs = boto_client_kwargs(
        endpoint_url="http://minio:9000", provider="minio", force_path_style=False
    )
    assert kwargs["endpoint_url"] == "http://minio:9000"
    assert addressing(kwargs) == "path"
    assert kwargs["config"].signature_version == "s3v4"


@pytest.mark.unit
def test_hetzner_stays_virtual_host_unless_forced() -> None:
    kwargs = boto_client_kwargs(
        endpoint_url="https://nbg1.example", provider="hetzner", force_path_style=False
    )
    assert addressing(kwargs) == "virtual"
    forced = boto_client_kwargs(
        endpoint_url="https://nbg1.example", provider="hetzner", force_path_style=True
    )
    assert addressing(forced) == "path"


@pytest.mark.unit
def test_unknown_provider_follows_the_flag_not_the_name() -> None:
    plain = boto_client_kwargs(
        endpoint_url="https://store.example", provider="on-prem", force_path_style=False
    )
    forced = boto_client_kwargs(
        endpoint_url="https://store.example", provider="on-prem", force_path_style=True
    )
    assert addressing(plain) == "virtual"
    assert addressing(forced) == "path"
    assert plain["config"].signature_version == "s3v4"


@pytest.mark.unit
@pytest.mark.parametrize(
    ("endpoint", "expected"),
    [
        ("http://minio:9000", ("minio:9000", False)),
        ("https://store.example", ("store.example", True)),
        ("https://store.example:8443/s3", ("store.example:8443/s3", True)),
        ("minio:9000", ("minio:9000", None)),
    ],
)
def test_duckdb_endpoint_strips_the_scheme_into_the_ssl_flag(
    endpoint: str, expected: tuple[str, bool | None]
) -> None:
    assert duckdb_s3_endpoint(endpoint) == expected


@pytest.mark.unit
def test_duckdb_url_style_matches_boto_addressing() -> None:
    assert duckdb_url_style("minio", False) == "path"
    assert duckdb_url_style("hetzner", False) == "vhost"
    assert duckdb_url_style("on-prem", True) == "path"


class RecordingCon:
    def __init__(self) -> None:
        self.statements: list[tuple[str, list[Any] | None]] = []

    def execute(self, sql: str, params: list[Any] | None = None) -> None:
        self.statements.append((sql, params))


@pytest.mark.unit
def test_apply_sets_host_ssl_style_and_credentials() -> None:
    con = RecordingCon()
    apply_duckdb_s3_settings(
        con,
        endpoint_url="http://minio:9000",
        access_key="k",
        secret_key="s",
        region="us-east-1",
        provider="minio",
        force_path_style=False,
    )
    assert con.statements == [
        ("SET s3_region = ?", ["us-east-1"]),
        ("SET s3_endpoint = ?", ["minio:9000"]),
        ("SET s3_url_style = 'path'", None),
        ("SET s3_use_ssl = false", None),
        ("SET s3_access_key_id = ?", ["k"]),
        ("SET s3_secret_access_key = ?", ["s"]),
    ]


@pytest.mark.unit
def test_apply_without_endpoint_only_sets_credentials() -> None:
    con = RecordingCon()
    apply_duckdb_s3_settings(con, endpoint_url=None, access_key="k", secret_key=None)
    assert con.statements == [("SET s3_access_key_id = ?", ["k"])]
