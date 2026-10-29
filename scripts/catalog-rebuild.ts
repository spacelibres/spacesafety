/**
 * Rebuild `catalog` from the stored trajectories.
 *
 * `catalog` is the set of trajectories screening actually pairs. Nothing in the
 * ingest scripts wrote to it, so after a bulk import the table was empty and every
 * object was invisible to screening — the data was in the database but nothing was
 * ever compared.
 *
 * One entry per object, chosen by `selectReference` (operator ephemeris first).
 *
 *   npm run catalog:rebuild            # apply
 *   npm run catalog:rebuild -- --dry-run
 */

async function main() {
  const { getDb } = await import("../src/db");
  const { catalog, objects, trajectories } = await import("../src/db/schema");
  const { selectReference, sourceRank } = await import("../src/lib/orbit/catalog-policy");

  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");

  const { db, sqlite } = getDb();

  const objectNames = new Map(db.select().from(objects).all().map((o) => [o.id, o.objectName]));
  const rows = db
    .select({
      id: trajectories.id,
      objectId: trajectories.objectId,
      stateSource: trajectories.stateSource,
      uploadedAt: trajectories.uploadedAt,
      startAt: trajectories.startAt,
      endAt: trajectories.endAt,
      pointCount: trajectories.pointCount,
      hasCovariance: trajectories.hasCovariance,
    })
    .from(trajectories)
    .all();

  const byObject = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byObject.get(row.objectId) ?? [];
    list.push(row);
    byObject.set(row.objectId, list);
  }

  const chosen: Array<{ objectId: string; name: string; pick: (typeof rows)[number]; others: number }> = [];
  for (const [objectId, list] of byObject) {
    const pick = selectReference(
      list.map((r) => ({
        trajectoryId: r.id,
        stateSource: r.stateSource,
        uploadedAt: r.uploadedAt,
        pointCount: r.pointCount,
        spanMs:
          r.startAt && r.endAt
            ? new Date(r.endAt).getTime() - new Date(r.startAt).getTime()
            : undefined,
      })),
    );
    if (!pick) continue;
    const full = list.find((r) => r.id === pick.trajectoryId);
    if (!full) continue;
    chosen.push({
      objectId,
      name: objectNames.get(objectId) ?? objectId,
      pick: full,
      others: list.length - 1,
    });
  }

  const bySource = new Map<string, number>();
  for (const c of chosen) {
    bySource.set(c.pick.stateSource, (bySource.get(c.pick.stateSource) ?? 0) + 1);
  }

  console.log(`\n${chosen.length} object(s) have a usable trajectory\n`);
  for (const [source, n] of [...bySource].sort((a, b) => sourceRank(a[0]) - sourceRank(b[0]))) {
    console.log(`  ${source.padEnd(20)} ${String(n).padStart(4)} object(s)`);
  }

  const sample = chosen.slice(0, 5);
  console.log("\n  sample:");
  for (const c of sample) {
    console.log(
      `    ${c.name.padEnd(18)} -> ${c.pick.stateSource.padEnd(20)} ` +
        `${String(c.pick.pointCount).padStart(6)} states  ` +
        `span=${c.pick.startAt && c.pick.endAt ? ((new Date(c.pick.endAt).getTime() - new Date(c.pick.startAt).getTime()) / 86400000).toFixed(1) + "d" : "-"}  ` +
        `cov=${c.pick.hasCovariance ? "yes" : "no"}  ` +
        `(+${c.others} other feed(s) kept)`,
    );
  }

  if (dryRun) {
    console.log("\ndry run: catalog unchanged");
    return;
  }

  const now = new Date().toISOString();
  let written = 0;
  sqlite.transaction(() => {
    db.delete(catalog).run();
    for (const c of chosen) {
      db.insert(catalog)
        .values({
          objectId: c.objectId,
          stateSource: c.pick.stateSource,
          trajectoryId: c.pick.id,
          updatedAt: now,
        })
        .run();
      written += 1;
    }
  })();

  console.log(`\nwrote ${written} catalog row(s)`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Keep this file a module: see the note in the other scripts.
export {};
