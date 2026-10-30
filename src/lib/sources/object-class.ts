/**
 * Normalise the object-class strings the four catalogues use into one vocabulary.
 *
 * ## Why this is not a one-line `UPPER()`
 *
 * The sources do not merely differ in letter case — they differ in how finely they
 * classify, and the finer information is the useful part:
 *
 *   Space-Track   4 values    PAYLOAD · ROCKET BODY · DEBRIS · UNKNOWN
 *   DISCOS        9 values    Payload · Payload Fragmentation Debris ·
 *                             Rocket Fragmentation Debris · Rocket Body ·
 *                             Rocket Mission Related Object ·
 *                             Payload Mission Related Object · Payload Debris ·
 *                             Rocket Debris · Other Mission Related Object · Unknown
 *
 * A plain upper-case merge throws away everything DISCOS knows: whether a fragment
 * came from a payload or from a rocket stage is exactly the question a conjunction
 * report needs to answer, and it is only recorded in DISCOS.
 *
 * So there are two levels, and both are kept:
 *
 *   `objectClass`  the broad role — PAYLOAD · ROCKET BODY · DEBRIS · UNKNOWN
 *   `classDetail`  the source's own finer term, normalised for display
 *
 * ## The mapping, and why each entry
 *
 * DISCOS distinguishes "debris" (fragments of a break-up) from "mission related
 * object" (things released deliberately during a mission — lens caps, covers,
 * separation hardware). Both are debris in the operational sense: neither can
 * manoeuvre and both are hazards. They are mapped to DEBRIS at the broad level and
 * kept apart in `classDetail`.
 *
 * `Other Mission Related Object` and `Unknown` carry no role information, so they
 * become UNKNOWN rather than being folded into DEBRIS — a row we know nothing about
 * must not be counted as a confirmed fragment.
 */

/** Broad role. The only values this platform computes against. */
export type ObjectClass = "PAYLOAD" | "ROCKET BODY" | "DEBRIS" | "UNKNOWN";

export interface NormalisedClass {
  /** Broad role: what the object is, in the operational sense. */
  objectClass: ObjectClass;
  /** The source's finer distinction, when it has one; null when it does not. */
  classDetail: string | null;
  /** Which catalogue supplied the classification. */
  classSource: string | null;
}

interface Rule {
  objectClass: ObjectClass;
  classDetail: string | null;
}

/**
 * Keyed by the lower-cased, whitespace-collapsed source string.
 *
 * Every value observed in the 2026-10-29 capture is listed; an unknown string falls
 * through to UNKNOWN rather than being guessed from substrings. A substring rule
 * ("contains body → rocket body") looks tempting but mislabels
 * `Rocket Fragmentation Debris` as a rocket body, which is the opposite of the truth.
 */
const RULES: Record<string, Rule> = {
  // ---------------------------------------------------------- Space-Track
  payload: { objectClass: "PAYLOAD", classDetail: null },
  "rocket body": { objectClass: "ROCKET BODY", classDetail: null },
  debris: { objectClass: "DEBRIS", classDetail: null },

  // -------------------------------------------------------------- DISCOS
  "payload fragmentation debris": { objectClass: "DEBRIS", classDetail: "PAYLOAD FRAGMENT" },
  "rocket fragmentation debris": { objectClass: "DEBRIS", classDetail: "ROCKET FRAGMENT" },
  "payload debris": { objectClass: "DEBRIS", classDetail: "PAYLOAD DEBRIS" },
  "rocket debris": { objectClass: "DEBRIS", classDetail: "ROCKET DEBRIS" },
  "payload mission related object": { objectClass: "DEBRIS", classDetail: "PAYLOAD MISSION RELATED" },
  "rocket mission related object": { objectClass: "DEBRIS", classDetail: "ROCKET MISSION RELATED" },
  "other mission related object": { objectClass: "UNKNOWN", classDetail: "OTHER MISSION RELATED" },

  // ----------------------------------------------------- all sources
  unknown: { objectClass: "UNKNOWN", classDetail: null },
};

/**
 * Classify one source's string.
 *
 * `source` is only recorded when the string actually carried information — an
 * UNKNOWN from Space-Track is not better than an UNKNOWN from DISCOS, and naming a
 * source for it would imply a confidence that is not there.
 */
export function normaliseObjectClass(raw: string | null | undefined, source: string): NormalisedClass {
  const key = (raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const rule = RULES[key];
  if (!rule) {
    return { objectClass: "UNKNOWN", classDetail: null, classSource: null };
  }
  return {
    objectClass: rule.objectClass,
    classDetail: rule.classDetail,
    classSource: rule.objectClass === "UNKNOWN" ? null : source,
  };
}

/**
 * Pick the classification from the sources, preferring the most specific.
 *
 * The order is not the usual "Space-Track is the authority" one. For identity, a
 * generic DEBRIS says less than DISCOS's `Rocket Fragmentation Debris`, and the
 * broad role is the same either way, so the finer classification wins while the
 * authority still decides when only it has an opinion.
 *
 * The first non-UNKNOWN result wins; if every source says UNKNOWN, the row is
 * UNKNOWN and no source is credited.
 */
export function chooseClassification(
  candidates: Array<{ source: string; raw: string | null | undefined }>,
): NormalisedClass {
  let fallback: NormalisedClass = { objectClass: "UNKNOWN", classDetail: null, classSource: null };

  for (const { source, raw } of candidates) {
    const n = normaliseObjectClass(raw, source);
    if (n.objectClass === "UNKNOWN") {
      // Keep looking: a later source may know. Remember only that someone had a
      // value at all, for the detail field.
      continue;
    }
    // A payload or rocket body from any source beats a debris classification from
    // another only when the other source does not classify it more finely. Since
    // the broad role must agree between sources (they describe the same object),
    // prefer whichever supplies a detail.
    if (n.classDetail) return n;
    if (fallback.objectClass === "UNKNOWN") fallback = n;
  }
  return fallback;
}

/** Broad roles in display order, with the label shown in the UI. */
export const OBJECT_CLASS_ORDER: ObjectClass[] = ["PAYLOAD", "ROCKET BODY", "DEBRIS", "UNKNOWN"];
