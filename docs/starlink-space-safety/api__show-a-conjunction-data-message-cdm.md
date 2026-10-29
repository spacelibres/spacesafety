<!-- source: https://space-safety.starlink.com/docs/api/show-a-conjunction-data-message-cdm -->

# Show a Conjunction Data Message (CDM)

```
GET https://space-safety.starlink.com/api/v1/cdm/:id
```

Get the raw file for the Conjunction Data Message, in either JSON or KVN format.

## Request ​

### Path Parameters

**id**  stringrequired

cdm UUID

### Query Parameters

**format**  string

**Possible values:** [`json`, `kvn`]

Format of the CDM file. (Default: json)

## Responses ​

- 200
- 400
- 404

OK

- text/plain

- Schema

**Schema**

string

Bad Request

- text/plain

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

- text/plain

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
curl --key client.key --cert client.crt -L -X GET 'https://space-safety.starlink.com/api/v1/cdm/:id' \-H 'Accept: text/plain'
```

Request Collapse all

Base URL

https://space-safety.starlink.com/api

Parameters

id — pathrequired

format — query
---jsonkvn
