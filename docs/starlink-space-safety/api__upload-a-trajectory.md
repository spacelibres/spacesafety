<!-- source: https://space-safety.starlink.com/docs/api/upload-a-trajectory -->

# Upload a trajectory

```
POST https://space-safety.starlink.com/api/v1/trajectory
```

Upload a trajectory file in a supported file format.

If a file starts with "CCSDS_OEM_VERS", the system attempts to parse it as an OEM file. Otherwise, it attempts to parse it as a Modified ITC file.

OEM files must have position and velocity in the ITRF or EME2000 reference frame, and covariance in either the same reference frame, or RTN.

Modified ITC files must have position and velocity in the EME2000 reference frame. Covariance may be in the following frames: UVW, RTN, RSW, EME2000, or J2000.

See https://public.ccsds.org/Pubs/502x0b3e1.pdf (Section 5) for the OEM spec, and the https://www.space-track.org/documents/Spaceflight_Safety_Handbook_for_Operators.pdf p. 19 for Modified ITC spec.

Trajectory files must have at least 6 data points. Each data point must have an accompanying covariance, and all position covariance must be non-zero.

Trajectories must stay below 70km/s velocity.

All states within a trajectory must be no more than 21 days in the future.

The state_source field is optional, but if specified must be "operator_ephemeris".

A "hypothetical" trajectory will not override the object's current active trajectory, but it will be screened against other trajectories for possible conjunctions.

A "definitive" trajectory will override the object's current trajectory.

A "candidate" trajectory will transform into a "definitive" if all CDMs are below the relinquish threshold.

This endpoint is rate limited per operator. Email support if you need your rate limit increased.

## Request ​

- application/json

### Body
**required**

Trajectory

- auto_relinquish_pc_threshold number
- created_at_utc date-time
- file string required Possible values: <= 31458780 characters
- object_id uuid required
- state_source services.TrajectoryStateSource Possible values: [ operator_ephemeris , spacex_optical ]
- upload_type services.TrajectoryType required Possible values: [ hypothetical , definitive , candidate ]

## Responses ​

- 201
- 400
- 404

Trajectory UUID

- application/json

- Schema
- Example (from schema)

**Schema**

- id uuid

```
{  "id": "550e8400-e29b-41d4-a716-446655440000"}
```

Bad Request

- application/json

- Schema
- Example (from schema)

**Schema**

- correlation_id string
- error string
- error_type string
- metadata

```
{  "correlation_id": "string",  "error": "string",  "error_type": "string",  "metadata": {}}
```

Not Found

- application/json

- Schema
- Example (from schema)

**Schema**

- correlation_id string
- error string
- error_type string
- metadata

```
{  "correlation_id": "string",  "error": "string",  "error_type": "string",  "metadata": {}}
```

- curl
- python

- CURL

```
curl --key client.key --cert client.crt -L -X POST 'https://space-safety.starlink.com/api/v1/trajectory' \-H 'Content-Type: application/json' \-H 'Accept: application/json' \--data-raw '{  "auto_relinquish_pc_threshold": 0,  "created_at_utc": "2026-09-30T22:59:33.107Z",  "file": "string",  "object_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",  "state_source": "operator_ephemeris",  "upload_type": "hypothetical"}'
```

Request Collapse all

Base URL

https://space-safety.starlink.com/api

Body required

```
{
  "auto_relinquish_pc_threshold": 0,
  "created_at_utc": "2026-09-30T22:59:33.107Z",
  "file": "string",
  "object_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "state_source": "operator_ephemeris",
  "upload_type": "hypothetical"
}
```
