<!-- source: https://space-safety.starlink.com/docs/api/show-an-object -->

# Show an object

```
GET https://space-safety.starlink.com/api/v1/object/:id
```

Get object by UUID.

## Request ​

### Path Parameters

**id**  stringrequired

object UUID

## Responses ​

- 200
- 400
- 404

OK

- application/json

- Schema
- Example (from schema)

**Schema**

- alive boolean required The object is actively communicating with a ground service
- hard_body_radius number required Possible values: <= 512 Hard body radius of the object in meters
- id uuid
- maneuverability boolean required
- norad_id int
- object_name string required Possible values: <= 256 characters
- operator_id uuid required

```
{  "alive": true,  "hard_body_radius": 0,  "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",  "maneuverability": true,  "norad_id": 0,  "object_name": "string",  "operator_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6"}
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
curl --key client.key --cert client.crt -L -X GET 'https://space-safety.starlink.com/api/v1/object/:id' \-H 'Accept: application/json'
```

Request Collapse all

Base URL

https://space-safety.starlink.com/api

Parameters

id — pathrequired
