import { unstable_rethrow } from "next/navigation";
import { NextResponse } from "next/server";
import { runAs } from "@/server/context";
import { toAppError } from "@/server/errors";
import { getPrincipal, userStorage } from "@/server/session";
import { prepareDownload } from "@/server/services/documents";

/** Download: RLS decides access, the read is audited, and Supabase returns
 *  a 60-second signed URL. With local storage the bytes are streamed. */
export async function GET(_: Request, { params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params;
  const principal = await getPrincipal();
  try {
    const out = await runAs(principal, async (c) => {
      const d = await prepareDownload(c, await userStorage(), versionId);
      return d.url ? { url: d.url, bytes: null, file: d.file } : { url: null, bytes: await d.read(), file: d.file };
    });
    const nostore = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    if (out.url) return NextResponse.redirect(out.url, { headers: nostore });
    return new NextResponse(Buffer.from(out.bytes!), { headers: { ...nostore, "Content-Type": out.file.mime_type,
      "Content-Disposition": `attachment; filename="${out.file.original_filename.replace(/["\r\n]/g, "")}"` } });
  } catch (e) {
    unstable_rethrow(e);
    const err = toAppError(e);
    return NextResponse.json({ message: err.message }, { status: err.status });
  }
}
