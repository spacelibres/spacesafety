# Stargaze

Stargaze is an optical observation source: positions derived from telescope imagery
rather than from an operator's own ephemeris. In this API those trajectories carry
`state_source: "spacex_optical"`.

## Why it is a separate source

An operator ephemeris is a *plan*: where the satellite is intended to be. An optical
observation is a *measurement*: where it was seen. Comparing the two is how a real
deviation is found — but they are not interchangeable answers to the same question,
so the API never silently substitutes one for the other.

| Source | Means | Screens against operator ephemerides? |
|---|---|---|
| `operator_ephemeris` | The operator's own plan | Yes |
| `spacex_optical` | Position from optical observations | Yes, as its own trajectory |

## Where it appears

| Endpoint | Includes Stargaze CDMs |
|---|---|
| `/api/v2/cdm` | **Yes** |
| `/api/v2/trajectory/:id/cdms` | Yes |
| `/api/v1/cdm` (deprecated) | **No** — by contract, only CDMs where both sides are `operator_ephemeris` |
| `/api/v1/event` (deprecated) | No — same scoping |

That asymmetry is not an oversight. The deprecated endpoints exist for clients
written against the old tutorial and promise "owner/operator data only"; quietly
enriching them with a second source would break the promise without saying so.

## Reading it

```bash
# All CDMs involving an optical trajectory
curl --key client.key --cert client.crt \
  'https://<host>/api/v2/cdm?trajectory_id=<uuid>'

# Filter the stream to optical-sourced trajectories only
curl --key client.key --cert client.crt \
  'https://<host>/api/v2/cdm?operator1_id=<uuid>&trajectory1_source=spacex_optical'
```

## This deployment

There is no optical feed connected here: `spacex_optical` is a supported value of
`state_source` and `trajectory1_source`, and no trajectory carries it. Documented
because the parameter is part of the contract, not because data exists behind it.
