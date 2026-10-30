"""CRS validation on the public download route.

`crs` is inlined into the `ST_Transform(...)` call and the GDAL `SRS`
option of a `COPY (...) TO file` statement, on a route that needs no
authentication, so only an EPSG code may reach the SQL.
"""

from unittest.mock import AsyncMock, patch

import pytest

from geoapi.routers.download import _normalize_crs

COLLECTION = "/collections/abc123de-f456-7890-1234-5678901234ab/download"

INJECTION = (
    "EPSG:4326', 'EPSG:3857', always_xy := true)) AS geometry, (SELECT 1) AS leak --"
)


class TestNormalizeCrs:
    def test_none_means_no_reprojection(self):
        assert _normalize_crs(None) is None
        assert _normalize_crs("") is None

    def test_epsg_code_passes(self):
        assert _normalize_crs("EPSG:25832") == "EPSG:25832"

    def test_lowercase_and_whitespace_are_normalized(self):
        assert _normalize_crs(" epsg:4326 ") == "EPSG:4326"

    def test_injection_payload_rejected(self):
        with pytest.raises(ValueError, match="Unsupported crs"):
            _normalize_crs(INJECTION)

    def test_non_epsg_authority_rejected(self):
        with pytest.raises(ValueError, match="Unsupported crs"):
            _normalize_crs("ESRI:102100")

    def test_bare_number_rejected(self):
        with pytest.raises(ValueError, match="Unsupported crs"):
            _normalize_crs("4326")


class TestDownloadRoute:
    @patch("geoapi.routers.download.layer_service")
    def test_injected_crs_is_rejected_before_any_work(
        self, mock_layer_service, test_client
    ):
        mock_layer_service.is_layer_in_public_project = AsyncMock(
            side_effect=AssertionError("export must not start for a bad crs")
        )

        response = test_client.get(
            COLLECTION, params={"format": "csv", "crs": INJECTION}
        )
        assert response.status_code == 400
        assert "crs" in response.json()["detail"]

    @patch("geoapi.routers.download.layer_service")
    def test_non_public_layer_still_403_for_a_valid_crs(
        self, mock_layer_service, test_client
    ):
        """A well-formed crs gets past validation and hits the public gate."""
        mock_layer_service.is_layer_in_public_project = AsyncMock(return_value=False)

        response = test_client.get(
            COLLECTION, params={"format": "csv", "crs": "EPSG:3857"}
        )
        assert response.status_code == 403


class TestDownloadCharge:
    @patch("geoapi.routers.download.charge_download", new_callable=AsyncMock)
    @patch("geoapi.routers.download._run_export")
    @patch("geoapi.routers.download.layer_service")
    def test_the_owner_pays_the_export_time_and_the_file(
        self,
        mock_layer_service,
        mock_export,
        mock_charge,
        test_client,
        tmp_path,
        monkeypatch,
    ):
        from types import SimpleNamespace

        from geoapi.routers import download

        monkeypatch.setattr(download.settings, "BILLING_ENABLED", True)
        mock_layer_service.is_layer_in_public_project = AsyncMock(return_value=True)
        mock_layer_service.get_layer_metadata = AsyncMock(
            return_value=SimpleNamespace(
                name="Layer", organization_id="org1", user_id="own1"
            )
        )
        zip_path = tmp_path / "layer.zip"
        zip_path.write_bytes(b"z" * 1234)
        mock_export.return_value = str(zip_path)

        response = test_client.get(COLLECTION, params={"format": "csv"})

        assert response.status_code == 200
        org, owner, layer, seconds, size = mock_charge.call_args.args
        assert (org, owner, size) == ("org1", "own1", 1234)
        assert layer.replace("-", "") == "abc123def456789012345678901234ab"
        assert seconds >= 0

    @patch("geoapi.routers.download.charge_download", new_callable=AsyncMock)
    @patch("geoapi.routers.download._run_export")
    @patch("geoapi.routers.download.layer_service")
    def test_nothing_is_charged_with_billing_off(
        self,
        mock_layer_service,
        mock_export,
        mock_charge,
        test_client,
        tmp_path,
        monkeypatch,
    ):
        from types import SimpleNamespace

        from geoapi.routers import download

        monkeypatch.setattr(download.settings, "BILLING_ENABLED", False)
        mock_layer_service.is_layer_in_public_project = AsyncMock(return_value=True)
        mock_layer_service.get_layer_metadata = AsyncMock(
            return_value=SimpleNamespace(
                name="Layer", organization_id="org1", user_id="own1"
            )
        )
        zip_path = tmp_path / "layer.zip"
        zip_path.write_bytes(b"z" * 10)
        mock_export.return_value = str(zip_path)

        assert test_client.get(COLLECTION, params={"format": "csv"}).status_code == 200
        mock_charge.assert_not_called()
