/**
 * Local certificate authority.
 *
 * The platform authenticates callers with mutual TLS (`docs/SPEC-BEHAVIOR.md`
 * §1). Real deployments would use an existing PKI; this module provides a
 * self-contained CA so the whole flow is exercisable end to end:
 *
 *   npm run cert:ca                    # create the CA (once)
 *   npm run cert:issue -- --cn my-org --operator <uuid>
 *
 * The issued certificate is registered in the `credentials` table, which is what
 * `authenticate()` matches on request time.
 *
 * Design notes
 * ------------
 * - **EC P-384 / SHA-384**, matching the vendor's documented client-key shape.
 * - The CA key never leaves `certs/` and is created with mode 600.
 * - Certificates carry a `clientAuth` extended key usage so a browser or proxy
 *   will not accept them as server certificates.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, X509Certificate } from "node:crypto";

import { eq } from "drizzle-orm";

import { getDb } from "../src/db";
import { credentials, operators } from "../src/db/schema";

/**
 * Resolved lazily so tests (and callers that change the environment) always see
 * the current value instead of whatever was set at module load.
 */
function certDir(): string {
  return process.env.SPACE_EYES_CERT_DIR ?? "./certs";
}
function caKeyPath(): string {
  return join(certDir(), "ca.key");
}
function caCertPath(): string {
  return join(certDir(), "ca.crt");
}

/** Days a freshly issued client certificate remains valid. */
const CLIENT_VALID_DAYS = 365;

