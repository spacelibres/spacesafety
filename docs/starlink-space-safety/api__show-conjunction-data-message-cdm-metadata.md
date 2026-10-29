<!-- source: https://space-safety.starlink.com/docs/api/show-conjunction-data-message-cdm-metadata -->

# Show Conjunction Data Message (CDM) metadata

```
GET https://space-safety.starlink.com/api/v1/cdm/:id/metadata
```

Display metadata about a CDM file. The full CDM file can be retrieved with the /cdm/{id} endpoint.

## Request ​

### Path Parameters

**id**  stringrequired

cdm UUID

## Responses ​

- 200
- 400
- 404

OK

- application/json

- Schema
- Example (from schema)

**Schema**

- created_at date-time YYYY-MM-DDTHH:mm:ss[.sssss]Z
- event_id uuid required May be null when the CDM is not associated with an event.
- id uuid required
- probability_of_collision number required Possible values: <= 1 [0, 1] or NULL.
- tca number required GPS time in nanoseconds. Epoch at 1980-06-01 00:00:00 UTC.
- trajectory1_id uuid required
- trajectory2_id uuid required

```
{  "created_at": "2026-09-30T22:59:33.143Z",  "event_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",  "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",  "probability_of_collision": 0,  "tca": 0,  "trajectory1_id": "863489ae-b3f1-4a95-9117-0df7c1df1337",  "trajectory2_id": "9f1d24fe-d83b-46ce-8656-7e93d3e82f44"}
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
curl --key client.key --cert client.crt -L -X GET 'https://space-safety.starlink.com/api/v1/cdm/:id/metadata' \-H 'Accept: application/json'
```

Request Collapse all

Base URL

https://space-safety.starlink.com/api

Parameters

id — pathrequired
