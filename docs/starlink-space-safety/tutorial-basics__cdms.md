<!-- source: https://space-safety.starlink.com/docs/tutorial-basics/cdms -->

# CDMs

A Conjunction Data Message (CDM) is a representation of a close approach between two trajectories. (see the [CCSDS spec](https://public.ccsds.org/Pubs/508x0b1e2c2.pdf)).

When two trajectories have a close approach (defined by our [screening volume](https://space-safety.starlink.com/docs/tutorial-basics/architecture#close-approach-finding)), a Conjunction Data Message (CDM) will be generated from the trajectory position and covariance information. The CDM is returned in either JSON or KVN format (default JSON), will have a UUID, and can be retrieved from the [GET api/v1/cdm/{id}](https://space-safety.starlink.com/docs/api/show-a-conjunction-data-message-cdm) endpoint. CDMs can be streamed via the [GET /api/v2/cdm](https://space-safety.starlink.com/docs/api/get-cd-ms) endpoint. See the [quick-start guide](https://space-safety.starlink.com/docs/quick-start#querying-cdms) for a code sample.

Each CDM will be assigned to an event, based on the participating objects and the TCA.

## State Sources and CDM Generation ​

Starting in spring 2026, CDMs will be generated based on owner/operator submitted ephemerides and on Stargaze observations. That means that if an operator submits an ephemeris to the system, they may generate *two* CDMs, one based on an estimate of the secondary object based on an `operator_ephemeris` trajectory submitted to the API, and another based on Stargaze observations of the secondary.

Operators must use the [GET /api/v2/cdms](https://space-safety.starlink.com/docs/api/get-cd-ms) endpoint to receive Stargaze CDMs. The (deprecated) `GET /api/v1/event` and `GET /api/v1/cdm` endpoints will only return results based on owner/operator data.

This can be determined by querying the metadata associated with the CDM (via the [GET api/v1/cdm/:id/metadata](https://space-safety.starlink.com/docs/api/show-conjunction-data-message-cdm-metadata) endpoint) or the associated trajectory (via the [GET /api/v1/trajectory/:id/metadata](https://space-safety.starlink.com/docs/api/show-metadata-for-a-trajectory) endpoint) to see if the `state_source` field is `operator_ephemeris` or `spacex_optical`.

Each CDM contains an `is_active` field. When a CDM is first generated, this field is `True`. It will be marked `False` if either:

- A newer CDM is generated for the same conjunction event with that combination of state sources
- Newer trajectories with those state sources were screened, and no CDM was generated (because their closest approach was outside our screening volume).

## Probability of Collision Calculations ​

If both trajectories that generated a CDM contain covariance, the `COLLISION_PROBABILITY` field will be populated in the CDM. Collision probability is computed with the two-dimensional Alfano collision probability method: 'A Numerical Implementation of Spherical Object Collision Probability' by S. Alfano. ([https://doi.org/10.1007/BF03546397](https://doi.org/10.1007/BF03546397)). Two-dimensional collision probability methods are computationally efficient but may not be accurate at very low relative velocities.

If covariance was not provided for both trajectories, or if the probability of collision calculation fails (e.g., if one of the trajectories supplied a non-positive semidefinite covariance) a CDM will still be generated, but with NULL in the `COLLISION_PROBABILITY` field, with the comment field: "COMMENT_FAILED_COLLISION_PROBABILITY_CALCULATION_ALFANO = Collision probability calculation failed." In this case, the CDM will still contain a relative miss vector for conjunction assessment.
