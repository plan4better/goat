"use client";

import { Link, Typography } from "@mui/material";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslation } from "react-i18next";

/**
 * Under a dataset's footprint, for a visitor without a sign-in: the data itself is shown to signed-in users only.
 * The line is the app's sign-in link, and leads back to this page.
 */
const CatalogSignInHint = () => {
  const { t } = useTranslation("common");
  const pathname = usePathname();
  const query = useSearchParams()?.toString();
  const here = `${pathname ?? "/"}${query ? `?${query}` : ""}`;
  return (
    <Typography variant="body2" color="text.secondary">
      <Link href={`/auth/login?callbackUrl=${encodeURIComponent(here)}`} underline="hover">
        {t("catalog_sign_in_to_see_data")}
      </Link>
    </Typography>
  );
};

export default CatalogSignInHint;
