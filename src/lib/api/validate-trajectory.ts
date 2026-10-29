/**
 * Trajectory upload validation and normalisation.
 *
 * Every rule here comes from `docs/starlink-space-safety/api__upload-a-trajectory.md`
 * and `tutorial-basics/trajectories.md`. The vendor rejects the whole upload with
 * HTTP 400 and a helpful message, and so do we — but we report *all* violations
 * at once rather than stopping at the first.
 *
 * Constraints enforced:
 *   - >= 6 future state vectors
 *   - span >= 42 s and <= 21 days
 *   - every state needs a covariance, position block non-zero, matrix PSD
 *   - speed <= 70 km/s, position not below the surface
 *   - time system UTC; CCSDS in KVN only
 *   - reference frames: ITRF / EME2000 (position), RTN / ITRF / EME2000 (cov)
 */

import { isPSD3, posCov6, type Vec3 } from "../core/linalg";
import { RE_EARTH } from "../core/propagator";
import type { CovarianceFrame } from "../orbit/itc";
import {
  isEarthFixedFrame,
  isLocalOrbitalFrame,
  itrfCovToJ2000,
  itrfStateToJ2000,
  rtnCovToInertial,
} from "../orbit/frames-rigorous";
import { parseOem } from "../orbit/oem";
import {
  isJspocReport,
  parseJspocFormat,
  parseNasaFormat,
  parseUtcFormat,
  type LegacyState,
} from "../orbit/legacy-formats";
import { parseOcm, mergeOcmCovariance } from "../orbit/ocm";
import { parseModifiedItc } from "../orbit/itc";

export const MIN_STATES = 6;
export const MIN_SPAN_SECONDS = 42;
export const MAX_SPAN_SECONDS = 21 * 86_400;
export const MAX_SPEED_KM_S = 70;
/** Documented API cap on the `file` field, in characters. */
export const MAX_FILE_CHARS = 31_458_780;

export type TrajectoryUploadTypeInput = "definitive" | "hypothetical" | "candidate";

export type TrajectoryFormat =
  | "oem"
  | "ocm"
  | "itc"
  | "jspoc"
  | "utc"
  | "nasa";

export interface NormalisedState {
  ms: number;
  /** Inertial (J2000) km. */
  position: Vec3;
  /** Inertial (J2000) km/s. */
  velocity: Vec3;
  /** Inertial row-major 6x6, or null when the upload carried none. */
  covariance: number[] | null;
}

export interface NormalisedTrajectory {
  format: TrajectoryFormat;
  states: NormalisedState[];
  /** Original reference frame as declared by the file. */
  declaredFrame: string;
  declaredCovarianceFrame: string | null;
  objectName: string | null;
  startAt: string;
  endAt: string;
  /** Non-fatal observations worth surfacing to the operator. */
  warnings: string[];
}

export interface FieldIssue {
  field: string;
  reason: string;
}

export class TrajectoryValidationError extends Error {
  constructor(
    message: string,
    readonly issues: FieldIssue[],
  ) {
    super(message);
    this.name = "TrajectoryValidationError";
  }
}

/**
 * Detect the format from the file header, exactly as the vendor describes:
 * `CCSDS_OEM_VERS` -> OEM, `CCSDS_OCM_VERS` -> OCM, `time/pos.x/vel.x` headers
 * -> UTC, `JSpOC Ephemeris Report` -> JSpOC, otherwise try Modified ITC, and
 * fall back to NASA if the first data token looks like `yyDOYhhmmss.sss`.
 */
export function detectFormat(raw: string): TrajectoryFormat {
  // CCSDS self-identifies through its version keyword.
  if (raw.includes("CCSDS_OEM_VERS")) return "oem";
  if (raw.includes("CCSDS_OCM_VERS")) return "ocm";

  // JSpOC reports carry an explicit banner.
  if (isJspocReport(raw)) return "jspoc";

  // UTC format: either the documented column header or a `yyyy/mm/dd` state line.
  if (/^\s*time\s+pos\.x\s+vel\.x/im.test(raw)) return "utc";
  if (/^\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}/m.test(raw)) return "utc";

  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // Modified ITC declares its covariance frame as a bare line near the top.
  for (const line of lines.slice(0, 8)) {
    if (/^(UVW|RTN|RSW|EME2000|J2000)$/i.test(line)) return "itc";
  }

  // Remaining DOY-based formats. The vendor's own exports use a four-digit
  // year (yyyyDOY); the handbook formats use two (yyDOY) and are treated as
  // NASA unless a JSpOC banner already matched above.
  for (const line of lines) {
    if (/^\d{13}(\.\d+)?\s/.test(line)) return "nasa";
    if (/^\d{11}(\.\d+)?\s/.test(line)) return "nasa";
  }

  throw new TrajectoryValidationError("unrecognised trajectory file format", [
    {
      field: "file",
      reason:
        "file must be CCSDS OEM/OCM (KVN), Modified ITC, JSpOC, UTC, or NASA format",
    },
  ]);
}

