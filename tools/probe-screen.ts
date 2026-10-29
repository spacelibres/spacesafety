/**
 * Measure where a full-constellation sweep spends its time.
 *
 * Run this before changing the screening kernel. It answers three separate
 * questions, and conflating them once produced a day of wrong conclusions:
 *
 *   - `ingest` — the fixed cost of turning one OCM (5 MB, ~10 000 states) into a
 *     packed track.
 *   - `pair`   — the kernel's per-pair cost, and which slice of pairs accounts
 *     for the time. A cheap rejection and a rejection after walking thousands of
 *     samples cost 20x differently, so the mean alone is useless.
 *   - `coarse` — how many sampled states a pruned pair would have walked.
 *
 *   npm run probe:screen
 *   npm run probe:screen -- 300
 */

import { getDb } from "../src/db";
import { normaliseTrajectory } from "../src/lib/api/validate-trajectory";
import {
  packCovariances,
  packStates,
  screenTracks,
  trackFromPacked,
} from "../src/lib/core/screening";

const TOTAL_PAIRS = 62_263_591;

interface IngestTiming {
  files: number;
  bytes: number;
  states: number;
  normaliseMs: number;
  packMs: number;
  covMs: number;
}

interface PairTiming {
  pairs: number;
  pruned: number;
  samples: number;
  times: number[];
  totalMs: number;
}

/** Runs the profiling pass over a sample of the catalog. */
export class ScreenProbe {
  private readonly limit: number;
  private readonly shuffle: boolean;

  constructor(limit: number, shuffle = false) {
    this.limit = limit;
    this.shuffle = shuffle;
  }

  private load(): { tracks: ReturnType<typeof trackFromPacked>[]; timing: IngestTiming } {
    const { sqlite } = getDb();
    const rows = sqlite
      .prepare(
        `SELECT tf.file_text AS text FROM catalog c
         JOIN trajectory_files tf ON tf.trajectory_id = c.trajectory_id
         ORDER BY c.rowid LIMIT ${this.limit}`,
      )
      .all() as Array<{ text: Buffer | string }>;

    const decoder = new TextDecoder();
    const timing: IngestTiming = {
      files: rows.length,
      bytes: 0,
      states: 0,
      normaliseMs: 0,
      packMs: 0,
      covMs: 0,
    };

    const tracks = rows.map((row) => {
      const raw = Buffer.isBuffer(row.text) ? row.text : Buffer.from(row.text, "utf8");
      timing.bytes += raw.length;

      let started = process.hrtime.bigint();
      // Background ingest reads stored data: the upload-only "must be in the
      // future" rule would reject a 7-day arc a week after it was fetched.
      const normalised = normaliseTrajectory(decoder.decode(raw), {
        enforceFutureWindow: false,
      });
      timing.normaliseMs += Number(process.hrtime.bigint() - started) / 1e6;
      timing.states += normalised.states.length;

      const message = {
        trajectoryId: "probe",
        objectId: "probe",
        objectName: "probe",
        hardBodyRadiusKm: 0.00883,
        stateSource: "operator_ephemeris",
        states: normalised.states.map((s) => ({
          epochMs: String(s.ms),
          px: s.position[0],
          py: s.position[1],
          pz: s.position[2],
          vx: s.velocity[0],
          vy: s.velocity[1],
          vz: s.velocity[2],
          covariance: s.covariance ?? [],
        })),
      };

      started = process.hrtime.bigint();
      const data = packStates(message as never);
      timing.packMs += Number(process.hrtime.bigint() - started) / 1e6;

      started = process.hrtime.bigint();
      const covs = packCovariances(message as never);
      timing.covMs += Number(process.hrtime.bigint() - started) / 1e6;

      return trackFromPacked(
        {
          trajectoryId: "probe",
          objectId: "probe",
          objectName: "probe",
          hardBodyRadiusKm: 0.00883,
        },
        data!,
        covs,
      );
    });

    return { tracks, timing };
  }

