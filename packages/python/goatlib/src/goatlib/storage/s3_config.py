"""S3 client settings derived from the endpoint, not from the provider's name.

Every S3-compatible store is reached the same way: a custom ``endpoint_url``,
SigV4, and either path-style or virtual-host addressing. ``S3_FORCE_PATH_STYLE``
selects the addressing; MinIO implies it because it never supports the other.
DuckDB's httpfs takes the endpoint as ``host[:port]`` and the scheme as a
separate ``s3_use_ssl`` flag, so both are derived from the one URL here.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit


def use_path_style(provider: str | None, force_path_style: bool) -> bool:
    return bool(force_path_style) or (provider or "").lower() == "minio"


def boto_client_kwargs(
    *,
    endpoint_url: str | None,
    provider: str | None,
    force_path_style: bool,
) -> dict[str, Any]:
    """Extra keyword arguments for ``boto3.client("s3", ...)``.

    AWS without a custom endpoint keeps boto3's defaults. Anything else gets
    SigV4 with the addressing style chosen by ``use_path_style``.
    """
    from botocore.client import Config

    kwargs: dict[str, Any] = {}
    if endpoint_url:
        kwargs["endpoint_url"] = endpoint_url
    if not endpoint_url and (provider or "aws").lower() == "aws":
        return kwargs
    kwargs["config"] = Config(
        signature_version="s3v4",
        s3={
            "payload_signing_enabled": False,
            "addressing_style": "path"
            if use_path_style(provider, force_path_style)
            else "virtual",
        },
    )
    return kwargs


def duckdb_s3_endpoint(endpoint_url: str) -> tuple[str, bool | None]:
    """``(host[:port], use_ssl)`` for DuckDB's ``s3_endpoint`` / ``s3_use_ssl``.

    DuckDB rejects a scheme inside ``s3_endpoint``, so it is stripped and turned
    into the SSL flag. An endpoint given without a scheme leaves the flag
    untouched (``None``), which keeps DuckDB's default of TLS.
    """
    if "://" not in endpoint_url:
        return endpoint_url, None
    parts = urlsplit(endpoint_url)
    host = parts.netloc or parts.path
    if parts.path and parts.netloc and parts.path not in ("", "/"):
        host = f"{parts.netloc}{parts.path.rstrip('/')}"
    return host, parts.scheme.lower() != "http"


def duckdb_url_style(provider: str | None, force_path_style: bool) -> str:
    return "path" if use_path_style(provider, force_path_style) else "vhost"


def apply_duckdb_s3_settings(
    con: Any,
    *,
    endpoint_url: str | None,
    access_key: str | None,
    secret_key: str | None,
    region: str | None = None,
    provider: str | None = None,
    force_path_style: bool = True,
) -> None:
    """Point a DuckDB connection at an S3-compatible store."""
    if region:
        con.execute("SET s3_region = ?", [region])
    if endpoint_url:
        host, use_ssl = duckdb_s3_endpoint(endpoint_url)
        con.execute("SET s3_endpoint = ?", [host])
        con.execute(
            f"SET s3_url_style = '{duckdb_url_style(provider, force_path_style)}'"
        )
        if use_ssl is not None:
            con.execute(f"SET s3_use_ssl = {'true' if use_ssl else 'false'}")
    if access_key:
        con.execute("SET s3_access_key_id = ?", [access_key])
    if secret_key:
        con.execute("SET s3_secret_access_key = ?", [secret_key])
