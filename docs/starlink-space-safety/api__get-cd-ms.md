<!-- source: https://space-safety.starlink.com/docs/api/get-cd-ms -->

# Get CDMs

```
GET https://space-safety.starlink.com/api/v2/cdm
```

A paginated API, where the next page will chronologically retrieve the changes since the last API call.

The pagination is ordered by the CDM last creation time. Since CDMs are immutable, each cdm will only show up once while paginating. CDMS generated from a hypothetical trajectory will not be part of the stream.

This API may be used in an streaming fashion. Even when the API returns 0 results, the same token may be used in the future to retrieve any additional changes since the last call.

The behavior of adding or removing filter parameters with the same pagination token is undefined.

If a client receives a 400 response with "pagination_too_old" error type, they must clear their pagination token.

At least one of operator1_id, trajectory_id, or object1_id is required.

## Request ​

### Query Parameters

**token**  string

Continuation token to retrieve next page.

**operator1_id**  string

Filter the cdms by operator. This will filter by both operator fields.

**operator2_id**  string

Filter the cdms by an additional operator. Operator1 must also be specified. Order does not matter.

**object1_id**  string

Filter cdms by a given object.

**object2_id**  string

Filter the cdms by an additional object. object1 must also be specified. Order does not matter.

**trajectory_id**  string

Filter cdms by a given trajectory.

**min_creation_time**  string

Minimum time of when the last CDM was created, if sorting by CDM creation time. Recommended use of ISO8601. Include 'Z' to enforce UTC.

**pc_min**  number

Minimum probability of collision to list out a cdm.

**tca_min**  integer

Minimum GPS nanoseconds timestamp for the time of closest approach.

**tca_max**  integer

Maximum GPS nanoseconds timestamp for the time of closest approach.

**include_cdm_file**  boolean

Include the CDM file inside of the json. Empty if there is no file

**only_active**  boolean

Only include the most recently created CDMs for each conjunction by state source pair. More than one CDM may be returned with the same event if the event has an operator_ephemeris vs. operator_ephemeris CDM as well as an operator_ephemeris vs. spacex_optical CDM. Both CDMs may be active at the same time.

**format**  string

**Possible values:** [`json`, `kvn`]

Format of the CDM file. (Default: json)

**trajectory1_source**  string

**Possible values:** [`operator_ephemeris`, `spacex_optical`]

Filter CDMs by a trajectory state source.

**trajectory2_source**  string

**Possible values:** [`operator_ephemeris`, `spacex_optical`]

Filter CDMs by an additional trajectory state source. trajectory1_source must also be specified.

**exclude_self_on_self**  boolean

Return all cdms involving the requesting operator, excluding that operator on itself. 'operator1_id' is required.

## Responses ​

- 200
- 400
- 404
- 500

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

Internal Server Error

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
curl --key client.key --cert client.crt -L -X GET 'https://space-safety.starlink.com/api/v2/cdm' \-H 'Accept: application/json'
```

Request Collapse all

Base URL

https://space-safety.starlink.com/api

Parameters

token — query

operator1_id — query

operator2_id — query

object1_id — query

object2_id — query

trajectory_id — query

min_creation_time — query

pc_min — query

tca_min — query

tca_max — query

include_cdm_file — query
---truefalse

only_active — query
---truefalse

format — query
---jsonkvn

trajectory1_source — query
---operator_ephemerisspacex_optical

trajectory2_source — query
---operator_ephemerisspacex_optical

exclude_self_on_self — query
---truefalse
