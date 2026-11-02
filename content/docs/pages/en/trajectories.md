# Trajectories

A trajectory is an ephemeris: where an object will be, sampled in time.

## Accepted formats

| Format | Detected by | Notes |
|---|---|---|
| CCSDS **OEM** | `CCSDS_OEM_VERS` header | The common interchange format |
| CCSDS **OCM** | `CCSDS_OCM_VERS` header | Carries covariance, which OEM here does not |
| Starlink modified **ITC** | `created:` / `ephemeris_start:` header | Compact; used by the published Starlink ephemerides |

The format is **detected from the content**. There is no `format` field on upload,
because a declared format that disagrees with the file is a trap for both sides.

## Upload

```bash
curl --key client.key --cert client.crt -X POST 'https://<host>/api/v1/trajectory' \
  -H 'Content-Type: application/json' \
  -d '{"object_id":"<uuid>","upload_type":"definitive","state_source":"operator_ephemeris","file":"<text>"}'
```

### `upload_type`

| Value | Meaning | Screens? |
|---|---|---|
| `definitive` | The operator's own trajectory — the plan of record | Yes |
| `candidate` | A proposed trajectory, before it is committed | Yes |
| `hypothetical` | "What would happen if I did this" | **No** |

`hypothetical` never enters screening by contract. A hypothetical that generated
warnings would be a false alarm the other operator cannot act on.

### `state_source`

`operator_ephemeris` for anything an operator supplied. `spacex_optical` marks the
Stargaze feed, which is reachable only through `/api/v2` — see [Stargaze](/docs/tutorial-basics/stargaze).

## Validation, and why it is strict

A rejected upload lists every problem, not just the first:

```json
{
  "correlation_id": "1f0a…",
  "error": "trajectory failed validation (2 issues)",
  "error_type": "trajectory_invalid",
  "metadata": {
    "issues": [
      { "field": "file", "reason": "at least 6 state vectors are required (got 2)" },
      { "field": "file", "reason": "trajectory ends more than 24 hours in the past" }
    ]
  }
}
```

| Rule | Why |
|---|---|
| ≥ 6 state vectors | Fewer cannot be interpolated with any confidence, and the TCA would be an artefact of the interpolation |
| Does not end > 24 h in the past | Screening a closed window compares against today's catalogue and reports a conjunction that cannot happen |
| Times parse unambiguously | A silently shifted epoch moves every computed TCA |

The 24-hour rule applies to **upload only**. An already-accepted trajectory keeps
screening after its window closes: the arc did not become invalid, the clock moved.

## `screened_status`

Six values, and they are the official set:

| Value | Meaning |
|---|---|
| `not_screened` | Queued, or never attempted |
| `screened` | Screening completed |
| `superseded` | A later trajectory for the same object replaced it |
| `candidate_to_definitive` | A candidate was promoted |
| `unknown_trajectory_fetching_error` | The compute node could not fetch the file |
| `failed_interpolation` | The states could not be interpolated (gap, or TCA outside the span) |

## Reading one back

```bash
# The bytes exactly as uploaded
curl --key client.key --cert client.crt 'https://<host>/api/v1/trajectory/<uuid>'

# The same orbit expressed in ITRF
curl --key client.key --cert client.crt 'https://<host>/api/v1/trajectory/<uuid>?reference_frame=itrf'
```

`reference_frame` accepts `original` (default), `itrf`, `eme2000`. The response
carries `x-reference-frame` so the frame you got is stated rather than assumed, and
the transformation is physical, not cosmetic: converting to ITRF subtracts ω×r from
the velocity (about 0.47 km/s at the equator). Rotating without that term is a
plausible-looking wrong answer.
