/**
 * Repair and pair existing trajectories after the dual-feed change.
 *
 * Three things need fixing in a database that predates the OCM/ITC split:
 *
 *   1. **`has_covariance` is wrong on old rows.** The column defaulted to 0 when it
 *      was added, so every trajectory written before that reads as
 *      "no covariance" even when the file is full of it. Since a wrong flag makes
 *      the platform refuse to compute a Pc, this is a correctness bug, not
 *      cosmetics.
 *   2. **Duplicate trajectories.** Early demo runs inserted the same object more
 *      than once. Left alone they double every listing and make "the newest
 *      trajectory" ambiguous.
 *   3. **Unlinked pairs.** An object with both an OCM and an ITC should have them
 *      pointing at each other.
 *
 *   npm run migrate:trajectories -- --dry-run
 *   npm run migrate:trajectories
 */

export {};

async function main() {
  const { loadEnvLocal } = await import("./env");
  loadEnvLocal();
  const dryRun = process.argv.includes("--dry-run");

  const { getDb } = await import("../src/db");
  const { normaliseTrajectory } = await import("../src/lib/api/validate-trajectory");
  const { createHash } = await import("node:crypto");

  const { sqlite } = getDb();
  const hash = (t: string) => createHash("sha256").update(t).digest("hex");

  console.log(`\nSpace Safety — trajectory migration${dryRun ? " (dry run)" : ""}\n`);

  // ---------------------------------------------------------------- covariates
  const rows = sqlite
    .prepare(
      "SELECT id, object_id, file_format, has_covariance, file_text FROM trajectories ORDER BY object_id, uploaded_at",
    )
    .all() as Array<{
    id: string;
    object_id: string;
    file_format: string;
    has_covariance: number;
    file_text: string;
  }>;

  let flagged = 0;
  let unparseable = 0;
  for (const row of rows) {
    let actual: boolean;
    try {
      const n = normaliseTrajectory(row.file_text);
      actual = n.states.length > 0 && n.states.every((s) => s.covariance !== null);
    } catch {
      unparseable += 1;
      continue;
    }
    const stored = row.has_covariance === 1;
    if (stored === actual) continue;

    flagged += 1;
    console.log(
      `  ${row.id.slice(0, 8)} ${row.file_format.padEnd(4)} has_covariance ${stored} → ${actual}`,
    );
    if (!dryRun) {
      sqlite
        .prepare("UPDATE trajectories SET has_covariance = ? WHERE id = ?")
        .run(actual ? 1 : 0, row.id);
    }
  }
  console.log(`\n  covariance flag repaired: ${flagged}${unparseable ? `, unparseable: ${unparseable}` : ""}`);

  // ------------------------------------------------------------------ duplicates
  // Same object, same format, identical bytes: keep the earliest and drop the
  // rest. Dropping matters because listings and "latest" lookups would otherwise
  // see the object several times.
  const byKey = new Map<string, Array<{ id: string; uploaded_at: string; h: string }>>();
  const fresh = sqlite
    .prepare("SELECT id, object_id, file_format, uploaded_at, file_text FROM trajectories")
    .all() as Array<{
    id: string;
    object_id: string;
    file_format: string;
    uploaded_at: string;
    file_text: string;
  }>;
  for (const r of fresh) {
    const key = `${r.object_id}|${r.file_format}`;
    const list = byKey.get(key) ?? [];
    list.push({ id: r.id, uploaded_at: r.uploaded_at, h: hash(r.file_text) });
    byKey.set(key, list);
  }

  const removable: string[] = [];
  for (const list of byKey.values()) {
    const seen = new Set<string>();
    for (const item of list.sort((a, b) => a.uploaded_at.localeCompare(b.uploaded_at))) {
      if (seen.has(item.h)) removable.push(item.id);
      else seen.add(item.h);
    }
  }

  if (removable.length > 0) {
    console.log(`\n  exact duplicates: ${removable.length}`);
    // Any companion pointer to a removed row must be cleared first, or it would
    // dangle.
    for (const id of removable) {
      if (!dryRun) {
        sqlite.prepare("UPDATE trajectories SET companion_id = NULL WHERE companion_id = ?").run(id);
        sqlite.prepare("DELETE FROM trajectories WHERE id = ?").run(id);
      }
    }
  } else {
    console.log("\n  exact duplicates: 0");
  }

  // ------------------------------------------------------------ duplicate objects
  // The same object can be inserted twice under one operator — separate demo runs
  // did exactly that. Two rows for one satellite make "this object's trajectories"
  // ambiguous and split its feeds across records, so the trajectories are moved
  // onto the oldest row and the extras removed.
  const dupObjects = sqlite
    .prepare(
      `SELECT operator_id, object_name, COUNT(*) n, MIN(created_at) first_created
         FROM objects GROUP BY operator_id, object_name HAVING n > 1`,
    )
    .all() as Array<{ operator_id: string; object_name: string; n: number }>;

  let mergedObjects = 0;
  for (const dup of dupObjects) {
    const rowsFor = sqlite
      .prepare(
        "SELECT id, created_at FROM objects WHERE operator_id = ? AND object_name = ? ORDER BY created_at",
      )
      .all(dup.operator_id, dup.object_name) as Array<{ id: string; created_at: string }>;
    const [keep, ...extras] = rowsFor;
    if (!keep) continue;

    for (const extra of extras) {
      mergedObjects += 1;
      if (!dryRun) {
        // Re-point trajectories, events and catalogue entries before deleting, so
        // nothing is orphaned.
        sqlite.prepare("UPDATE trajectories SET object_id = ? WHERE object_id = ?").run(keep.id, extra.id);

        // `catalog` is keyed by (object_id, state_source), so re-pointing a row
        // whose key already exists on the keeper violates the primary key. The
        // newest entry wins, which is the same rule the catalog upsert uses.
        const conflicting = sqlite
          .prepare(
            `SELECT c.state_source FROM catalog c
              WHERE c.object_id = ?
                AND EXISTS (SELECT 1 FROM catalog k WHERE k.object_id = ? AND k.state_source = c.state_source)`,
          )
          .all(extra.id, keep.id) as Array<{ state_source: string }>;
        for (const c of conflicting) {
          sqlite
            .prepare("DELETE FROM catalog WHERE object_id = ? AND state_source = ?")
            .run(extra.id, c.state_source);
        }
        sqlite.prepare("UPDATE catalog SET object_id = ? WHERE object_id = ?").run(keep.id, extra.id);
        sqlite
          .prepare("UPDATE cdms SET object1_id = ? WHERE object1_id = ?")
          .run(keep.id, extra.id);
        sqlite
          .prepare("UPDATE cdms SET object2_id = ? WHERE object2_id = ?")
          .run(keep.id, extra.id);
        sqlite.prepare("DELETE FROM objects WHERE id = ?").run(extra.id);
      }
    }
    console.log(`  merged ${dup.object_name}: ${extras.length} duplicate(s) into ${keep.id.slice(0, 8)}`);
  }
  console.log(`\n  duplicate objects merged: ${mergedObjects}`);

  // ---------------------------------------------------------------------- pairs
  // Link each object's OCM with its ITC so a screening job can take states from
  // one and covariance from the other.
  const survivors = sqlite
    .prepare("SELECT id, object_id, file_format FROM trajectories ORDER BY uploaded_at DESC")
    .all() as Array<{ id: string; object_id: string; file_format: string }>;

  const latestByFormat = new Map<string, { ocm?: string; itc?: string }>();
  for (const r of survivors) {
    const entry = latestByFormat.get(r.object_id) ?? {};
    if (r.file_format === "ocm" && !entry.ocm) entry.ocm = r.id;
    if (r.file_format === "itc" && !entry.itc) entry.itc = r.id;
    latestByFormat.set(r.object_id, entry);
  }

  let paired = 0;
  for (const [objectId, entry] of latestByFormat) {
    if (!entry.ocm || !entry.itc) continue;
    paired += 1;
    if (!dryRun) {
      sqlite.prepare("UPDATE trajectories SET companion_id = ? WHERE id = ?").run(entry.itc, entry.ocm);
      sqlite.prepare("UPDATE trajectories SET companion_id = ? WHERE id = ?").run(entry.ocm, entry.itc);
    }
    console.log(`  paired ${objectId.slice(0, 8)}: ocm↔itc`);
  }
  console.log(`\n  OCM/ITC pairs linked: ${paired}`);

  if (dryRun) console.log("\n  (dry run: nothing written)");
  console.log();
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