/**
 * Parse and normalise an uploaded file into inertial states.
 *
 * Throws `TrajectoryValidationError` with every issue found.
 */
export interface ValidateOptions {
  /**
   * Apply the API's future-only rule. Default true.
   *
   * The rule exists for *uploads*: the vendor only accepts ephemerides that
   * still describe the future. Background ingest and re-screening of data that
   * is already stored must not apply it — an operator ephemeris is a fixed
   * 7-day arc, so a day after it is fetched it "ends in the past" and the whole
   * catalog becomes unparseable. A full re-screen a week after ingest failed on
   * every file for exactly this reason.
   */
  enforceFutureWindow?: boolean;
}

/**
 * Normalise and validate a trajectory file.
 *
 * `options.enforceFutureWindow` defaults to true, which keeps the documented
 * API behaviour for uploads; stored data is re-read with it disabled.
 */
export function normaliseTrajectory(raw: string, options: ValidateOptions = {}): NormalisedTrajectory {
  const enforceFutureWindow = options.enforceFutureWindow ?? true;
  const issues: FieldIssue[] = [];
  const warnings: string[] = [];

  if (!raw || raw.trim() === "") {
    throw new TrajectoryValidationError("file is empty", [
      { field: "file", reason: "file must not be empty" },
    ]);
  }
  if (raw.length > MAX_FILE_CHARS) {
    issues.push({
      field: "file",
      reason: `file exceeds ${MAX_FILE_CHARS} characters (got ${raw.length})`,
    });
  }

  const format = (() => {
    try {
      return detectFormat(raw);
    } catch (err) {
      throw new TrajectoryValidationError("unrecognised trajectory file format", [
        ...issues,
        ...(err as TrajectoryValidationError).issues,
      ]);
    }
  })();

  let parsed: NormalisedTrajectory;
  try {
    parsed = parseByFormat(raw, format);
  } catch (err) {
    throw new TrajectoryValidationError(
      `failed to parse ${format.toUpperCase()} file: ${(err as Error).message}`,
      [...issues, { field: "file", reason: (err as Error).message }],
    );
  }

  const { states } = parsed;

  // --- structural rules ---------------------------------------------------
  if (states.length < MIN_STATES) {
    issues.push({
      field: "file",
      reason: `at least ${MIN_STATES} state vectors are required (got ${states.length})`,
    });
  }

  if (states.length >= 2) {
    const spanSec = (states[states.length - 1].ms - states[0].ms) / 1000;
    if (spanSec < MIN_SPAN_SECONDS) {
      issues.push({
        field: "file",
        reason: `trajectory must span at least ${MIN_SPAN_SECONDS} s (got ${spanSec.toFixed(1)} s)`,
      });
    }
    if (spanSec > MAX_SPAN_SECONDS) {
      issues.push({
        field: "file",
        reason: `trajectory must span at most ${MAX_SPAN_SECONDS / 86_400} days (got ${(spanSec / 86_400).toFixed(2)} days)`,
      });
    }
  }

  // --- per-state physical checks ------------------------------------------
  let missingCovariance = 0;
  let nonPsd = 0;
  let zeroPositionVariance = 0;
  let badRadius = 0;
  let tooFast = 0;
  /** States whose covariance must be removed, keyed by epoch. */
  let dropCovariance: Map<number, NormalisedState> | null = null;

  for (const s of states) {
    const radius = Math.hypot(s.position[0], s.position[1], s.position[2]);
    if (!Number.isFinite(radius) || radius < RE_EARTH) badRadius += 1;

    const speed = Math.hypot(s.velocity[0], s.velocity[1], s.velocity[2]);
    if (!Number.isFinite(speed) || speed > MAX_SPEED_KM_S) tooFast += 1;

    if (!s.covariance) {
      missingCovariance += 1;
      continue;
    }
    const p = posCov6(s.covariance);
    if (p[0] <= 0 || p[4] <= 0 || p[8] <= 0) {
      zeroPositionVariance += 1;
      dropCovariance ??= new Map();
      dropCovariance.set(s.ms, s);
      continue;
    }
    if (!isPSD3(p)) {
      nonPsd += 1;
      // Strip the matrix, keep the state. A negative eigenvalue makes the Pc
      // integral meaningless for this epoch, but the position and velocity are
      // still the operator's own and are what screening needs.
      dropCovariance ??= new Map();
      dropCovariance.set(s.ms, { ...s, covariance: null });
    }
  }

  if (badRadius > 0) {
    issues.push({
      field: "file",
      reason: `${badRadius} state(s) are below the Earth's surface or have non-finite position`,
    });
  }
  if (tooFast > 0) {
    issues.push({
      field: "file",
      reason: `${tooFast} state(s) exceed the ${MAX_SPEED_KM_S} km/s velocity limit`,
    });
  }
  if (zeroPositionVariance > 0) {
    issues.push({
      field: "file",
      reason: `${zeroPositionVariance} state(s) have zero or negative position variance`,
    });
  }
  if (nonPsd > 0) {
    // Not every state, and not fatal.
    //
    // Starlink's OCMs routinely contain covariance matrices with a negative
    // eigenvalue in the propagated tail: measured on 12 real files, 9 had them and
    // the share ran from 12% to 36% of states, concentrated after roughly day 4.
    // A negative eigenvalue makes the probability integral meaningless *for that
    // state*, but the rest of the arc is sound.
    //
    // Rejecting the whole trajectory threw away 60%+ of good data and cost 97 of
    // 1000 objects their catalogue entry entirely. The matrices are dropped state
    // by state instead (see `normaliseTrajectory`), which turns "this object has
    // no ephemeris" into "this object's Pc is NULL where the covariance is bad" —
    // accurate, and visible in the CDM's failure reason.
    warnings.push(
      `${nonPsd} of ${states.length} state(s) carry a covariance matrix that is not ` +
        `positive semi-definite (a negative eigenvalue). Those matrices are dropped, so ` +
        `Pc is NULL for conjunctions at that epoch. The states themselves are kept.`,
    );
  }
  if (missingCovariance > 0) {
    warnings.push(
      `${missingCovariance} of ${states.length} state(s) carry no covariance; collision probability will be NULL for conjunctions against this trajectory`,
    );
  }

  // Future-only rule: the vendor wants ephemerides for the future, and rejects
  // windows that are entirely in the past.
  const now = Date.now();
  const lastMs = states.length ? states[states.length - 1].ms : 0;
  if (enforceFutureWindow && states.length && lastMs < now - 86_400_000) {
    issues.push({
      field: "file",
      reason: "trajectory ends more than 24 hours in the past",
    });
  }

  if (issues.length > 0) {
    throw new TrajectoryValidationError(
      `trajectory failed validation (${issues.length} issue${issues.length > 1 ? "s" : ""})`,
      issues,
    );
  }

  return {
    ...parsed,
    states: dropCovariance
      ? parsed.states.map((st) => dropCovariance!.get(st.ms) ?? st)
      : parsed.states,
    warnings,
  };
}

