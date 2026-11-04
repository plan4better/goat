"""TLS trust of the assistant's outbound clients.

``GOAT_CA_BUNDLE`` names a PEM file with one or more CA certificates (a company
CA, or Caddy's root with ``GOAT_TLS=internal``). The assistant trusts it in
addition to the system CAs, as core does, so a company CA never cuts it off
from public model providers. ``SSL_CERT_FILE`` and ``REQUESTS_CA_BUNDLE`` keep
their standard meaning: OpenSSL reads ``SSL_CERT_FILE`` (and ``SSL_CERT_DIR``)
as the system store, so they still replace it.
"""

import ssl
from typing import Literal


def ssl_context(ca_bundle: str | None) -> ssl.SSLContext | Literal[True]:
    """The ``verify`` value of an HTTP client: ``True`` (the library's default
    verification) without a bundle, otherwise a context with the system CAs
    plus the bundle. A missing file raises ``OSError``, a file without
    certificates ``ssl.SSLError``; verification is never dropped."""
    if not ca_bundle:
        return True
    context = ssl.create_default_context()
    context.load_verify_locations(cafile=ca_bundle)
    return context
