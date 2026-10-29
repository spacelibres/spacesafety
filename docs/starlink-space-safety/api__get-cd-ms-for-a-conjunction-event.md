<!-- source: https://space-safety.starlink.com/docs/api/get-cd-ms-for-a-conjunction-event -->

# Get CDMs for a conjunction event

```
GET https://space-safety.starlink.com/api/v1/event/:id/cdms
```

Get CDM metadata for a conjunction event, up to 1000 results. The full CDM file can be retrieved with the /cdm/{id} endpoint.

## Request ​

### Path Parameters

**id**  stringrequired

event UUID

## Responses ​

- 200
- 400
- 500

OK

- application/json

- Schema
- Example (from schema)

**Schema**

- Array [
- ]

```
[  {    "created_at": "2026-09-30T22:59:33.144Z",    "event_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",    "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",    "probability_of_collision": 0,    "tca": 0,    "trajectory1_id": "863489ae-b3f1-4a95-9117-0df7c1df1337",    "trajectory2_id": "9f1d24fe-d83b-46ce-8656-7e93d3e82f44"  }]
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
curl --key client.key --cert client.crt -L -X GET 'https://space-safety.starlink.com/api/v1/event/:id/cdms' \-H 'Accept: application/json'
```

Request Collapse all

Base URL

https://space-safety.starlink.com/api

Parameters

id — pathrequired
