<!-- source: https://space-safety.starlink.com/docs/api/get-all-trajectories -->

# Get all trajectories

```
GET https://space-safety.starlink.com/api/v1/trajectory
```

A paginated API, where the next page will chronologically retrieve the changes since the last API call.

The pagination is ordered by trajectory upload time (uploaded_at_utc), then trajectory id.

This API may be used in an streaming fashion. Even when the API returns 0 results, the same token may be used in the future to retrieve any additional changes since the last call.

## Request ​

### Query Parameters

**token**  string

Continuation token to retrieve next page

**object_id**  string

Filter trajectories by a given object.

**upload_type**  string

**Possible values:** [`hypothetical`, `definitive`, `candidate`]

Filter trajectories by type. If this is 'hypothetical' then only trajectories for the operator making the request will appear.

**min_update_time**  string

Minimum trajectory upload time (uploaded_at_utc). Recommended use of ISO8601. Include 'Z' to enforce UTC.

**operator_id**  string

Filter trajectories by operator.

**state_source**  string

**Possible values:** [`operator_ephemeris`, `spacex_optical`]

Filter trajectories by state source. If omitted, only operator_ephemeris trajectories are returned.

## Responses ​

- 200
- 400

OK

- application/json

- Schema
- Example (from schema)

**Schema**

- result object[] Array [ auto_relinquish_pc_threshold number created_at date-time end_at date-time id uuid object_id uuid operator_id string screened_at date-time screened_status services.ScreenedStatusType Possible values: [ screened , not_screened , candidate_to_definitive , unknown_trajectory_fetching_error , superseded , failed_interpolation ] start_at date-time state_source services.TrajectoryStateSource required Possible values: [ operator_ephemeris , spacex_optical ] upload_type services.TrajectoryType required Possible values: [ hypothetical , definitive , candidate ] uploaded_at date-time ]
- token string

```
{  "result": [    {      "auto_relinquish_pc_threshold": 0,      "created_at": "2026-09-30T22:59:33.154Z",      "end_at": "2026-09-30T22:59:33.154Z",      "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",      "object_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",      "operator_id": "string",      "screened_at": "2026-09-30T22:59:33.154Z",      "screened_status": "screened",      "start_at": "2026-09-30T22:59:33.154Z",      "state_source": "operator_ephemeris",      "upload_type": "hypothetical",      "uploaded_at": "2026-09-30T22:59:33.154Z"    }  ],  "token": "string"}
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

- curl
- python

- CURL

```
curl --key client.key --cert client.crt -L -X GET 'https://space-safety.starlink.com/api/v1/trajectory' \-H 'Accept: application/json'
```

Request Collapse all

Base URL

https://space-safety.starlink.com/api

Parameters

token — query

object_id — query

upload_type — query
---hypotheticaldefinitivecandidate

min_update_time — query

operator_id — query

state_source — query
---operator_ephemerisspacex_optical
