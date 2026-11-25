#!/bin/sh
# Starts geoapi or processes with the certificates in GOAT_CA_BUNDLE trusted on
# top of the public CAs for raster files read over HTTPS (GDAL) and for S3
# (boto3). Both trust one CA file, certifi's, not the system store, so a file
# with only the company CA would refuse every public host: this writes
# certifi's CAs plus GOAT_CA_BUNDLE into one file and points
# GDAL_CURL_CA_BUNDLE and AWS_CA_BUNDLE at it (a value already set wins).
# Without GOAT_CA_BUNDLE the service starts unchanged.
set -eu

if [ -n "${GOAT_CA_BUNDLE:-}" ]; then
  if [ ! -r "$GOAT_CA_BUNDLE" ]; then
    echo "ca-bundle.sh: GOAT_CA_BUNDLE $GOAT_CA_BUNDLE is not readable" >&2
    exit 1
  fi
  if ! grep -q -- "-----BEGIN CERTIFICATE-----" "$GOAT_CA_BUNDLE"; then
    echo "ca-bundle.sh: no certificate found in $GOAT_CA_BUNDLE" >&2
    exit 1
  fi
  bundle="${TMPDIR:-/tmp}/goat-ca-bundle.pem"
  { cat "$(python -c 'import certifi; print(certifi.where())')"; echo; cat "$GOAT_CA_BUNDLE"; } > "$bundle"
  export GDAL_CURL_CA_BUNDLE="${GDAL_CURL_CA_BUNDLE:-$bundle}"
  export AWS_CA_BUNDLE="${AWS_CA_BUNDLE:-$bundle}"
  echo "ca-bundle.sh: trusting the public CAs and $GOAT_CA_BUNDLE for raster files and S3"
fi

exec "$@"
