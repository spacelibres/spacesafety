# Architecture and internals

## The chain

Everything the API exposes is produced by one chain, and every stage is
inspectable:

```
operator ──owns──> object ──has many──> trajectory ──screened against──> event ──carries──> CDM
```

| Stage | Stored as | Reachable through |
|---|---|---|
| Operator | a row with a quota (`max_objects`) | `/api/v1/operator` |
| Object | name, NORAD id, **hard-body radius**, manoeuvrability | `/api/v1/object` |
| Trajectory | the raw uploaded bytes + metadata | `/api/v1/trajectory` |
| Event | a pair of objects and the CDMs between them | `/api/v2/event/:id` |
| CDM | one message per screening run | `/api/v2/cdm` |

## What happens when you upload

1. **Validation.** The file is parsed; format is detected from the content. A file
   shorter than 6 state vectors, or ending more than 24 hours in the past, is
   rejected with a reason per issue.
2. **Storage.** The bytes are stored verbatim. `GET /api/v1/trajectory/:id` returns
   exactly what was uploaded, so a format round-trip through the API is lossless.
3. **Queueing.** A screening job is created. `screened_status` reports progress.
4. **Screening.** The trajectory is propagated and compared against the catalog
   over the overlap window. A conjunction produces a CDM.
5. **Grouping.** Repeated CDMs for the same object pair and approach become one
   **event**, so the estimate's history is visible instead of a pile of messages.

## Why the raw bytes are kept

The database holds a *conclusion* — this object was here at this time. The uploaded
file holds the *evidence*. Without it, a provider revising an ephemeris is
undetectable and a disputed conjunction cannot be re-examined once the next upload
overwrites the rows. Both are kept, and the API lets you fetch either.

## The catalogue behind it

Screening needs something to screen against. This deployment builds the reference
catalogue from four published sources (Space-Track, Spacebook, ESA DISCOS,
KeepTrack) plus a supplement layer, and the pages under **Catalogue** show it.
That data is a catalogue of *objects*, not of trajectories: it has element sets and
physical attributes, not manoeuvre plans.

## Determinism

Screening the same inputs twice produces the same CDM, down to `tca_gps_nanos`.
That is a property worth stating, because a conjunction service whose answer
depends on which worker answered it cannot be used to argue with another operator.

## Known boundaries

| Boundary | Consequence |
|---|---|
| No covariance in the file → Pc is `null` | A miss distance is still reported; the probability is not invented |
| Screening is one-sided when the other object has no recent ephemeris | Reported as an event against catalogue elements, not as a probability |
| `hypothetical` uploads never enter screening | They exist to answer "what if", not to warn anyone |
