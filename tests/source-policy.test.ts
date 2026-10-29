/**
 * Trajectory source policy.
 *
 * The rule this file protects: Starlink is screened from the operator's own
 * OCM/OEM, everything else from catalogue mean elements (TLE/OMM) as preliminary
 * data. Screening a Starlink object from a TLE would discard the operator's
 * propagated trajectory — the one input that makes the result meaningful — and a
 * TLE's along-track error grows by kilometres per day, the same order as the 44 km
 * along-track screening box.
 *
 * The policy is pure, so it is tested directly rather than through a render.
 */

import {
  attribution,
  isVendorEphemerisObject,
  refuseReason,
  sourcePolicy,
} from "../src/lib/orbit/source-policy";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}${detail ? `  ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? `  ${detail}` : ""}`);
  }
}

console.log("\nPolicy — identifying objects with a vendor ephemeris");

{
  check("Starlink name", isVendorEphemerisObject("STARLINK-38128"));
  check("Starlink operator", isVendorEphemerisObject("SOMETHING", "Starlink"));
  check("SpaceX operator", isVendorEphemerisObject("X", "SpaceX/USA"));
  check("ISS is not", !isVendorEphemerisObject("ISS (ZARYA)", "NASA"));
  check("oneweb is not", !isVendorEphemerisObject("ONEWEB-0001", "OneWeb"));
  // A derived partner object is *ours*, not the vendor's: it has no public feed.
  check("derived partner is not", !isVendorEphemerisObject("STARLINK-38128-PARTNER", "Demo Partner"));
}

console.log("\nPolicy — Starlink uses the operator feed");

{
  // The OCM supersedes the ITC: longer arc, same covariance, plus the manoeuvre
  // plan and the catalogue number. An earlier version of this test had it the
  // other way round because the OCM's covariance section was misread.
  const withCov = sourcePolicy({ objectName: "STARLINK-38128", hasCovariance: true });
  check("covariance-bearing feed is the OCM", withCov.source === "ocm", withCov.source);
  check("and is authoritative", withCov.quality === "authoritative");
  check("and can produce a Pc", withCov.hasCovariance);
  check("no warnings needed", withCov.warnings.length === 0);

  const noCov = sourcePolicy({ objectName: "STARLINK-38128", hasCovariance: false });
  check("a covariance-free OCM is still the vendor's own trajectory", noCov.source === "ocm", noCov.source);
  check("still authoritative", noCov.quality === "authoritative");
  check("cannot produce a Pc", !noCov.hasCovariance);
  check(
    "and says so rather than staying silent",
    noCov.warnings.some((w) => /NULL Pc/.test(w)),
    noCov.warnings[0]?.slice(0, 60),
  );
}

console.log("\nPolicy — everything else uses the catalogue");

{
  const p = sourcePolicy({ objectName: "COSMOS 2251 DEB", operatorName: null });
  check("TLE is the source", p.source === "tle", p.source);
  check("result is preliminary", p.quality === "preliminary");
  check("no covariance", !p.hasCovariance);
  check(
    "warns about TLE degradation",
    p.warnings.some((w) => /kilometres per day/.test(w)),
  );
  check("warns that Pc will be NULL", p.warnings.some((w) => /Pc is NULL/.test(w)));

  check("reason mentions the catalogue", /catalogue/.test(p.reason), p.reason.slice(0, 50));
}

console.log("\nPolicy — refusing the wrong combination");

{
  const refused = refuseReason({ objectName: "STARLINK-38128", usingSource: "tle" });
  check("Starlink from TLE is refused", refused !== null);
  check(
    "the refusal explains why",
    refused !== null && /operator's own trajectory/.test(refused),
    refused?.slice(0, 70),
  );

  check(
    "Starlink from OMM is also refused",
    refuseReason({ objectName: "STARLINK-38128", usingSource: "omm" }) !== null,
  );
  check(
    "Starlink from OCM is allowed",
    refuseReason({ objectName: "STARLINK-38128", usingSource: "ocm" }) === null,
  );
  check(
    "other objects from TLE are allowed",
    refuseReason({ objectName: "COSMOS 2251 DEB", usingSource: "tle" }) === null,
  );
}

console.log("\nPolicy — attribution travels with the result");

{
  const p = sourcePolicy({ objectName: "COSMOS 2251 DEB" });
  const a = attribution(p);
  check("source is carried", a.source === "tle", a.source);
  check("quality is carried", a.quality === "preliminary", a.quality);
  check("covariance flag is carried", a.has_covariance === false);
  check("warnings are carried", a.warnings.length === 2, `${a.warnings.length}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
