"""The guard in front of every server-side fetch of a user-supplied URL."""

import socket
from pathlib import Path
from typing import Any

import pytest
from goatlib.io.remote_source.url_guard import UnsafeUrlError, assert_public_http_url


def _resolves_to(monkeypatch: pytest.MonkeyPatch, *addresses: str) -> None:
    def fake_getaddrinfo(host: str, *args: Any, **kwargs: Any) -> list[Any]:
        return [
            (socket.AF_INET6 if ":" in a else socket.AF_INET, 0, 0, "", (a, 0))
            for a in addresses
        ]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)


def test_public_https_url_passes(monkeypatch: pytest.MonkeyPatch) -> None:
    _resolves_to(monkeypatch, "93.184.216.34")
    assert_public_http_url("https://geo.example/wfs?SERVICE=WFS")


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://geo.example/wfs",
        "/vsicurl/http://geo.example/wfs",
        "https:///no-host",
    ],
)
def test_non_http_or_hostless_urls_are_refused(url: str) -> None:
    with pytest.raises(UnsafeUrlError):
        assert_public_http_url(url)


@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",
        "10.0.0.5",
        "172.16.3.4",
        "192.168.1.10",
        "169.254.169.254",  # cloud metadata
        "100.64.0.1",  # carrier-grade NAT
        "0.0.0.0",
        "::1",
        "fd00::1",
        "fe80::1",
    ],
)
def test_internal_addresses_are_refused(
    monkeypatch: pytest.MonkeyPatch, address: str
) -> None:
    _resolves_to(monkeypatch, address)
    with pytest.raises(UnsafeUrlError):
        assert_public_http_url("http://looks-public.example/wfs")


def test_one_internal_address_among_public_ones_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _resolves_to(monkeypatch, "93.184.216.34", "10.0.0.5")
    with pytest.raises(UnsafeUrlError):
        assert_public_http_url("https://geo.example/wfs")


def test_unresolvable_host_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    def fail(*args: Any, **kwargs: Any) -> list[Any]:
        raise socket.gaierror("no such host")

    monkeypatch.setattr(socket, "getaddrinfo", fail)
    with pytest.raises(UnsafeUrlError):
        assert_public_http_url("https://nowhere.invalid/wfs")


def test_from_wfs_refuses_an_internal_url_before_fetching(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    pytest.importorskip("osgeo")
    from goatlib.io.remote_source import wfs

    _resolves_to(monkeypatch, "169.254.169.254")

    def must_not_fetch(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("fetched an internal URL")

    monkeypatch.setattr(wfs, "_fetch_wfs_layers", must_not_fetch)
    with pytest.raises(UnsafeUrlError):
        wfs.from_wfs("http://metadata.example/wfs?SERVICE=WFS", tmp_path)


def test_a_listed_host_may_resolve_to_a_private_address(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _resolves_to(monkeypatch, "10.0.0.7")
    assert_public_http_url(
        "http://minio.internal:9000/b/x.tif", allowed_hosts=("MinIO.internal",)
    )
    with pytest.raises(UnsafeUrlError):
        assert_public_http_url(
            "http://other.internal/x.tif", allowed_hosts=("minio.internal",)
        )
