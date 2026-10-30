/**
 * GET /api/v2/cdms — the plural spelling of the CDM stream.
 *
 * `docs/starlink-space-safety/tutorial-basics__cdms.md` tells operators they
 * "must use the `GET /api/v2/cdms` endpoint to receive Stargaze CDMs", while the
 * endpoint reference page and `API-ENDPOINTS.md` both spell it `/v2/cdm`. The
 * vendor's own documentation disagrees with itself, so both spellings answer:
 * a client that followed the tutorial must not get a 404 from a replica.
 *
 * One implementation, two paths — the handler is imported rather than copied, so
 * the two can never drift apart.
 */

export { GET } from "../cdm/route";

export const dynamic = "force-dynamic";
