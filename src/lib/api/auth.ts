/**
 * Client authentication.
 *
 * The vendor authenticates callers with mutual TLS (`docs/SPEC-BEHAVIOR.md` §1).
 * We keep the same contract, but note an architectural reality: a Next.js
 * handler never sees the raw TLS socket, so the certificate must be validated
 * and forwarded by whatever terminates TLS in front of us.
 *
 * Two supported deployments:
 *
 *  1. **Edge gateway / reverse proxy** (production). nginx or Envoy terminates
 *     mTLS, verifies the chain against our CA, and forwards the certificate as
 *     the URL-encoded PEM in `X-Client-Cert` (nginx: `$ssl_client_escaped_cert`).
 *     We then verify the fingerprint against our issued credentials.
 *
 *  2. **Node TLS terminator** (self-hosted, `server.mtls.ts`). The Node HTTPS
 *     server performs the handshake itself; this module receives the verified
 *     peer certificate directly.
 *
 * Either way the *authorization* logic lives here: a valid certificate must map
 * to an operator we know about.
 */

import { createHash, X509Certificate } from "node:crypto";

import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { credentials, operators } from "@/db/schema";

import { ApiError } from "./errors";

/** Header carrying the URL-encoded PEM of the verified client certificate. */
export const CLIENT_CERT_HEADER = "x-client-cert";

export interface Principal {
  operatorId: string;
  operatorName: string;
  credentialId: string;
  commonName: string;
  fingerprint: string;
}

/** SHA-256 over the DER body of the **leaf** certificate, hex, colon-free. */
export function certificateFingerprint(pem: string): string {
  // Take only the first certificate: a bundle includes the issuers, and the
  // credential we store is the leaf.
  const first = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/.exec(pem);
  if (!first) return createHash("sha256").update(pem).digest("hex");

  const b64 = first[0]
    .replace(/-----BEGIN CERTIFICATE-----/, "")
    .replace(/-----END CERTIFICATE-----/, "")
    .replace(/\s+/g, "");
  return createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");
}

/**
 * Extract the subject CN from the **leaf** certificate of a PEM bundle.
 *
 * A client presents its whole chain (leaf first, issuers after). Deriving the CN
 * from the first CN byte sequence in the bundle is wrong — that can pick up the
 * issuer's name — so we parse the first certificate properly.
 */
export function subjectCommonName(pem: string): string | null {
  const first = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/.exec(pem);
  if (!first) return null;
  try {
    return new X509Certificate(first[0]).subject.split("\n").reduce<string | null>((found, line) => {
      if (found) return found;
      const m = /^CN=([^\n]+)$/i.exec(line.trim());
      return m ? m[1] : null;
    }, null);
  } catch {
    return null;
  }
}

/**
 * Resolve a principal from request headers.
 *
 * Throws `ApiError.unauthorized()` when no certificate is presented, and
 * `forbidden` when the certificate is valid but unknown to us — the same
 * distinction the vendor draws between "no key" and "key with no permissions".
 */
export function authenticate(headers: Headers): Principal {
  const raw = headers.get(CLIENT_CERT_HEADER);
  if (!raw) {
    throw ApiError.unauthorized();
  }

  const pem = decodeClientCert(raw);
  if (!pem) {
    throw ApiError.unauthorized("malformed client certificate");
  }

  const fingerprint = certificateFingerprint(pem);
  const { db } = getDb();

  const cred = db
    .select()
    .from(credentials)
    .where(eq(credentials.fingerprint, fingerprint))
    .get();

  if (!cred) {
    // Certificate verified at the TLS layer but not one we issued: this is the
    // "RBAC: access denied" case from the live service.
    throw ApiError.forbidden("RBAC: access denied", { fingerprint });
  }
  if (cred.revokedAt) {
    throw ApiError.forbidden("client certificate has been revoked");
  }

  const operator = db
    .select()
    .from(operators)
    .where(eq(operators.id, cred.operatorId))
    .get();
  if (!operator) {
    throw ApiError.forbidden("certificate is not associated with an operator");
  }

  // Track last use for ops visibility (best-effort; failure must not block).
  try {
    db.update(credentials)
      .set({ lastSeenAt: new Date().toISOString() })
      .where(eq(credentials.id, cred.id))
      .run();
  } catch {
    // ignore
  }

  return {
    operatorId: operator.id,
    operatorName: operator.name,
    credentialId: cred.id,
    commonName: cred.commonName,
    fingerprint,
  };
}

/**
 * Accept raw PEM or URL-encoded PEM (nginx's `$ssl_client_escaped_cert`).
 *
 * The header value must be told apart by shape, not by the presence of the
 * BEGIN marker: `encodeURIComponent` leaves `-` untouched, so an escaped PEM
 * *still* starts with `-----BEGIN` while its newlines read `%0A` and its base64
 * padding reads `%3D`. Sniffing for the marker therefore misclassifies escaped
 * input as raw and every such request fails to parse. A well-formed PEM always
 * carries real newlines, so that is the discriminating signal used here.
 *
 * Exported for direct testing: a real `Headers` object refuses newlines, so the
 * unescaped path cannot be exercised end-to-end through `authenticate()`.
 */
export function decodeClientCert(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const decoded = /[\r\n]/.test(trimmed)
    ? trimmed
    : (() => {
        try {
          return decodeURIComponent(trimmed);
        } catch {
          // Malformed escape sequence: fall through and re-check the original.
          return trimmed;
        }
      })();

  if (!decoded.includes("-----BEGIN CERTIFICATE-----")) return null;
  return decoded;
}

/**
 * Development/demo escape hatch.
 *
 * When `SPACE_EYES_ALLOW_X_OPERATOR=1`, an `x-space-eyes-operator` header may
 * stand in for a certificate. This exists so the API is reachable from
 * `npm run dev`, from tests, and from the seeded demo without provisioning mTLS
 * first.
 *
 * It is refused in production *unless* `SPACE_EYES_ALLOW_X_OPERATOR` is
 * explicitly set together with `SPACE_EYES_DEMO=1`. Requiring both means a
 * production deployment cannot accidentally inherit the bypass from a stray
 * env var, while an intentionally public demo can still be stood up.
 */
export function authenticateDev(headers: Headers): Principal | null {
  if (process.env.SPACE_EYES_ALLOW_X_OPERATOR !== "1") return null;

  // Requiring `SPACE_EYES_DEMO=1` alongside the bypass means a real deployment
  // cannot inherit it from a stray variable, while an intentional public demo
  // can still be stood up (including under `next start`).
  if (process.env.SPACE_EYES_DEMO !== "1") return null;

  const operatorId = headers.get("x-space-eyes-operator");
  if (!operatorId) return null;

  const { db } = getDb();
  const operator = db
    .select()
    .from(operators)
    .where(eq(operators.id, operatorId))
    .get();
  if (!operator) return null;

  return {
    operatorId: operator.id,
    operatorName: operator.name,
    credentialId: "dev",
    commonName: "dev",
    fingerprint: "dev",
  };
}

/** Authenticate, allowing the dev header only outside production. */
export function authenticateRequest(headers: Headers): Principal {
  const dev = authenticateDev(headers);
  if (dev) return dev;
  return authenticate(headers);
}
