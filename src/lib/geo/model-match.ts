/**
 * Match a catalogue satellite name to a downloaded 3D model.
 *
 * ## Why this is its own module
 *
 * The rule is easy to get wrong in a way nobody notices: a fuzzy matcher that
 * returns *something* for every name will happily put a model of the ISS on a
 * Starlink satellite, and the reader has no way to tell. So the matching is
 * conservative and testable:
 *
 *   1. normalise both sides (uppercase, strip everything that is not a letter or
 *      digit) and require an exact match, or
 *   2. one normalised name containing the other, with the shorter side at least
 *      four characters (`ISS` matches `ISS (ZARYA)`; `A` matches nothing), or
 *   3. a shared token of at least five characters (`STARLINK` in both), or
 *   4. a shared **acronym**: an all-capital, letters-only word of 3–5 characters
 *      that appears in both names (`ISS` in `ISS (ZARYA)` and in
 *      `International Space Station (ISS)`). Without this rule the most obvious
 *      match in the whole catalogue — the space station — is missed, because the
 *      satellite name spells it `ISS` and the model name spells it out.
 *
 * Two-letter and numeric-only tokens are refused: `1`, `DEB`, `R/B` appear in
 * hundreds of catalogue names and would match the first model in the list.
 */

export interface ModelCandidate {
  name: string;
  path: string;
  filename: string;
  localPath: string | null;
}

const MIN_CONTAIN = 4;
const MIN_TOKEN = 5;

function normalise(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

function compact(value: string): string {
  return normalise(value).replace(/\s+/g, "");
}

function tokens(value: string): string[] {
  return normalise(value).split(/\s+/).filter((t) => t.length >= MIN_TOKEN && /[A-Z]/.test(t));
}

/**
 * All-capital letter-only words of 3–5 characters, taken from the *original*
 * spelling so `(ISS)` counts and a lowercased word does not.
 *
 * Digits are excluded on purpose: `2251` and `1` are not acronyms, and matching on
 * them would pair unrelated objects.
 */
function acronyms(value: string): string[] {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => /^[A-Z]{3}[A-Z]{0,2}$/.test(w) && w === w.toUpperCase())
    .filter((w) => w.length >= 3 && w.length <= 5);
}

export function matchModel(
  satelliteName: string,
  candidates: readonly ModelCandidate[],
): ModelCandidate | null {
  const wanted = normalise(satelliteName);
  if (!wanted) return null;
  const wantedCompact = compact(satelliteName);
  const wantedTokens = new Set(tokens(satelliteName));

  let best: { candidate: ModelCandidate; score: number } | null = null;

  for (const candidate of candidates) {
    const candidateCompact = compact(candidate.name);
    if (!candidateCompact) continue;

    let score = 0;
    if (candidateCompact === wantedCompact) score = 100;
    else if (
      candidateCompact.length >= MIN_CONTAIN &&
      wantedCompact.includes(candidateCompact)
    ) {
      score = 80 + Math.min(candidateCompact.length, 20);
    } else if (
      wantedCompact.length >= MIN_CONTAIN &&
      candidateCompact.includes(wantedCompact)
    ) {
      score = 70 + Math.min(wantedCompact.length, 20);
    } else {
      const shared = tokens(candidate.name).filter((t) => wantedTokens.has(t));
      if (shared.length > 0) {
        score = 40 + shared.length * 5;
      } else {
        const wantedAcronyms = new Set(acronyms(satelliteName));
        const sharedAcronym = acronyms(candidate.name).find((a) => wantedAcronyms.has(a));
        if (sharedAcronym) score = 60;
      }
    }

    if (score > 0 && (!best || score > best.score)) best = { candidate, score };
  }

  return best ? best.candidate : null;
}
