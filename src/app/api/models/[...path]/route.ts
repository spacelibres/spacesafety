import { createReadStream, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { Readable } from "node:stream";

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const ROOT = "data/models";

/** Only mesh and preview files are served; the directory is not browsable. */
const ALLOWED = /\.(glb|gltf|png|jpg|jpeg|webp)$/i;

/**
 * Serve a downloaded model.
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
    return NextResponse.json({ error: "不允许的文件" }, { status: 400 });
  }

  const full = join(ROOT, relative);
  const rootAbs = join(process.cwd(), ROOT);
  const fullAbs = join(process.cwd(), full);
  if (!fullAbs.startsWith(rootAbs)) {
    return NextResponse.json({ error: "路径越界" }, { status: 400 });
  }

  let size: number;
  try {
    const st = statSync(fullAbs);
    if (!st.isFile()) throw new Error("not a file");
    size = st.size;
  } catch {
    return NextResponse.json({ error: "文件不存在" }, { status: 404 });
  }

  const stream = Readable.toWeb(createReadStream(fullAbs)) as ReadableStream;

  return new NextResponse(stream, {
    headers: {
      "Content-Type": relative.toLowerCase().endsWith(".glb")
        ? "model/gltf-binary"
        : "application/octet-stream",
      "Content-Length": String(size),
      "Cache-Control": "public, max-age=86400",
    },
  });
}
