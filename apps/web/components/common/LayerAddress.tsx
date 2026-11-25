import { Box, Link, Tooltip } from "@mui/material";
import { useTranslation } from "react-i18next";

import {
  type AddressedOrigin,
  addressShownTo,
  readableAddress,
  shortAddress,
  withoutQuery,
  withoutScheme,
} from "@/lib/utils/layerOrigin";

import CopyButton from "@/components/common/CopyButton";

interface LayerAddressProps {
  origin: AddressedOrigin;
  /** The person may edit the dataset, so sees its address whole. Anyone else sees it without its query string,
   * fragment and user and password, where a key or a signature may sit. */
  canEdit: boolean;
}

/**
 * A layer's address, the value of an Address row (the Metadata tab, the dataset detail): the host and the last segment
 * in full and the folders between left out, decoded to read, wrapping where it must; the whole of it (as this person
 * may see it) on hover and in the copy. A file's address is a link that opens it in a new tab; a map service's or a
 * WFS's is text, as its tile template, GetMap request or capabilities open no useful page, and its query is left out
 * of the text. The copy button follows the text on its last line, so it never covers it. It takes the type of the row
 * it sits in.
 */
const LayerAddress = ({ origin, canEdit }: LayerAddressProps) => {
  const { t } = useTranslation("common");
  const href = addressShownTo(origin.url, canEdit);
  const link = origin.kind === "remote_file";
  const text = readableAddress(shortAddress(withoutScheme(link ? href : withoutQuery(href))));
  return (
    <Box component="span" sx={{ overflowWrap: "anywhere" }}>
      <Tooltip title={href} placement="bottom-start" arrow>
        {link ? (
          <Link href={href} target="_blank" rel="noopener noreferrer" underline="hover">
            {text}
          </Link>
        ) : (
          // Focusable, so a keyboard opens its tooltip as a pointer does.
          <span tabIndex={0}>{text}</span>
        )}
      </Tooltip>
      <Box component="span" sx={{ display: "inline-flex", verticalAlign: "middle", ml: 0.5 }}>
        <CopyButton value={href} label={t("metadata.copy_address")} />
      </Box>
    </Box>
  );
};

export default LayerAddress;