// ---------------------------------------------------------------------------

function parseByFormat(raw: string, format: TrajectoryFormat): NormalisedTrajectory {
  switch (format) {
    case "oem":
      return fromOem(raw);
    case "ocm":
      return fromOcm(raw);
    case "itc":
      return fromItc(raw);
    case "utc":
      return fromLegacy(parseUtcFormat(raw), "utc");
    case "jspoc": {
      const parsed = parseJspocFormat(raw);
      return { ...fromLegacy(parsed.states, "jspoc"), objectName: parsed.spacecraft };
    }
    case "nasa":
      return fromLegacy(parseNasaFormat(raw), "nasa");
    default:
      throw new Error(`${String(format)} format is not supported`);
  }
}

/**
 * Wrap the legacy (EME2000, covariance-free) formats in the normalised shape.
 *
 * These formats carry no covariance by definition, so every state has
 * `covariance: null` and any resulting CDM will have a NULL probability — the
 * behaviour the vendor documents for covariance-free uploads.
 */
function fromLegacy(
  states: LegacyState[],
  format: "utc" | "jspoc" | "nasa",
): NormalisedTrajectory {
  if (states.length === 0) throw new Error("no state vectors found");

  const normalised = states.map((s) => ({
    ms: s.ms,
    position: s.position,
    velocity: s.velocity,
    covariance: null,
  }));

  return {
    format,
    states: normalised,
    declaredFrame: "EME2000",
    declaredCovarianceFrame: null,
    objectName: null,
    startAt: new Date(normalised[0].ms).toISOString(),
    endAt: new Date(normalised[normalised.length - 1].ms).toISOString(),
    warnings: [
      `${format.toUpperCase()} format carries no covariance; collision probability will be NULL`,
    ],
  };
}

