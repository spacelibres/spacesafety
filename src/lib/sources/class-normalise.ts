/**
 * Normalise the catalogue's object classification.
 *
 * ## The problem, measured
 *
 * `master_object.object_class` ends up with 16 distinct values for what are 10
 * real classes, because three providers use three vocabularies and the merge
 * simply concatenated them:
 *
 * | value | count | origin |
 * |---|---|---|
 * | `Payload` | 28 229 | DISCOS |
 * | `UNKNOWN` | 843 | DISCOS, genuinely unknown |
 * | `Unknown` | 709 | DISCOS, different casing |
 * | `PAYLOAD` | 12 | SATCAT fallback, never normalised |
 * | `DEBRIS` | 5 | SATCAT fallback |
 * | `ROCKET BODY` | 4 | SATCAT fallback |
 * | `""` | 271 | no source classified it |
 *
 * Two consequences, both real:
 *
 * 1. **Counting is wrong.** `WHERE object_class = 'UNKNOWN'` silently misses 709
 *    objects written `Unknown`, and any debris total misses the 5 written
 *    `DEBRIS`.
 * 2. **Manoeuvrability is wrong.** The merge rule is "a payload can move", matched
 *    case-sensitively on `payload`. Twelve objects classified `PAYLOAD` were
 *    therefore recorded as unable to manoeuvre.
 *
 * ## The scheme
 *
 * DISCOS's ten classes are kept as-is, because they are the finest and they drive
 * the debris breakdown. SATCAT's three coarse types are mapped into them:
 *
 *   PAYLOAD      → `Payload`
 *   ROCKET BODY  → `Rocket Body`
 *   DEBRIS       → `Unknown Debris`   (SATCAT cannot say payload- or rocket-sourced)
 *
 * `Unknown Debris` is deliberately not folded into either debris class: that would
 * invent a distinction SATCAT does not make. The count of 5 is small enough that a
 * reviewer can look at all of them.
 *
 * An object no source classified stays `Unknown`, which is honest.
 */

import type Database from "better-sqlite3";

/** The canonical set. Order is the display order. */
export const OBJECT_CLASSES = [
  "Payload",
  "Payload Fragmentation Debris",
  "Payload Mission Related Object",
  "Payload Debris",
  "Rocket Body",
  "Rocket Fragmentation Debris",
  "Rocket Mission Related Object",
  "Rocket Debris",
  "Other Mission Related Object",
  "Unknown Debris",
  "Unknown",
] as const;

export type ObjectClass = (typeof OBJECT_CLASSES)[number];

/**
 * Map any provider's spelling onto the canonical set.
 *
 * Case-insensitive, and tolerant of the SATCAT shorthand. Anything unrecognised
 * becomes `Unknown` rather than being dropped — an unclassified object is still a
 * tracked object and must appear in the catalogue.
 */
export function normaliseClass(raw: string | null | undefined): ObjectClass {
  const s = (raw ?? "").trim();
  if (s === "") return "Unknown";

  // Exact canonical, case-insensitive.
  const lower = s.toLowerCase();
  for (const c of OBJECT_CLASSES) {
    if (c.toLowerCase() === lower) return c;
  }

  // SATCAT's coarse types.
  if (lower === "payload" || lower === "payloads") return "Payload";
  if (lower === "rocket body" || lower === "rocket bodies") return "Rocket Body";
  if (lower === "debris") return "Unknown Debris";

  // DISCOS variants seen in the wild.
  if (lower.includes("payload") && lower.includes("fragmentation")) {
    return "Payload Fragmentation Debris";
  }
  if (lower.includes("rocket") && lower.includes("fragmentation")) {
    return "Rocket Fragmentation Debris";
  }
  if (lower.includes("payload") && lower.includes("mission")) {
    return "Payload Mission Related Object";
  }
  if (lower.includes("rocket") && lower.includes("mission")) {
    return "Rocket Mission Related Object";
  }
  if (lower.includes("payload") && lower.includes("debris")) return "Payload Debris";
  if (lower.includes("rocket") && lower.includes("debris")) return "Rocket Debris";

  return "Unknown";
}

/**
 * Can an object of this class manoeuvre?
 *
 * Only a payload can. A debris fragment or a spent rocket body has no propulsion,
 * and `Unknown` must not be assumed manoeuvrable: the screening policy assigns
 * manoeuvre responsibility to whoever *can* move, so a false positive there would
 * assign responsibility to an object that cannot act on it.
 */
export function isManoeuvrable(cls: string | null | undefined): boolean {
  return normaliseClass(cls) === "Payload";
}

/** Is this class any kind of debris or fragment? */
export function isDebris(cls: string | null | undefined): boolean {
  const c = normaliseClass(cls);
  return c === "Unknown Debris" || (c.includes("Debris") && c !== "Payload");
}

export interface NormaliseSummary {
  before: Record<string, number>;
  after: Record<string, number>;
  changed: number;
  manoeuvrabilityFixed: number;
  ms: number;
}

/**
 * Rewrite `master_object.object_class` and `maneuverable` in place.
 *
 * A fix-up pass rather than a change to the merge: the merge writes whatever the
 * source said, which is correct for an evidence table, and normalisation is a
 * separate, auditable decision. Running it twice is harmless.
 */
export class ClassNormaliser {
  private readonly sqlite: Database.Database;

  constructor(sqlite: Database.Database) {
    this.sqlite = sqlite;
  }

  run(): NormaliseSummary {
    const started = Date.now();

    const before = this.counts();
    const rows = this.sqlite
      .prepare("SELECT norad_id AS n, object_class AS c, maneuverable AS m FROM master_object")
      .all() as Array<{ n: number; c: string | null; m: number }>;

    const update = this.sqlite.prepare(
      "UPDATE master_object SET object_class = ?, maneuverable = ? WHERE norad_id = ?",
    );

    let changed = 0;
    let manoeuvrabilityFixed = 0;

    const tx = this.sqlite.transaction((items: typeof rows) => {
      for (const row of items) {
        const cls = normaliseClass(row.c);
        const man = isManoeuvrable(cls) ? 1 : 0;
        if (cls !== row.c) changed += 1;
        if (man !== row.m) manoeuvrabilityFixed += 1;
        if (cls !== row.c || man !== row.m) update.run(cls, man, row.n);
      }
    });
    tx(rows);

    return {
      before,
      after: this.counts(),
      changed,
      manoeuvrabilityFixed,
      ms: Date.now() - started,
    };
  }

  private counts(): Record<string, number> {
    const rows = this.sqlite
      .prepare("SELECT object_class AS c, COUNT(*) AS n FROM master_object GROUP BY 1 ORDER BY 2 DESC")
      .all() as Array<{ c: string | null; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.c ?? "(null)", r.n]));
  }
}
