import hashlib
import logging
import posixpath
from typing import Any, BinaryIO, Dict

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from core.core.config import settings
from fastapi import HTTPException, status
from goatlib.storage.s3_config import ASSETS_PREFIX, boto_client_kwargs

logger = logging.getLogger(__name__)

# ASSETS_PREFIX (goatlib's storage.s3_config): where assets live in the data
# bucket with ASSETS_SERVED_BY_CORE. The route that serves them signs keys
# under this prefix only, never user uploads.
# Lifetime of the signed URL the asset route redirects to; browsers cache the
# redirect for half of it, so a cached one never points at an expired URL.
ASSET_URL_EXPIRES = 3600


class S3Service:
    """Core's S3 access.

    Every handler here catches `ClientError` *and* `BotoCoreError`:
    the first is what the service refused, the second is what never
    reached it — absent credentials, an unreachable endpoint, a timeout.
    They are siblings rather than parent and child, so catching only the
    first turns a misconfigured deployment into an unhandled 500 instead
    of the HTTP error, or the default artwork, each caller expects.
    """

    def __init__(self) -> None:
        """S3 client for AWS or any S3-compatible store (Hetzner, MinIO, on-prem)."""
        extra_kwargs = boto_client_kwargs(
            endpoint_url=settings.S3_ENDPOINT_URL,
            provider=settings.S3_PROVIDER,
            force_path_style=settings.S3_FORCE_PATH_STYLE,
        )

        self.s3_client = boto3.client(
            "s3",
            aws_access_key_id=settings.S3_ACCESS_KEY_ID,
            aws_secret_access_key=settings.S3_SECRET_ACCESS_KEY,
            region_name=settings.S3_REGION,
            **extra_kwargs,
        )

        # Create a separate client for public URL signing (if different from internal)
        self._public_client = None
        if (
            settings.S3_PUBLIC_ENDPOINT_URL
            and settings.S3_PUBLIC_ENDPOINT_URL != settings.S3_ENDPOINT_URL
        ):
            public_extra = dict(extra_kwargs)
            public_extra["endpoint_url"] = settings.S3_PUBLIC_ENDPOINT_URL
            self._public_client = boto3.client(
                "s3",
                aws_access_key_id=settings.S3_ACCESS_KEY_ID,
                aws_secret_access_key=settings.S3_SECRET_ACCESS_KEY,
                region_name=settings.S3_REGION,
                **public_extra,
            )

        # Separate client for the assets bucket (avatars, documents), with its
        # own credentials, independent of the data bucket's provider. It is on
        # AWS unless ASSETS_S3_ENDPOINT_URL points at an S3-compatible store.
        self.assets_client = boto3.client(
            "s3",
            aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
            aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY,
            region_name=settings.AWS_REGION,
            **boto_client_kwargs(
                endpoint_url=settings.ASSETS_S3_ENDPOINT_URL,
                provider=None if settings.ASSETS_S3_ENDPOINT_URL else "aws",
                force_path_style=settings.ASSETS_S3_FORCE_PATH_STYLE,
            ),
        )

    def _asset_location(self, s3_key: str) -> tuple[Any, str | None, str]:
        """Client, bucket and key of an asset: the assets bucket, or the data
        bucket under ASSETS_PREFIX with ASSETS_SERVED_BY_CORE."""
        if settings.ASSETS_SERVED_BY_CORE:
            return self.s3_client, settings.S3_BUCKET_NAME, ASSETS_PREFIX + s3_key
        return self.assets_client, settings.AWS_S3_ASSETS_BUCKET, s3_key

    def upload_asset(self, fileobj: BinaryIO, s3_key: str, content_type: str) -> None:
        """Upload a file object to the assets bucket (avatars, documents)."""
        client, bucket, key = self._asset_location(s3_key)
        try:
            client.upload_fileobj(
                Fileobj=fileobj,
                Bucket=bucket,
                Key=key,
                ExtraArgs={"ContentType": content_type},
            )
        except (ClientError, BotoCoreError) as e:
            logger.error(f"Asset upload failed for {s3_key}: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Failed to upload asset: {e}",
            )

    def delete_asset(self, s3_key: str) -> None:
        """Delete an object from the assets bucket."""
        client, bucket, key = self._asset_location(s3_key)
        try:
            client.delete_object(Bucket=bucket, Key=key)
        except (ClientError, BotoCoreError) as e:
            logger.error(f"Asset delete failed for {s3_key}: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Failed to delete asset: {e}",
            )

    def asset_download_url(self, s3_key: str) -> str:
        """A short-lived signed GET URL of an asset in the data bucket
        (ASSETS_SERVED_BY_CORE), on the endpoint browsers reach."""
        client = self._public_client if self._public_client else self.s3_client
        try:
            return client.generate_presigned_url(
                "get_object",
                Params={
                    "Bucket": settings.S3_BUCKET_NAME,
                    "Key": ASSETS_PREFIX + s3_key,
                },
                ExpiresIn=ASSET_URL_EXPIRES,
            )
        except (ClientError, BotoCoreError) as e:
            logger.error(f"Asset URL signing failed for {s3_key}: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to sign the asset URL",
            )

    def generate_presigned_put(
        self,
        bucket_name: str,
        s3_key: str,
        content_type: str,
        expires_in: int = 300,
    ) -> Dict[str, Any]:
        """Presigned PUT for a browser upload straight to object storage.

        Signed with the public-endpoint client: a SigV4 query signature covers
        the Host header, so the URL cannot be rewritten after signing. PUT
        carries no size policy; the importer checks the object size before
        it downloads.
        """
        try:
            client = self._public_client if self._public_client else self.s3_client
            url = client.generate_presigned_url(
                "put_object",
                Params={
                    "Bucket": bucket_name,
                    "Key": s3_key,
                    "ContentType": content_type,
                },
                ExpiresIn=expires_in,
                HttpMethod="PUT",
            )
            return {
                "url": url,
                "key": s3_key,
                "headers": {"Content-Type": content_type},
            }
        except (ClientError, BotoCoreError) as e:
            logger.error(f"S3 presigned PUT failed: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Failed to generate presigned PUT: {e}",
            )

    def upload_file(
        self,
        file_content: BinaryIO,
        bucket_name: str,
        s3_key: str,
        content_type: str = "application/octet-stream",
    ) -> str:
        """Upload a file server-side (API → S3)."""
        try:
            self.s3_client.upload_fileobj(
                file_content,
                bucket_name,
                s3_key,
                ExtraArgs={"ContentType": content_type},
            )
            return f"s3://{bucket_name}/{s3_key}"
        except (ClientError, BotoCoreError) as e:
            logger.error(f"S3 upload failed: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Failed to upload file: {e}",
            )

    def generate_presigned_download_url(
        self,
        bucket_name: str,
        s3_key: str,
        expires_in: int = 3600,
        filename: str | None = None,
    ) -> str:
        """Generate a presigned GET URL for downloading an object.

        Args:
            bucket_name: The S3 bucket name
            s3_key: The object key in S3
            expires_in: URL expiration time in seconds
            filename: Optional filename for Content-Disposition header (forces download)
        """
        try:
            params = {"Bucket": bucket_name, "Key": s3_key}

            # Add Content-Disposition to force download instead of inline display
            if filename:
                params["ResponseContentDisposition"] = (
                    f'attachment; filename="{filename}"'
                )

            return self.s3_client.generate_presigned_url(
                "get_object",
                Params=params,
                ExpiresIn=expires_in,
            )
        except (ClientError, BotoCoreError) as e:
            logger.error(f"Presigned download URL failed: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Failed to generate presigned download URL: {e}",
            )

    def delete_file(self, bucket_name: str, s3_key: str) -> None:
        """Delete an object from S3."""
        try:
            self.s3_client.delete_object(Bucket=bucket_name, Key=s3_key)
        except (ClientError, BotoCoreError) as e:
            logger.error(f"Delete failed for {bucket_name}/{s3_key}: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Failed to delete file: {e}",
            )

    def download_file(self, bucket_name: str, s3_key: str, dest_path: str) -> None:
        """Download an object from S3 to a local path."""
        try:
            self.s3_client.download_file(bucket_name, s3_key, dest_path)
        except (ClientError, BotoCoreError) as e:
            logger.error(f"Download failed for {bucket_name}/{s3_key}: {e}")
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Failed to download file: {e}",
            )

    def get_thumbnail_url(
        self,
        thumbnail_key: str | None,
        default_url: str | None = None,
        expires_in: int = 3600,
    ) -> str | None:
        """Convert a thumbnail S3 key to a presigned URL.

        If the thumbnail_key is already a full URL (http/https) or a
        root-relative path (the artwork the web app ships), returns it as-is.
        If it's an S3 key (starts with 'thumbnails/'), generates a presigned URL.
        If it's None or empty, returns the default_url.

        Args:
            thumbnail_key: S3 key or full URL for the thumbnail
            default_url: Default URL to return if thumbnail_key is None
            expires_in: Presigned URL expiration time in seconds (default 1 hour)
        """
        if not thumbnail_key:
            return default_url

        # A full URL or a root-relative path is returned as-is
        if thumbnail_key.startswith(("http://", "https://", "/")):
            return thumbnail_key

        # It's an S3 key, generate presigned URL using public client if available
        try:
            # Use public client for user-facing URLs (if configured)
            client = self._public_client if self._public_client else self.s3_client
            params = {"Bucket": settings.S3_BUCKET_NAME, "Key": thumbnail_key}
            return client.generate_presigned_url(
                "get_object",
                Params=params,
                ExpiresIn=expires_in,
            )
        except (ClientError, BotoCoreError) as e:
            logger.warning(f"Failed to generate presigned URL for {thumbnail_key}: {e}")
            return default_url

    @staticmethod
    def calculate_sha256(file_content: bytes) -> str:
        return hashlib.sha256(file_content).hexdigest()

    @staticmethod
    def build_s3_key(*parts: str) -> str:
        """Safely join S3 key parts into a normalized prefix/key."""
        return posixpath.join(*(p.strip("/") for p in parts if p))


s3_service = S3Service()