  private order(count: number): number[] {
    const indices = Array.from({ length: count }, (_, i) => i);
    if (!this.shuffle) return indices;
    // Deterministic shuffle: a rerun must measure the same sequence.
    let seed = 987_654_321;
    for (let i = indices.length - 1; i > 0; i -= 1) {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      const j = seed % (i + 1);
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    return indices;
  }

  async run(): Promise<number> {
    const { tracks, timing } = this.load();
    if (tracks.length < 2) {
      console.error("not enough catalog entries to profile");
      return 1;
    }

    const per = (ms: number) => ms / timing.files;
    console.log(
      `ingest: ${timing.files} OCM, ${(timing.bytes / 1e6 / timing.files).toFixed(1)} MB each, ` +
        `${(timing.states / timing.files).toFixed(0)} states each`,
    );
    console.log(`  normalise (decode + OCM parse + ITRF->J2000)  ${per(timing.normaliseMs).toFixed(1)} ms/file`);
    console.log(
      `  packStates ${per(timing.packMs).toFixed(1)} ms/file, ` +
        `packCovariance ${per(timing.covMs).toFixed(1)} ms/file`,
    );
    const ingestMs = per(timing.normaliseMs + timing.packMs + timing.covMs);
    console.log(`  full catalog: ${((ingestMs * 11_162) / 1000 / 24).toFixed(1)} min on 24 threads\n`);

    const order = this.order(tracks.length);
    const pairTiming: PairTiming = { pairs: 0, pruned: 0, samples: 0, times: [], totalMs: 0 };
    const started = process.hrtime.bigint();
    for (const i of order) {
      for (const j of order) {
        if (j <= i) continue;
        const t0 = process.hrtime.bigint();
        const out = screenTracks(tracks[i], tracks[j], 4000);
        pairTiming.times.push(Number(process.hrtime.bigint() - t0) / 1e6);
        if (out.stats.pruned) pairTiming.pruned += 1;
        pairTiming.samples += out.stats.samplesCompared;
        pairTiming.pairs += 1;
      }
    }
    pairTiming.totalMs = Number(process.hrtime.bigint() - started) / 1e6;

    const times = pairTiming.times.slice().sort((a, b) => a - b);
    const n = times.length;
    const sum = times.reduce((a, b) => a + b, 0);
    const q = (p: number) => times[Math.min(n - 1, Math.floor(p * n))];

    console.log(
      `pair: ${this.shuffle ? "shuffled" : "catalog order"}, ${n} pairs, ` +
        `${pairTiming.pruned} pruned (${((100 * pairTiming.pruned) / n).toFixed(0)}%)`,
    );
    console.log(
      `  mean ${(sum / n).toFixed(3)} ms  p50 ${q(0.5).toFixed(3)}  ` +
        `p90 ${q(0.9).toFixed(2)}  p99 ${q(0.99).toFixed(2)}  max ${times[n - 1].toFixed(2)}`,
    );
    console.log(`  coarse states compared: ${(pairTiming.samples / n).toFixed(0)} per pair`);

    const bands: Array<[string, (t: number) => boolean]> = [
      ["<0.2", (t) => t < 0.2],
      ["0.2-1", (t) => t >= 0.2 && t < 1],
      ["1-3", (t) => t >= 1 && t < 3],
      ["3-5", (t) => t >= 3 && t < 5],
      [">5", (t) => t >= 5],
    ];
    for (const [label, test] of bands) {
      const selected = times.filter(test);
      const share = selected.reduce((a, b) => a + b, 0);
      console.log(
        `  ${label.padEnd(6)} ms: ${String(selected.length).padStart(7)} pairs ` +
          `(${((100 * selected.length) / n).toFixed(0).padStart(3)}%), ` +
          `${((100 * share) / sum).toFixed(0).padStart(3)}% of the time`,
      );
    }

    const perPair = sum / n;
    console.log(
      `  projection: ${((perPair * TOTAL_PAIRS) / 3600).toFixed(0)} core-hours ` +
        `=> ${((perPair * TOTAL_PAIRS) / 3600 / 24).toFixed(1)} h on 24 cores`,
    );
    return 0;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const limit = Number(argv.find((a) => /^\d+$/.test(a)) ?? 300);
  process.exit(await new ScreenProbe(limit, argv.includes("--shuffle")).run());
}

void main();
