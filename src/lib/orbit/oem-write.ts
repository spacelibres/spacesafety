/**
 * Render a trajectory as a CCSDS OEM (KVN) file in a chosen reference frame.
 *
 * ## Why this exists
 *
 * `docs/starlink-space-safety/api__get-a-trajectory-file.md` documents a
 * `reference_frame` query parameter on `GET /api/v1/trajectory/:id`:
 *
 *   `original` (default) · `itrf` · `eme2000`
 *
 * Returning the stored bytes only satisfies `original`. The other two mean the
 * same ephemeris expressed in another frame, so the states have to be
 * transformed and re-serialised — which is what this module does.
 *
 * ## What is exact and what is a documented convention
 *
 * Position and velocity are transformed exactly, including the Earth-rotation
 * term for the rotating frame (`j2000StateToItrf`), because dropping it would
 * produce a velocity that is wrong by up to 0.47 km/s at the equator.
 *
 * Covariance is rotated with the same block-diagonal transform the screening
 * kernel uses in the opposite direction (`itrfCovToJ2000` / `j2000CovToItrf`):
 * the Earth-rotation term is a deterministic correction, not a random variable,
 * so it does not enter the covariance. That convention is stated here and in
 * `CHANGELOG.md` rather than left implicit.
 *
 * The output is written in the same KVN dialect the parser in `oem.ts` accepts,
 * and the round-trip is covered by a test — a file we emit must be a file we can
 * read back.
 */

import type { NormalisedState } from "@/lib/api/validate-trajectory";
import { j2000CovToItrf, j2000StateToItrf } from "./frames-rigorous";

export const REFERENCE_FRAMES = ["original", "itrf", "eme2000"] as const;
export type ReferenceFrame = (typeof REFERENCE_FRAMES)[number];

/** CCSDS frame name for each supported value. */
const FRAME_LABEL: Record<Exclude<ReferenceFrame, "original">, string> = {
  itrf: "ITRF",
  eme2000: "EME2000",
};

export interface OemRenderOptions {
  /** Target frame; `original` is handled by the caller, which returns raw bytes. */
  frame: Exclude<ReferenceFrame, "original">;
  objectName: string | null;
  /** Frame the covariance is expressed in, or null when there is none. */
  covarianceFrame: "RTN" | "ITRF" | "EME2000" | null;
  originator?: string;
}

/** `YYYY-MM-DDThh:mm:ss.sss` — the epoch shape the parser accepts. */
function epoch(ms: number): string {
  return new Date(ms).toISOString().replace("Z", "");
}

function vec(values: readonly number[]): string {
  return values.map((v) => v.toExponential(12)).join(" ");
}

/**
 * Render `states` (inertial, J2000) as an OEM in `options.frame`.
 *
 * States are emitted in time order; the caller is responsible for having
 * validated the trajectory, since a file that was accepted at upload time may
 * legitimately lie in the past by now.
 */
export function renderOem(states: NormalisedState[], options: OemRenderOptions): string {
  if (states.length === 0) throw new Error("cannot render an OEM with no states");

  const label = FRAME_LABEL[options.frame];
  const ordered = [...states].sort((a, b) => a.ms - b.ms);
  const start = epoch(ordered[0].ms);
  const stop = epoch(ordered[ordered.length - 1].ms);
  const name = options.objectName ?? "UNKNOWN";

  const lines: string[] = [
    "CCSDS_OEM_VERS = 2.0",
    `CREATION_DATE = ${epoch(Date.now())}`,
    `ORIGINATOR = ${options.originator ?? "SPACE SAFETY"}`,
    "",
    "META_START",
    `OBJECT_NAME = ${name}`,
    `OBJECT_ID = ${name}`,
    "CENTER_NAME = EARTH",
    `REF_FRAME = ${label}`,
    "TIME_SYSTEM = UTC",
    `START_TIME = ${start}`,
    `USEABLE_START_TIME = ${start}`,
    `USEABLE_STOP_TIME = ${stop}`,
    `STOP_TIME = ${stop}`,
    "INTERPOLATION = HERMITE",
    "INTERPOLATION_DEGREE = 7",
    "META_STOP",
    "",
  ];

  for (const state of ordered) {
    const transformed =
      options.frame === "itrf"
        ? j2000StateToItrf(state.position, state.velocity, state.ms)
        : { position: state.position, velocity: state.velocity };
    lines.push(
      `${epoch(state.ms)} ${vec(transformed.position)} ${vec(transformed.velocity)}`,
    );
  }

  const withCovariance = ordered.filter((s) => s.covariance !== null);
  if (withCovariance.length > 0 && options.covarianceFrame) {
    lines.push("", "COVARIANCE_START", `COV_REF_FRAME = ${options.covarianceFrame}`, "COV_ORDERING = LTM");
    // One matrix per state, in the same order as the states above. A state that
    // carried none is skipped rather than filled with zeroes: a zero matrix is a
    // claim that the position is known exactly.
    for (const state of withCovariance) {
      const cov =
        options.frame === "itrf"
          ? j2000CovToItrf(state.covariance as number[], state.ms)
          : (state.covariance as number[]);
      lines.push(epoch(state.ms));
      // Lower-triangular, six rows — the LTM ordering the parser expects.
      for (let row = 0; row < 6; row += 1) {
        const values: number[] = [];
        for (let col = 0; col <= row; col += 1) values.push(cov[row * 6 + col]);
        lines.push(values.map((v) => v.toExponential(12)).join(" "));
      }
    }
    lines.push("COVARIANCE_STOP");
  }

  return `${lines.join("\n")}\n`;
}
