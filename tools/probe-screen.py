#!/usr/bin/env python3
"""Measure where the full-constellation sweep spends its time.

Run this before changing the kernel. It answers three separate questions, and
conflating them produced a day of wrong conclusions:

  * `ingest`  — the fixed cost of turning one OCM file (5 MB, 10 081 states)
                into a packed track. Two parsers run per file today.
  * `pair`    — the kernel's per-pair cost, plus which slice of pairs accounts
                for the time. A pair that is rejected cheaply and a pair that is
                rejected after walking thousands of states cost 20x differently,
                so the mean alone is useless.
  * `walk`    — how many coarse states a typical pruned pair must evaluate
                before the window test can reject it.
"""

import os
import subprocess
import sys

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MEASURE = r'''
// @ts-nocheck
import { getDb } from "./src/db";
import { normaliseTrajectory } from "./src/lib/api/validate-trajectory";
import { packStates, packCovariances, trackFromPacked, screenTracks } from "./src/lib/core/screening";

const N = Number(process.argv[2] ?? 300);
const SHUFFLE = !!process.env.SHUFFLE;
const { sqlite } = getDb();
const rows = sqlite.prepare(`
  SELECT tf.file_text AS text FROM catalog c
  JOIN trajectory_files tf ON tf.trajectory_id = c.trajectory_id
  ORDER BY c.rowid LIMIT ${N}`).all() as any[];

// --- ingest -----------------------------------------------------------------------
let tParse = 0, tPack = 0, tCov = 0, states = 0, bytes = 0;
const dec = new TextDecoder();
const packed = rows.map((r) => {
  const raw = Buffer.isBuffer(r.text) ? r.text : Buffer.from(r.text, "utf8");
  bytes += raw.length;
  let s = process.hrtime.bigint();
  const text = dec.decode(raw);
  const n = normaliseTrajectory(text, { enforceFutureWindow: false });
  tParse += Number(process.hrtime.bigint() - s) / 1e6;
  states += n.states.length;
  const msg = { trajectoryId: "t", objectId: "o", objectName: "n", hardBodyRadiusKm: 0.00883,
    stateSource: "operator_ephemeris",
    states: n.states.map((x) => ({ epochMs: String(x.ms), px: x.position[0], py: x.position[1],
      pz: x.position[2], vx: x.velocity[0], vy: x.velocity[1], vz: x.velocity[2],
      covariance: x.covariance ?? [] })) } as any;
  s = process.hrtime.bigint();
  const d = packStates(msg);
  tPack += Number(process.hrtime.bigint() - s) / 1e6;
  s = process.hrtime.bigint();
  const c = packCovariances(msg);
  tCov += Number(process.hrtime.bigint() - s) / 1e6;
  return trackFromPacked({ trajectoryId: "t", objectId: "o", objectName: "n", hardBodyRadiusKm: 0.00883 }, d, c);
});

const per = (x) => x / packed.length;
console.log(`ingest: ${packed.length} OCM, ${(bytes / 1e6 / packed.length).toFixed(1)} MB each, ${(states / packed.length).toFixed(0)} states each`);
console.log(`  normalise (incl. TextDecoder, OCM parse, ITRF->J2000)  ${per(tParse).toFixed(1)} ms/file`);
console.log(`  packStates ${per(tPack).toFixed(1)} ms/file, packCovariance ${per(tCov).toFixed(1)} ms/file`);
const ingestMs = per(tParse) + per(tPack) + per(tCov);
console.log(`  full catalog: ${(ingestMs * 11162 / 1000 / 24).toFixed(1)} min on 24 threads`);

// --- pair -------------------------------------------------------------------------
const order = packed.map((_, i) => i);
if (SHUFFLE) {
  let seed = 987654321;
  for (let i = order.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
}
const times = [];
let pruned = 0, samples = 0;
for (const oi of order) for (const oj of order) {
  if (oj <= oi) continue;
  const s = process.hrtime.bigint();
  const out = screenTracks(packed[oi], packed[oj], 4000);
  times.push(Number(process.hrtime.bigint() - s) / 1e6);
  if (out.stats.pruned) pruned += 1;
  samples += out.stats.samplesCompared;
}
times.sort((a, b) => a - b);
const n = times.length;
const sum = times.reduce((a, b) => a + b, 0);
const q = (p) => times[Math.min(n - 1, Math.floor(p * n))];
const bands = [["<0.2", (t) => t < 0.2], ["0.2-1", (t) => t >= 0.2 && t < 1], ["1-3", (t) => t >= 1 && t < 3],
               ["3-5", (t) => t >= 3 && t < 5], [">5", (t) => t >= 5]];
console.log(`\npair: ${SHUFFLE ? "shuffled" : "catalog order"}, ${n} pairs, ${pruned} pruned (${(100 * pruned / n).toFixed(0)}%)`);
console.log(`  mean ${(sum / n).toFixed(3)} ms  p50 ${q(0.5).toFixed(3)}  p90 ${q(0.9).toFixed(2)}  p99 ${q(0.99).toFixed(2)}  max ${times[n - 1].toFixed(2)}`);
console.log(`  coarse states compared: ${(samples / n).toFixed(0)} per pair (mean)`);
for (const [label, f] of bands) {
  const sel = times.filter(f);
  console.log(`  ${label.padEnd(6)} ms: ${String(sel.length).padStart(7)} pairs (${(100 * sel.length / n).toFixed(0).padStart(3)}%), ` +
              `${(100 * sel.reduce((a, b) => a + b, 0) / sum).toFixed(0).padStart(3)}% of the time`);
}
const pairsTotal = 62_263_591;
console.log(`  projection: ${(sum / n * pairsTotal / 3600).toFixed(0)} core-hours => ${(sum / n * pairsTotal / 3600 / 24).toFixed(1)} h on 24 cores`);
'''


def main() -> int:
    path = os.path.join(PROJECT, "_probe_measure.ts")
    with open(path, "w") as f:
        f.write(MEASURE)
    try:
        return subprocess.run(
            ["node", "--conditions=react-server", "--import", "tsx", path, *sys.argv[1:]],
            cwd=PROJECT,
            check=False,
        ).returncode
    finally:
        os.unlink(path)


if __name__ == "__main__":
    sys.exit(main())
