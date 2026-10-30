import { createReadStream, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { Readable } from "node:stream";

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const ROOT = "data/models";

/** Only mesh and preview files are served; the directory is not browsable. */
const ALLOWED = /\.(glb|gltf|png|jpg|jpeg|webp)$/i;

/** MIME type by extension; `octet-stream` makes images fail to render. */
function contentType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".glb")) return "model/gltf-binary";
  if (lower.endsWith(".gltf")) return "model/gltf+json";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

/**
 * Serve a downloaded model or preview.
 *
 * `data/models` sits outside `public/` because the files are fetched artefacts, not
 * source — `data/` is gitignored and hundreds of megabytes have no place in the
 * repository. A rewrite maps `/models/*` here.
 *
 * The path is resolved and then checked: a traversal attempt like `../../.env.local`
 * normalises outside the root and is rejected, rather than being trusted because the
 * URL did not literally contain `..`.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await params;
  const relative = normalize(path.join("/")).replace(/^\/+/, "");

  if (relative.includes("..") || !ALLOWED.test(relative)) {
    return NextResponse.json({ error: "not an allowed file" }, { status: 400 });
  }

  const full = join(ROOT, relative);
  const rootAbs = join(process.cwd(), ROOT);
  const fullAbs = join(process.cwd(), full);
  if (!fullAbs.startsWith(rootAbs)) {
    return NextResponse.json({ error: "path escapes the models root" }, { status: 400 });
  }

  let size: number;
  try {
    const st = statSync(fullAbs);
    if (!st.isFile()) throw new Error("not a file");
    size = st.size;
  } catch {
    return NextResponse.json({ error: "file not found" }, { status: 404 });
  }

  const stream = Readable.toWeb(createReadStream(fullAbs)) as ReadableStream;

  return new NextResponse(stream, {
    headers: {
      "Content-Type": contentType(relative),
      "Content-Length": String(size),
      "Cache-Control": "public, max-age=86400",
    },
  });
}
