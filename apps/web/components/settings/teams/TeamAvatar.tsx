"use client";

import UserAvatar from "@/components/dashboard/common/UserAvatar";

/** A team's picture, or its initials on a colour from its name. */
export default function TeamAvatar({
  name,
  src,
  size = 40,
}: {
  name: string;
  src?: string | null;
  size?: number;
}) {
  return (
    <UserAvatar
      id={name}
      name={name}
      src={src}
      size={size}
      sx={{ borderRadius: size >= 56 ? "14px" : "10px" }}
    />
  );
}
