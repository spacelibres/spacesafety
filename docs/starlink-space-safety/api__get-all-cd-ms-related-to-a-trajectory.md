<!-- source: https://space-safety.starlink.com/docs/api/get-all-cd-ms-related-to-a-trajectory -->

# Get all CDMs related to a trajectory.

```
GET https://space-safety.starlink.com/api/v2/trajectory/:id/cdms
```

A paginated API, where the next page will chronologically retrieve the changes since the last API call.

The pagination is ordered by the CDM creation time. Since CDMs are immutable, each CDM will only show up once while paginating.

Includes CDMs against operator_ephemeris or spacex_optical secondaries.

This API may be used in a streaming fashion. Even when the API returns 0 results, the same token may be used in the future to retrieve any additional changes since the last call.

If a client receives a 400 response with "pagination_too_old" error type, they must clear their pagination token.

## Request ​

### Path Parameters

**id**  stringrequired

Trajectory UUID

### Query Parameters

**token**  string

Continuation token to retrieve next page.

## Responses ​

- 200
- 400

OK

- application/json

- Schema
- Example (from schema)

**Schema**

- result object[] Array [ creation_time string YYYY-MM-DDTHH:mm:ss[.sssss]Z event_id uuid file string id uuid is_active boolean object1_id uuid object1_maneuverable boolean object1_name string object2_id uuid object2_maneuverable boolean object2_name string operator1_id uuid operator1_name string operator2_id uuid operator2_name string probability_of_collision number tca_gps_nanos integer trajectory1_created_at string YYYY-MM-DDTHH:mm:ss[.sssss]Z trajectory1_id uuid trajectory1_source string trajectory2_created_at string YYYY-MM-DDTHH:mm:ss[.sssss]Z trajectory2_id uuid trajectory2_source string ]
- token string

```
{  "result": [    {      "creation_time": "string",      "event_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",      "file": "string",      "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",      "is_active": true,      "object1_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",      "object1_maneuverable": true,      "object1_name": "string",      "object2_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",      "object2_maneuverable": true,      "object2_name": "string",      "operator1_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",      "operator1_name": "string",      "operator2_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",      "operator2_name": "string",      "probability_of_collision": 0,      "tca_gps_nanos": 0,      "trajectory1_created_at": "string",      "trajectory1_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",      "trajectory1_source": "string",      "trajectory2_created_at": "string",      "trajectory2_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",      "trajectory2_source": "string"    }  ],  "token": "string"}
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
curl --key client.key --cert client.crt -L -X GET 'https://space-safety.starlink.com/api/v2/trajectory/:id/cdms' \-H 'Accept: application/json'
```

Request Collapse all

Base URL

https://space-safety.starlink.com/api

Parameters

id — pathrequired

token — query
