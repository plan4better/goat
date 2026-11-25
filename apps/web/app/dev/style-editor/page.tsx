// The style panel on real data without a project, for development and the panel's measurements and end-to-end
// tests: /dev/style-editor?layer=<dataset id>[&doc=<url-encoded GOAT Style JSON>] (raster files too), or a map
// service by its address: ?service=<tile URL>&kind=wms|wmts|xyz. Not served in production.
import { notFound } from "next/navigation";

import { DevStyleEditor } from "@/app/dev/style-editor/DevStyleEditor";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const params = await searchParams;
  const layer = typeof params.layer === "string" ? params.layer : "";
  const doc = typeof params.doc === "string" ? params.doc : undefined;
  const text = (key: string) => (typeof params[key] === "string" ? (params[key] as string) : undefined);
  return <DevStyleEditor layerId={layer} initialDoc={doc} service={text("service")} kind={text("kind")} />;
}
