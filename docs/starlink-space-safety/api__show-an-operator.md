<!-- source: https://space-safety.starlink.com/docs/api/show-an-operator -->

# Show an operator

```
GET https://space-safety.starlink.com/api/v1/operator/:id
```

Show an operator by UUID.

## Request ​

### Path Parameters

**id**  stringrequired

operator UUID

## Responses ​

- 200
- 400
- 404

OK

- application/json

- Schema
- Example (from schema)

**Schema**

- email string
- id string
- max_objects integer
- name string
- phone string

```
{  "email": "string",  "id": "string",  "max_objects": 0,  "name": "string",  "phone": "string"}
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
curl --key client.key --cert client.crt -L -X GET 'https://space-safety.starlink.com/api/v1/operator/:id' \-H 'Accept: application/json'
```

Request Collapse all

Base URL

https://space-safety.starlink.com/api

Parameters

id — pathrequired
