<!-- source: https://space-safety.starlink.com/docs/api/show-a-conjunction-event -->

# Show a conjunction event

```
GET https://space-safety.starlink.com/api/v2/event/:id
```

Get a conjunction event by UUID, including its CDMs. CDM files are included in the response.

## Request ​

### Path Parameters

**id**  stringrequired

event UUID

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

- cdms object[] CDM files are included in the response. Array [ created_at string YYYY-MM-DDTHH:mm:ss[.sssss]Z file string id uuid required is_active boolean probability_of_collision number required [0, 1] or NULL. tca_gps_nanos integer trajectory1_created_at string YYYY-MM-DDTHH:mm:ss[.sssss]Z trajectory1_id uuid required trajectory1_source services.TrajectoryStateSource Possible values: [ operator_ephemeris , spacex_optical ] trajectory2_created_at string YYYY-MM-DDTHH:mm:ss[.sssss]Z trajectory2_id uuid required trajectory2_source services.TrajectoryStateSource Possible values: [ operator_ephemeris , spacex_optical ] ]
- claim_status_operator1 services.ClaimStatus required Possible values: [ none , claimed , rejected ]
- claim_status_operator2 services.ClaimStatus required Possible values: [ none , claimed , rejected ]
- creation_time date-time required YYYY-MM-DDTHH:mm:ss[.sssss]Z
- first_cdm_tca_gps_nanos integer GPS time in nanoseconds of the first active CDM that created this event.
- id uuid required
- last_status_update_time_operator1 date-time required YYYY-MM-DDTHH:mm:ss[.sssss]Z. Null if the operator has not updated claim status.
- last_status_update_time_operator2 date-time required YYYY-MM-DDTHH:mm:ss[.sssss]Z. Null if the operator has not updated claim status.
- object1_id uuid required
- object1_maneuverable boolean
- object1_name string required
- object2_id uuid required
- object2_maneuverable boolean
- object2_name string required
- operator1_id uuid required
- operator1_name string required
- operator2_id uuid required
- operator2_name string required
- updated_time date-time required YYYY-MM-DDTHH:mm:ss[.sssss]Z

```
{  "cdms": [    {      "created_at": "string",      "file": "string",      "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",      "is_active": true,      "probability_of_collision": 0,      "tca_gps_nanos": 0,      "trajectory1_created_at": "string",      "trajectory1_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",      "trajectory1_source": "operator_ephemeris",      "trajectory2_created_at": "string",      "trajectory2_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",      "trajectory2_source": "operator_ephemeris"    }  ],  "claim_status_operator1": "none",  "claim_status_operator2": "none",  "creation_time": "2026-09-30T22:59:33.159Z",  "first_cdm_tca_gps_nanos": 0,  "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",  "last_status_update_time_operator1": "2026-09-30T22:59:33.159Z",  "last_status_update_time_operator2": "2026-09-30T22:59:33.159Z",  "object1_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",  "object1_maneuverable": true,  "object1_name": "string",  "object2_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",  "object2_maneuverable": true,  "object2_name": "string",  "operator1_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",  "operator1_name": "string",  "operator2_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",  "operator2_name": "string",  "updated_time": "2026-09-30T22:59:33.159Z"}
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
curl --key client.key --cert client.crt -L -X GET 'https://space-safety.starlink.com/api/v2/event/:id' \-H 'Accept: application/json'
```

Request Collapse all

Base URL

https://space-safety.starlink.com/api

Parameters

id — pathrequired
