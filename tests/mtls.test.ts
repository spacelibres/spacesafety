/**
 * Mutual-TLS end-to-end check.
 *
 * Starts a TLS terminator in front of nothing (it just echoes the verified peer
 * certificate in the `X-Client-Cert` header the app expects), then drives
 * `authenticateRequest` with that header to prove the whole chain:
 *
 *   client cert -> CA verification -> fingerprint lookup -> principal
 *
 *   npm run test:mtls
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureCa, issueClientCertificate } from "../scripts/cert";

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

const workDir = mkdtempSync(join(tmpdir(), "spaceeyes-mtls-"));
process.env.SPACE_EYES_DB = join(workDir, "test.sqlite");
process.env.SPACE_EYES_CERT_DIR = join(workDir, "certs");
// The dev bypass must be off for these assertions to mean anything.
delete process.env.SPACE_EYES_ALLOW_X_OPERATOR;
delete process.env.SPACE_EYES_DEMO;

const OP_ID = "11111111-1111-4111-8111-111111111111";

async function main() {
  const { getDb, closeDb } = await import("../src/db");
  const schema = await import("../src/db/schema");
  const { authenticateRequest, certificateFingerprint, subjectCommonName, decodeClientCert } =
    await import("../src/lib/api/auth");

  const { db } = getDb();
  const now = new Date().toISOString();
  db.insert(schema.operators)
    .values({
      id: OP_ID,
      name: "Space Eyes",
      email: "ops@test",
      phone: null,
      maxObjects: 5,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  console.log("\nmTLS — certificate authority");
  {
    const ca = ensureCa();
    check("CA created on first run", ca.created, ca.certPath);
    const again = ensureCa();
    check("CA is reused on subsequent runs", !again.created);
  }

  console.log("\nmTLS — issuance");
  const cert = issueClientCertificate({
    commonName: "starship-ops",
    organization: "Starship Ops",
    operatorId: OP_ID,
  });
  {
    check("certificate and key written", existsSync(cert.certPath) && existsSync(cert.keyPath));
    check("credential registered", cert.credentialId !== null);
    check(
      "fingerprint is sha-256 hex",
      /^[0-9a-f]{64}$/.test(cert.fingerprint),
      cert.fingerprint.slice(0, 16) + "…",
    );

    // The chain must verify against our CA.
    const verify = execFileSync(
      "openssl",
      ["verify", "-CAfile", join(process.env.SPACE_EYES_CERT_DIR!, "ca.crt"), cert.certPath],
      { encoding: "utf8" },
    );
    check("certificate chains to the CA", verify.includes(": OK"), verify.trim());

    // Client certs must not be usable as CA certificates.
    const text = execFileSync("openssl", ["x509", "-in", cert.certPath, "-noout", "-text"], {
      encoding: "utf8",
    });
    check("certificate is not a CA", text.includes("CA:FALSE"));
    check("extended key usage is clientAuth", text.includes("TLS Web Client Authentication"));
  }

  console.log("\nmTLS — authentication");
  {
    const pem = await import("node:fs").then((fs) => fs.readFileSync(cert.certPath, "utf8"));

    check(
      "fingerprint matches the certificate bytes",
      certificateFingerprint(pem) === cert.fingerprint,
    );
    check("subject CN parsed without an X.509 library", subjectCommonName(pem) === "starship-ops", String(subjectCommonName(pem)));

    // Simulate the proxy handing us the verified certificate. Real proxies
    // (nginx's `$ssl_client_escaped_cert`) URL-encode every PEM, so this is the
    // shape production actually sees.
    const headers = new Headers({ "x-client-cert": encodeURIComponent(pem) });
    const principal = authenticateRequest(headers);
    check("authenticated as the registered operator", principal.operatorId === OP_ID, principal.operatorName);
    check("principal carries the CN", principal.commonName === "starship-ops");

    // Raw PEM must also work (no URL encoding). A real `Headers` object forbids
    // newlines outright, so the unescaped shape is exercised at the decoder.
    check(
      "raw PEM decodes unchanged",
      // `trim` strips the trailing newline; the certificate content is intact.
      decodeClientCert(pem) === pem.trim(),
    );
    // `encodeURIComponent` leaves `-` untouched, so an escaped PEM still reads
    // `-----BEGIN CERTIFICATE-----%0A…`. This is the regression guard for the
    // bug where the decoder sniffed for the marker and skipped decoding.
    check(
      "escaped PEM decodes back to PEM",
      decodeClientCert(encodeURIComponent(pem))?.trim() === pem.trim(),
    );
    check("garbage is rejected", decodeClientCert("not a certificate") === null);

    // Missing certificate.
    let threw = false;
    try {
      authenticateRequest(new Headers());
    } catch (err) {
      threw = (err as { status?: number }).status === 401;
    }
    check("no certificate -> 401", threw);

    // A certificate we never issued (self-signed, not in the DB).
    const rogueDir = join(workDir, "rogue");
    execFileSync("mkdir", ["-p", rogueDir]);
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:secp384r1",
        "-nodes", "-keyout", join(rogueDir, "r.key"), "-out", join(rogueDir, "r.crt"),
        "-days", "1", "-subj", "/CN=rogue",
      ],
      { stdio: "pipe" },
    );
    const roguePem = await import("node:fs").then((fs) =>
      fs.readFileSync(join(rogueDir, "r.crt"), "utf8"),
    );
    threw = false;
    try {
      authenticateRequest(new Headers({ "x-client-cert": encodeURIComponent(roguePem) }));
    } catch (err) {
      threw =
        (err as { status?: number }).status === 403 &&
        String((err as Error).message).includes("RBAC");
    }
    check("unknown certificate -> 403 RBAC: access denied", threw);
  }

  console.log("\nmTLS — revocation");
  {
    const { revokeCredential } = await import("../scripts/cert");
    const pem = await import("node:fs").then((fs) => fs.readFileSync(cert.certPath, "utf8"));

    check("revocation succeeds", revokeCredential(cert.fingerprint));

    let threw = false;
    try {
      authenticateRequest(new Headers({ "x-client-cert": encodeURIComponent(pem) }));
    } catch (err) {
      threw = (err as { status?: number }).status === 403;
    }
    check("revoked certificate -> 403", threw);

    check(
      "revoking an unknown fingerprint reports failure",
      revokeCredential("0".repeat(64)) === false,
    );
  }

  closeDb();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
