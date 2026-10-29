<!-- source: https://space-safety.starlink.com/docs/api/get-all-objects -->

# Get all objects

```
GET https://space-safety.starlink.com/api/v1/object
```

Get a list of all objects. An object is a satellite in orbit; all trajectories are associated with an object.

## Request ​

### Query Parameters

**operator_id**  string

Filter objects by Operator ID.

**norad_id**  integer

Filter objects by NORAD ID.

**object_name**  string

Filter objects by their name (case-insensitive, but otherwise must fully match).

## Responses ​

- 200
- 400
- 404

OK

- application/json

- Schema
- Example (from schema)

**Schema**

- Array [
- ]

```
[  {    "alive": true,    "hard_body_radius": 0,    "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",    "maneuverability": true,    "norad_id": 0,    "object_name": "string",    "operator_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6"  }]
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
curl --key client.key --cert client.crt -L -X GET 'https://space-safety.starlink.com/api/v1/object' \-H 'Accept: application/json'
```

Request Collapse all

Base URL

https://space-safety.starlink.com/api

Parameters

operator_id — query

norad_id — query

object_name — query
