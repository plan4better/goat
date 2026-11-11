"use client";

import { Box, Skeleton, Table, TableBody, TableCell, TableHead, TableRow, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";

import { type CustomDomainConfig, useCustomDomainConfig } from "@/lib/api/customDomainConfig";
import { isApexDomain } from "@/lib/validations/customDomain";

import CopyButton from "@/components/settings/whiteLabel/CopyButton";

/** The one record a domain needs: an A record on `@` for a main domain, a
 * CNAME on the leftmost label for a subdomain. Core accepts either. */
export const dnsRecordOf = (
  domain: string,
  config?: CustomDomainConfig
): { type: "A" | "CNAME"; host: string; target: string } =>
  isApexDomain(domain)
    ? { type: "A", host: "@", target: config?.apex_ipv4 ?? "" }
    : { type: "CNAME", host: domain.split(".")[0] || domain, target: config?.cname_target ?? "" };

const mono = { fontFamily: "monospace", fontSize: 13 } as const;
const COLUMNS = [
  "settings_domains_col_type",
  "settings_domains_col_host",
  "settings_domains_col_target",
  "settings_domains_col_ttl",
];

/** The record as a table (Typ, Host, Ziel, TTL) with copy buttons. */
export function DnsRecordCard({ domain }: { domain: string }) {
  const { t } = useTranslation("common");
  const config = useCustomDomainConfig();
  const record = dnsRecordOf(domain, config);
  return (
    <Box sx={{ border: 1, borderColor: "divider", borderRadius: "8px", overflowX: "auto" }}>
      <Table size="small">
        <TableHead>
          <TableRow>
            {COLUMNS.map((key) => (
              <TableCell key={key} sx={{ fontWeight: 700 }}>
                {t(key)}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          <TableRow>
            <TableCell>
              <Typography sx={mono}>{record.type}</Typography>
            </TableCell>
            <TableCell>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <Typography sx={mono}>{record.host}</Typography>
                <CopyButton value={record.host} />
              </Box>
            </TableCell>
            <TableCell>
              {config ? (
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <Typography sx={{ ...mono, wordBreak: "break-all" }}>{record.target}</Typography>
                  {record.target && <CopyButton value={record.target} />}
                </Box>
              ) : (
                // The target comes from core's config: its place until it answers.
                <Skeleton variant="text" width={160} />
              )}
            </TableCell>
            <TableCell>
              <Typography sx={mono}>3600</Typography>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </Box>
  );
}
