# Resource types

## Kinds the `access` commands take

`access show|levels|set-level|grant|revoke <kind> <id>`:

| Kind | Instance id from | `--workspace` |
| --- | --- | --- |
| `workspace` | `ws list` | refused |
| `project` | `proj list` | optional; shows the project by name in access scopes |
| `actor` | `actor list` (team-wide) | refused |
| `agent` | `agent list` (team-wide) | refused |
| `boundary` | `boundary list` | refused |
| `db-connection` | `dbconn list` | refused |
| `db-datasource` | `ds list` | refused |
| `skill` | `skill list` | refused |
| `workspace-actor` | the actor id: its binding in one workspace | required; defaults to the `ws use` workspace |
| `workspace-agent` | the agent id: its binding in one workspace | required; defaults to the `ws use` workspace |

Ids are the ones the data commands print, not custom ids.

```bash
memorylake access show actor act-123
memorylake access show workspace-agent agt-123 --workspace ws-123
memorylake access show db-connection dbc-123
```

## Resource types in rules, scopes and groups

Rules, scopes and group permissions name resource types in their long form,
such as `memorylake:workspace` and `memorylake:project`. Do not guess the
others; read them from the catalog:

```bash
memorylake perm catalog
memorylake perm catalog --access-group
```

| Where | Form | Example |
| --- | --- | --- |
| `perm rule create --resource` | `<resource_type>` or `<resource_type>:<instance id>` | `memorylake:project:proj-123` |
| `perm rule create --action` | `<action>` | `project:read` |
| `ag create/permissions set --permission` | `<resource_type>:<action>` | `memorylake:actor:actor:create` |
| scope JSON `resource_type` | `<resource_type>` | `memorylake:project` |
| scope JSON `instances[].actions` | `<action>` | `project:read` |

Before granting, check each action's `destructive` flag in the catalog and
say so to the user when it is set: those actions delete or irreversibly
change data.
