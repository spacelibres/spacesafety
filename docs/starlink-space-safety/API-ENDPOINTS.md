# API 端点总览

> 从 `docs/starlink-space-safety/api__*.md` 自动汇编。实现时以此为清单逐项打勾。

共 **18** 个端点。

| 资源 | 方法 | 路径 | 说明 | 文档 |
|---|---|---|---|---|
| CDM | `GET` | `/v1/cdm/:id` | Show a Conjunction Data Message (CDM) | [api__show-a-conjunction-data-message-cdm.md](api__show-a-conjunction-data-message-cdm.md) |
| CDM | `GET` | `/v1/cdm/:id/metadata` | Show Conjunction Data Message (CDM) metadata | [api__show-conjunction-data-message-cdm-metadata.md](api__show-conjunction-data-message-cdm-metadata.md) |
| Event | `GET` | `/v1/event/:id/cdms` | Get CDMs for a conjunction event | [api__get-cd-ms-for-a-conjunction-event.md](api__get-cd-ms-for-a-conjunction-event.md) |
| Object | `GET` | `/v1/object` | Get all objects | [api__get-all-objects.md](api__get-all-objects.md) |
| Object | `POST` | `/v1/object` | Create an object | [api__create-an-object.md](api__create-an-object.md) |
| Object | `GET` | `/v1/object/:id` | Show an object | [api__show-an-object.md](api__show-an-object.md) |
| Object | `PATCH` | `/v1/object/:id` | Update an object | [api__update-an-object.md](api__update-an-object.md) |
| Operator | `GET` | `/v1/operator` | Get all operators | [api__get-all-operators.md](api__get-all-operators.md) |
| Operator | `POST` | `/v1/operator` | Create an operator | [api__create-an-operator.md](api__create-an-operator.md) |
| Operator | `GET` | `/v1/operator/:id` | Show an operator | [api__show-an-operator.md](api__show-an-operator.md) |
| Operator | `PATCH` | `/v1/operator/:id` | Update operator information | [api__update-operator-information.md](api__update-operator-information.md) |
| Trajectory | `GET` | `/v1/trajectory` | Get all trajectories | [api__get-all-trajectories.md](api__get-all-trajectories.md) |
| Trajectory | `POST` | `/v1/trajectory` | Upload a trajectory | [api__upload-a-trajectory.md](api__upload-a-trajectory.md) |
| Trajectory | `GET` | `/v1/trajectory/:id` | Get a trajectory file | [api__get-a-trajectory-file.md](api__get-a-trajectory-file.md) |
| Trajectory | `GET` | `/v1/trajectory/:id/metadata` | Show metadata for a trajectory | [api__show-metadata-for-a-trajectory.md](api__show-metadata-for-a-trajectory.md) |
| CDM | `GET` | `/v2/cdm` | Get CDMs | [api__get-cd-ms.md](api__get-cd-ms.md) |
| Event | `GET` | `/v2/event/:id` | Show a conjunction event | [api__show-a-conjunction-event.md](api__show-a-conjunction-event.md) |
| Trajectory | `GET` | `/v2/trajectory/:id/cdms` | Get all CDMs related to a trajectory. | [api__get-all-cd-ms-related-to-a-trajectory.md](api__get-all-cd-ms-related-to-a-trajectory.md) |
