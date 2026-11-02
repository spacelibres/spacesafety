# Collision avoidance CONOPS

The operating concept behind a large constellation, described from the side a client
of this API can see.

## The loop

```
catalogue ──> screening ──> CDM ──> decision ──> manoeuvre ──> new ephemeris ──> screening
```

Every arrow is data the API exposes, which is why the loop is described here rather
than in a whitepaper:

| Step | Where it is visible |
|---|---|
| Catalogue | **Catalogue** pages, per-source coverage |
| Screening | `screened_status` on the trajectory |
| CDM | `/api/v2/cdm` |
| Decision | `claim_status_*` on the event |
| Manoeuvre | A new trajectory with `upload_type: definitive` |
| Re-screening | A new CDM for the same event |

## What automation is allowed to decide

A screening service can compute a probability. It cannot decide to burn propellant on
someone else's satellite. The line this deployment draws:

| The service does | The service does not |
|---|---|
| Detect conjunctions and publish CDMs | Recommend a manoeuvre |
| Group messages into events | Decide whether an event is acceptable |
| Record a claim an operator states | Infer a claim from observed behaviour |
| Report `null` when Pc cannot be computed | Substitute a default probability |

That last pair is the one worth defending. A fabricated claim or a defaulted Pc both
look like information, and both would be acted on.

## Coordination between operators

A conjunction is symmetric: both sides screen the same pair with their own
ephemerides and their own covariances. Their Pc values will not match exactly, and
pretending otherwise would be a lie either side could disprove.

What makes coordination work is that both sides can see:

1. the same event identity,
2. each side's claim and the time it was last updated,
3. the message history that shows how the estimate moved.

The API therefore exposes history rather than only current state. A single number
cannot be argued with; a series can.

## This deployment's position

There is no fleet attached here. The screening pipeline exists, the event and CDM
model is implemented, and no operator has uploaded an ephemeris — so `/api/v2/cdm`
returns an empty `result` while the public CDM feed of the catalogue is visible in
the app under **Conjunctions**. Those two are different datasets and the app labels
them as such.