function openssl(args: string[], input?: string): string {
  return execFileSync("openssl", args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function ensureDir() {
  mkdirSync(certDir(), { recursive: true, mode: 0o700 });
}

/** Minimal openssl config so the CA certificate gets its v3 extensions. */
function writeCaConfig(extPath: string): string {
  const configPath = join(certDir(), "openssl-ca.cnf");
  writeFileSync(
    configPath,
    [
      "[req]",
      "distinguished_name = dn",
      "prompt = no",
      "[dn]",
      "[v3_ca]",
      `basicConstraints = critical,CA:TRUE`,
      `keyUsage = critical,keyCertSign,cRLSign`,
      `subjectKeyIdentifier = hash`,
      "",
    ].join("\n"),
  );
  void extPath;
  return configPath;
}

/** Create the CA if it does not exist yet. */
export function ensureCa(): { created: boolean; certPath: string } {
  ensureDir();
  if (existsSync(caKeyPath()) && existsSync(caCertPath())) {
    return { created: false, certPath: caCertPath() };
  }

  console.log("[ca] generating root key and self-signed certificate…");
  openssl(["ecparam", "-name", "secp384r1", "-genkey", "-noout", "-out", caKeyPath()]);
  chmodSync(caKeyPath(), 0o600);

  // Build the CA certificate from an explicit extensions file: `-addext` is not
  // available on older OpenSSL builds.
  const caExt = join(certDir(), "ca.ext");
  writeFileSync(
    caExt,
    [
      "basicConstraints=critical,CA:TRUE",
      "keyUsage=critical,keyCertSign,cRLSign",
      "subjectKeyIdentifier=hash",
      "",
    ].join("\n"),
  );

  openssl([
    "req",
    "-x509",
    "-new",
    "-key",
    caKeyPath(),
    "-sha384",
    "-days",
    "3650",
    "-out",
    caCertPath(),
    "-subj",
    "/CN=Space Eyes Local CA/O=Space Eyes/OU=Operations",
    "-extensions",
    "v3_ca",
    "-config",
    writeCaConfig(caExt),
  ]);

  console.log(`[ca] created ${caCertPath()}`);
  return { created: true, certPath: caCertPath() };
}

export interface IssueOptions {
  /** Certificate common name; conventionally the operator slug. */
  commonName: string;
  organization?: string;
  organizationalUnit?: string;
  /** Operator this credential belongs to. */
  operatorId?: string;
  /** Overwrite if a certificate with this CN already exists on disk. */
  force?: boolean;
}

export interface IssuedCertificate {
  commonName: string;
  keyPath: string;
  certPath: string;
  fingerprint: string;
  notAfter: string;
  credentialId: string | null;
}

/**
 * Issue a client certificate signed by the local CA.
 *
 * When `operatorId` is supplied the certificate is also registered in the
 * database, so it can authenticate immediately.
 */
export function issueClientCertificate(opts: IssueOptions): IssuedCertificate {
  ensureCa();
  ensureDir();

  const slug = opts.commonName.replace(/[^A-Za-z0-9._-]/g, "_");
  const keyPath = join(certDir(), `${slug}.key`);
  const csrPath = join(certDir(), `${slug}.csr`);
  const certPath = join(certDir(), `${slug}.crt`);

  if (existsSync(certPath) && !opts.force) {
    console.warn(`[issue] ${certPath} already exists; use --force to overwrite`);
  }

  const subject =
    `/CN=${opts.commonName}` +
    `/O=${opts.organization ?? "Space Eyes"}` +
    `/OU=${opts.organizationalUnit ?? "Operations"}`;

  // Key + CSR (EC P-384, SHA-384 — the shape the vendor documents).
  openssl([
    "req",
    "-new",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:secp384r1",
    "-nodes",
    "-keyout",
    keyPath,
    "-sha384",
    "-out",
    csrPath,
    "-subj",
    subject,
  ]);
  chmodSync(keyPath, 0o600);

  // Sign with clientAuth EKU so it cannot be mistaken for a server cert.
  const extFile = join(certDir(), `${slug}.ext`);
  writeFileSync(
    extFile,
    [
      "basicConstraints=CA:FALSE",
      "keyUsage=critical,digitalSignature",
      "extendedKeyUsage=clientAuth",
      `subjectAltName=DNS:${opts.commonName}`,
      "",
    ].join("\n"),
  );

  openssl([
    "x509",
    "-req",
    "-in",
    csrPath,
    "-CA",
    caCertPath(),
    "-CAkey",
    caKeyPath(),
    "-CAcreateserial",
    "-out",
    certPath,
    "-days",
    String(CLIENT_VALID_DAYS),
    "-sha384",
    "-extfile",
    extFile,
  ]);

  const pem = readFileSync(certPath, "utf8");
  const x509 = new X509Certificate(pem);
  const fingerprint = createHash("sha256")
    .update(x509.raw)
    .digest("hex");

  let credentialId: string | null = null;

  if (opts.operatorId) {
    const { db } = getDb();
    const operator = db
      .select()
      .from(operators)
      .where(eq(operators.id, opts.operatorId))
      .get();

    if (!operator) {
      throw new Error(`operator ${opts.operatorId} not found; create it first`);
    }

    const existing = db
      .select()
      .from(credentials)
      .where(eq(credentials.fingerprint, fingerprint))
      .get();

    if (existing) {
      credentialId = existing.id;
    } else {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.insert(credentials)
        .values({
          id,
          operatorId: opts.operatorId,
          commonName: opts.commonName,
          fingerprint,
          pem,
          revokedAt: null,
          createdAt: now,
          lastSeenAt: null,
        })
        .run();
      credentialId = id;
    }
  }

  return {
    commonName: opts.commonName,
    keyPath,
    certPath,
    fingerprint,
    notAfter: x509.validTo,
    credentialId,
  };
}

/** Revoke a credential so it stops authenticating. */
export function revokeCredential(fingerprint: string): boolean {
  const { db } = getDb();
  const row = db
    .select()
    .from(credentials)
    .where(eq(credentials.fingerprint, fingerprint))
    .get();
  if (!row) return false;

  db.update(credentials)
    .set({ revokedAt: new Date().toISOString() })
    .where(eq(credentials.id, row.id))
    .run();
  return true;
}

/** Verify that a certificate chains to our CA. */
export function verifyAgainstCa(certPath: string): { valid: boolean; detail: string } {
  try {
    const out = openssl(["verify", "-CAfile", caCertPath(), certPath]);
    return { valid: out.includes(": OK"), detail: out.trim() };
  } catch (err) {
    return { valid: false, detail: (err as Error).message };
  }
}

// --- CLI -------------------------------------------------------------------

function cliArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function main() {
  if (process.argv.includes("--ca")) {
    const res = ensureCa();
    console.log(res.created ? "CA created." : "CA already exists.");
    return;
  }

  if (process.argv.includes("--revoke")) {
    const fp = cliArg("revoke");
    if (!fp) {
      console.error("usage: --revoke <fingerprint>");
      process.exit(1);
    }
    console.log(revokeCredential(fp) ? "revoked." : "fingerprint not found.");
    return;
  }

  const cn = cliArg("cn");
  if (!cn) {
    console.log(
      [
        "Usage:",
        "  npm run cert:issue -- --ca                       create the CA",
        "  npm run cert:issue -- --cn <name> [--operator <uuid>] [--force]",
        "  npm run cert:issue -- --revoke <fingerprint>",
      ].join("\n"),
    );
    process.exit(0);
  }

  const issued = issueClientCertificate({
    commonName: cn,
    organization: cliArg("org"),
    organizationalUnit: cliArg("ou"),
    operatorId: cliArg("operator"),
    force: process.argv.includes("--force"),
  });

  console.log("\nIssued client certificate\n");
  console.log(`  common name : ${issued.commonName}`);
  console.log(`  certificate : ${issued.certPath}`);
  console.log(`  private key : ${issued.keyPath}`);
  console.log(`  fingerprint : ${issued.fingerprint}`);
  console.log(`  expires     : ${issued.notAfter}`);
  console.log(`  credential  : ${issued.credentialId ?? "(not registered — pass --operator)"}`);
  console.log("\nUse it with:\n");
  console.log(
    `  curl --cert ${issued.certPath} --key ${issued.keyPath} https://<host>/api/v1/operator\n`,
  );
}

if (process.argv[1]?.includes("cert")) {
  main();
}
