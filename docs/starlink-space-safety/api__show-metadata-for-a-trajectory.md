<!-- source: https://space-safety.starlink.com/docs/api/show-metadata-for-a-trajectory -->

# Show metadata for a trajectory

```
GET https://space-safety.starlink.com/api/v1/trajectory/:id/metadata
```

Returns trajectory metadata, such as the operator id, screening time, and upload time.

## Request ​

### Path Parameters

**id**  stringrequired

Trajectory UUID

## Responses ​

- 200
- 400
- 404

OK

- application/json

- Schema
- Example (from schema)

**Schema**

- auto_relinquish_pc_threshold number
- created_at date-time
- end_at date-time
- id uuid
- object_id uuid
- operator_id string
- screened_at date-time
- screened_status services.ScreenedStatusType Possible values: [ screened , not_screened , candidate_to_definitive , unknown_trajectory_fetching_error , superseded , failed_interpolation ]
- start_at date-time
- state_source services.TrajectoryStateSource required Possible values: [ operator_ephemeris , spacex_optical ]
- upload_type services.TrajectoryType required Possible values: [ hypothetical , definitive , candidate ]
- uploaded_at date-time

```
{  "auto_relinquish_pc_threshold": 0,  "created_at": "2026-09-30T22:59:33.156Z",  "end_at": "2026-09-30T22:59:33.156Z",  "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",  "object_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",  "operator_id": "string",  "screened_at": "2026-09-30T22:59:33.156Z",  "screened_status": "screened",  "start_at": "2026-09-30T22:59:33.156Z",  "state_source": "operator_ephemeris",  "upload_type": "hypothetical",  "uploaded_at": "2026-09-30T22:59:33.156Z"}
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
curl --key client.key --cert client.crt -L -X GET 'https://space-safety.starlink.com/api/v1/trajectory/:id/metadata' \-H 'Accept: application/json'
```

Request Collapse all

Base URL

https://space-safety.starlink.com/api

Parameters

id — pathrequired
