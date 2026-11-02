# API keys and identity

## Identity is the certificate

This deployment authenticates with **mutual TLS**. There is no API-key header, no
token endpoint, and no secret to embed in a client: the client presents a
certificate, and the identity in it is the caller.

That has consequences worth stating plainly:

- Rotating a credential means issuing a new certificate, not editing a header.
- A leaked key is a leaked private key; treat `client.key` as you would an SSH key.
- There is nothing to "log in" to. The first request is authenticated or it fails.

## The failure you will see

```http
HTTP/1.1 401 Unauthorized
content-type: application/json

{
  "correlation_id": "8f2fddc5-004a-42a7-b8ee-6e65e9ba7ac8",
  "error": "RBAC: access denied",
  "error_type": "unauthorized",
  "metadata": {}
}
```

`correlation_id` is repeated in the server log for the same request: it is the
only way to join a client-visible failure to a server-side one, so quote it when
reporting a problem.

## Requesting a certificate

There is no self-service endpoint. A certificate is issued out of band, because
issuing one is the act of granting access.

```bash
# What the operator sends: a CSR, private key stays local.
openssl req -new -newkey rsa:2048 -nodes \
  -keyout client.key -out client.csr -subj "/CN=<operator-name>"

# What the caller then uses, once the certificate is issued:
curl --key client.key --cert client.crt https://<host>/api/v1/operator
```

## What the certificate does not grant

A certificate authenticates; it does not authorise beyond the operator it maps
to. Two different consequences:

| Attempt | Result |
|---|---|
| Read another operator's trajectories via `/v1/trajectory` | Filtered out — the stream is scoped to the caller |
| Read a CDM that is not yours via `/v2/cdm` | `400` — a filter naming you is required |

## Scope of this page

On the upstream service a key also appears in the account's user list. Here there
is no user table at all: see the **Users** page, which lists issued certificates
rather than inventing accounts that do not exist.
