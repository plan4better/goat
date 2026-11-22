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
        # A tile template's subdomain list reads as a port: refused, not a crash.
        "https://{switch:a,b}.example.org/x.tif",
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


@pytest.mark.parametrize(
    "url",
    [
        "https://geo.example/wfs?SERVICE=WFS",
        "http://user:password@geo.example:8080/x.tif",
        "http://user@geo.example/x.tif",
        "http://[2001:db8::1]:8080/x.tif",
        "https://tile.example/{z}/{x}/{y}.png",
        "HTTP://Geo.EXAMPLE/x.tif",
        "https://müller.example/x.tif",
        "http://geo.example:/x.tif",
        "http://geo.example/x.tif#part",
        "https://geo.example/x.tif?next=@other.example",
        "  https://geo.example/x.tif\n",
    ],
)
def test_ordinary_addresses_still_pass(
    monkeypatch: pytest.MonkeyPatch, url: str
) -> None:
    _resolves_to(monkeypatch, "93.184.216.34")
    assert_public_http_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "http://10.0.0.5:8080\\@geo.example/x.tif",
        "http://geo.example\\x.tif",
        "http://geo.example/x y.tif",
        "http://geo.example/x\ty.tif",
        "http://geo.example\r\n/x.tif",
        "http://geo.example/x\x00.tif",
        "http://geo.example/x\x7f.tif",
        "http://geo.example/x y.tif",
    ],
)
def test_an_address_with_a_backslash_whitespace_or_control_character_is_refused(
    monkeypatch: pytest.MonkeyPatch, url: str
) -> None:
    _resolves_to(monkeypatch, "93.184.216.34")
    with pytest.raises(UnsafeUrlError):
        assert_public_http_url(url)
    # Also when its host is one the deployment lists.
    with pytest.raises(UnsafeUrlError):
        assert_public_http_url(url, allowed_hosts=("geo.example",))


def test_an_address_the_http_client_reads_with_another_host_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The host checked is the host the HTTP client connects to: scheme, host
    and port as `urllib.parse` reads them must be what urllib3 reads."""
    from goatlib.io.remote_source import url_guard

    _resolves_to(monkeypatch, "93.184.216.34")
    real = url_guard.parse_url

    def reads_another_host(url: str) -> Any:
        parsed = real(url)
        if url.endswith("/x.tif"):
            return parsed._replace(host="10.0.0.5")
        return parsed

    monkeypatch.setattr(url_guard, "parse_url", reads_another_host)
    with pytest.raises(UnsafeUrlError):
        assert_public_http_url("https://geo.example/x.tif")
    with pytest.raises(UnsafeUrlError):
        assert_public_http_url(
            "https://geo.example/x.tif", allowed_hosts=("geo.example",)
        )


def test_the_address_check_alone_resolves_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from goatlib.io.remote_source.url_guard import assert_unambiguous_url

    def must_not_resolve(*args: Any, **kwargs: Any) -> list[Any]:
        raise AssertionError("resolved a host")

    monkeypatch.setattr(socket, "getaddrinfo", must_not_resolve)
    assert_unambiguous_url("http://user:password@[2001:db8::1]:8080/{z}/{x}/{y}.png")
    with pytest.raises(UnsafeUrlError):
        assert_unambiguous_url("http://10.0.0.5:8080\\@geo.example/x.tif")
