"""Refuse user-supplied URLs that would make the server fetch from inside.

A WFS import runs in the worker, and geoapi and processes read raster files, so
whatever address a user types in is fetched from our network, not theirs:
without a check, `http://169.254.169.254/` or a cluster-internal service name
reads back through the server. Only http(s) addresses whose every resolved IP is
globally routable pass, and hosts a deployment lists on purpose (its own object
store).

Residuals, accepted for now: the name is resolved again when GDAL connects
(DNS rebinding), and GDAL follows HTTP redirects without asking us.
"""

from __future__ import annotations

import ipaddress
import socket
import unicodedata
from collections.abc import Collection
from urllib.parse import urlparse

from urllib3.util import parse_url


class UnsafeUrlError(ValueError):
    """The URL is not an http(s) address that resolves to public IPs only."""


def _client_host(host: str | None) -> str | None:
    """`urllib.parse`'s host as urllib3 writes it: an IPv6 address in brackets,
    a zone id unquoted, a non-ASCII name in punycode."""
    if host is None:
        return None
    return parse_url(f"http://[{host}]" if ":" in host else f"http://{host}").host


def assert_unambiguous_url(url: str) -> None:
    """Raise `UnsafeUrlError` unless `url`, without the whitespace around it,
    reads the same to `urllib.parse` (this guard, GDAL) and to urllib3 (the
    HTTP client): no backslash, whitespace or control character inside it, and
    the same scheme, host and port for both. Resolves nothing."""
    text = url.strip()
    if any(c == "\\" or c.isspace() or unicodedata.category(c) == "Cc" for c in text):
        raise UnsafeUrlError(
            "The service address holds a backslash, a space or a control character"
        )
    try:
        parsed = urlparse(text)
        read = (parsed.scheme or None, _client_host(parsed.hostname), parsed.port)
        client = parse_url(text)
    except ValueError as exc:
        raise UnsafeUrlError("The service address is not a valid URL") from exc
    if read != (client.scheme, client.host, client.port):
        raise UnsafeUrlError("The service address is not a valid URL")


def assert_public_http_url(url: str, allowed_hosts: Collection[str] = ()) -> None:
    """Raise `UnsafeUrlError` unless `url` is http(s), reads the same to every
    parser (`assert_unambiguous_url`) and resolves to public IPs or its host is
    one of `allowed_hosts`."""
    try:
        parsed = urlparse(url.strip())
        port = parsed.port
    except ValueError as exc:
        # A port that is no number, such as a tile template's `{switch:a,b}`.
        raise UnsafeUrlError("The service address is not a valid URL") from exc
    if parsed.scheme not in ("http", "https"):
        raise UnsafeUrlError("Only http and https service addresses can be used")
    host = parsed.hostname
    if not host:
        raise UnsafeUrlError("The service address has no host")
    assert_unambiguous_url(url)
    if host.lower() in {h.strip().lower() for h in allowed_hosts}:
        return

    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError) as exc:
        raise UnsafeUrlError(f"Could not resolve {host}") from exc

    for info in infos:
        # Strip an IPv6 zone id (`fe80::1%eth0`) before parsing.
        address = ipaddress.ip_address(str(info[4][0]).split("%", 1)[0])
        if not address.is_global:
            raise UnsafeUrlError(f"{host} resolves to a non-public address")
