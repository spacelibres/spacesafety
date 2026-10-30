import { Topbar } from "@/components/Shell";
import { getDb } from "@/db";
import { getTranslator } from "@/lib/i18n/registry";

export const dynamic = "force-dynamic";

interface ModelRow {
  id: string;
  source: string;
  name: string;
  filename: string;
  sizeBytes: number;
  localPath: string | null;
  previewUrl: string | null;
}

/** Static serving path for a downloaded mesh, relative to the project root. */
function localUrl(p: string | null): string | null {
  if (!p) return null;
  const i = p.indexOf("data/models/");
  if (i === -1) return null;
  return `/models/${p.slice(i + "data/models/".length)}`;
}

/**
 * The 3D model library.
 *
 * Two sources with very different coverage: NASA's public repository (257 meshes,
 * 186 spacecraft) and the Spacebook subscription (42). Starlink and ESA publish no
 * meshes at all, so a commercial constellation appears only where Spacebook covers
 * it — stated on the page rather than left as a silent gap.
 */
export default async function ModelsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; source?: string }>;
}) {
  const t = await getTranslator();
  const sp = await searchParams;
  const { sqlite, db } = getDb();
  void db;

  const has = (
    sqlite
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='model_asset'")
      .get() as { n: number }
  ).n > 0;

  const where: string[] = [];
  const params: unknown[] = [];
  if (sp.q) {
    where.push("name LIKE ?");
    params.push(`%${sp.q.toUpperCase()}%`);
  }
  if (sp.source) {
    where.push("source = ?");
    params.push(sp.source);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = has
    ? (sqlite
        .prepare(
          `SELECT id, source, name, filename, size_bytes AS sizeBytes,
                  local_path AS localPath, preview_url AS previewUrl
             FROM model_asset ${clause}
            ORDER BY source, name
            LIMIT 500`,
        )
        .all(...params) as ModelRow[])
    : [];

  const totals = has
    ? (sqlite
        .prepare(
          `SELECT source, COUNT(*) AS n,
                  SUM(CASE WHEN local_path IS NOT NULL THEN 1 ELSE 0 END) AS local,
                  SUM(size_bytes) AS bytes
             FROM model_asset GROUP BY source`,
        )
        .all() as Array<{ source: string; n: number; local: number; bytes: number }>)
    : [];

  return (
    <>
      <Topbar section={t.t("nav.models")} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{t.t("models.title")}</h1>
          <span className="count">
            {totals.reduce((a, x) => a + x.n, 0)} {t.t("models.count")}
          </span>
        </div>

        <div className="filters">
          {totals.map((x) => (
            <span key={x.source} className="count">
              {x.source}: {x.local}/{x.n} · {(x.bytes / 1e6).toFixed(0)} MB
            </span>
          ))}
        </div>

        <form method="get" className="filters">
          <div className="filter-group">
            <span>{t.t("column.name")}</span>
            <input name="q" defaultValue={sp.q ?? ""} aria-label={t.t("column.name")} />
          </div>
          <button type="submit" className="btn">
            {t.t("catalogue.search")}
          </button>
          <div className="filters-spacer" />
          <span className="count">{rows.length}</span>
        </form>

        {!has || rows.length === 0 ? (
          <div className="card">
            <div className="table-wrap">
              <p className="empty">
                {t.t("models.empty")}{" "}
                <code className="mono">npm run models:sync --download</code>
              </p>
            </div>
          </div>
        ) : (
          <div className="model-grid">
            {rows.map((m) => {
              const url = localUrl(m.localPath);
              return (
                <div key={m.id} className="model-card">
                  {m.previewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={m.previewUrl} alt={m.name} className="model-thumb" loading="lazy" />
                  ) : (
                    <div className="model-thumb model-thumb-empty" />
                  )}
                  <div className="model-meta">
                    <div className="model-name">{m.name}</div>
                    <div className="model-sub mono-sm muted">
                      {(m.sizeBytes / 1e6).toFixed(1)} MB
                      {url ? "" : " · " + t.t("models.remote")}
                    </div>
                  </div>
                  {url && (
                    <a className="btn" href={url} download>
                      {t.t("models.download")}
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