function fromOem(raw: string): NormalisedTrajectory {
  const oem = parseOem(raw);
  const frame = oem.refFrame.toUpperCase();
  if (!isEarthFixedFrame(frame) && !isInertial(frame)) {
    throw new Error(`unsupported REF_FRAME ${oem.refFrame}`);
  }

  const states: NormalisedState[] = oem.states.map((s) => {
    const state = isEarthFixedFrame(frame)
      ? itrfStateToJ2000(s.position, s.velocity, s.tMs)
      : { position: s.position, velocity: s.velocity };
    return {
      ms: s.tMs,
      position: state.position,
      velocity: state.velocity,
      covariance: null,
    };
  });

  return {
    format: "oem",
    states,
    declaredFrame: oem.refFrame,
    declaredCovarianceFrame: null,
    objectName: oem.objectName ?? null,
    startAt: new Date(states[0]?.ms ?? 0).toISOString(),
    endAt: new Date(states[states.length - 1]?.ms ?? 0).toISOString(),
    warnings: [
      "OEM covariance sections are currently ignored; Pc will be reported as NULL",
    ],
  };
}

function fromOcm(raw: string): NormalisedTrajectory {
  const ocm = parseOcm(raw);
  const frame = ocm.trajectoryFrame.toUpperCase();
  if (!isEarthFixedFrame(frame) && !isInertial(frame)) {
    throw new Error(`unsupported TRAJ_REF_FRAME ${ocm.trajectoryFrame}`);
  }

  const merged = mergeOcmCovariance(ocm);
  const states: NormalisedState[] = merged.map((s) => {
    const state = isEarthFixedFrame(frame)
      ? itrfStateToJ2000(s.position, s.velocity, s.ms)
      : { position: s.position, velocity: s.velocity };

    let covariance = s.covariance;
    if (covariance && ocm.covarianceFrame) {
      const covFrame = ocm.covarianceFrame.toUpperCase();
      if (isEarthFixedFrame(covFrame)) {
        covariance = itrfCovToJ2000(covariance, s.ms);
      } else if (isLocalOrbitalFrame(covFrame)) {
        // Local frames are defined about the state itself; convert using the
        // *inertial* state so the basis is consistent with the target frame.
        covariance = rtnCovToInertial(covariance, state.position, state.velocity);
      }
    }

    return {
      ms: s.ms,
      position: state.position,
      velocity: state.velocity,
      covariance,
    };
  });

  return {
    format: "ocm",
    states,
    declaredFrame: ocm.trajectoryFrame,
    declaredCovarianceFrame: ocm.covarianceFrame,
    objectName: ocm.objectName || null,
    startAt: new Date(states[0]?.ms ?? 0).toISOString(),
    endAt: new Date(states[states.length - 1]?.ms ?? 0).toISOString(),
    warnings: [],
  };
}

function fromItc(raw: string): NormalisedTrajectory {
  const lines = raw.split(/\r?\n/);
  let frame: CovarianceFrame | null = null;
  let bodyStart = 0;
  for (let i = 0; i < Math.min(lines.length, 8); i += 1) {
    const t = lines[i].trim();
    if (/^(UVW|RTN|RSW|EME2000|J2000)$/i.test(t)) {
      frame = t.toUpperCase() as CovarianceFrame;
      bodyStart = i + 1;
      break;
    }
  }
  if (!frame) throw new Error("missing covariance frame line");

  const { states: itcStates } = parseModifiedItc(
    lines.slice(bodyStart).join("\n"),
    frame,
  );

  const states: NormalisedState[] = itcStates.map((s) => {
    // Modified ITC position/velocity are EME2000 per the spec.
    let covariance = s.covariance;
    if (covariance && isLocalOrbitalFrame(frame)) {
      covariance = rtnCovToInertial(covariance, s.position, s.velocity);
    }
    return {
      ms: s.ms,
      position: s.position,
      velocity: s.velocity,
      covariance,
    };
  });

  return {
    format: "itc",
    states,
    declaredFrame: "EME2000",
    declaredCovarianceFrame: frame,
    objectName: null,
    startAt: new Date(states[0]?.ms ?? 0).toISOString(),
    endAt: new Date(states[states.length - 1]?.ms ?? 0).toISOString(),
    warnings: [],
  };
}

function isInertial(frame: string): boolean {
  const f = frame.toUpperCase();
  return f.startsWith("EME2000") || f === "J2000" || f === "GCRF";
}
