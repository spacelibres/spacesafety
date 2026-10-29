<!-- source: https://space-safety.starlink.com/docs/api/get-all-operators -->

# Get all operators

```
GET https://space-safety.starlink.com/api/v1/operator
```

Get a list of all operators along with their contact information.

## Request ​

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
[  {    "email": "string",    "id": "string",    "max_objects": 0,    "name": "string",    "phone": "string"  }]
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
curl --key client.key --cert client.crt -L -X GET 'https://space-safety.starlink.com/api/v1/operator' \-H 'Accept: application/json'
```

Request Collapse all

Base URL

https://space-safety.starlink.com/api
