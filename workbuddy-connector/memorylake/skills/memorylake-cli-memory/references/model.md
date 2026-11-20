# The memory model

## Workspaces hold memory

Facts, conversations, projects and boundaries all live in one workspace.
Every command here uses the workspace remembered by `memorylake ws use`
unless `--workspace <id>` is passed. A fact id from one workspace means
nothing in another.

## Owners

Every fact has exactly one owner, and every fact command addresses one with
exactly one of these flags:

| Flag | Owner | Typical content |
| --- | --- | --- |
| `--actor <id>` | an actor | what is true about a person: preferences, background, decisions |
| `--project <id>` | a project | shared knowledge about a body of work |
| `--agent <id>` | an agent | what an agent learned doing its job |

`fact list` filters by several owners at once instead, with the plural flags
`--actors`, `--projects` and `--agents` (comma-separated, 50 owners at most in
total). Each fact it returns carries `owner.type` and `owner.id`.

An agent's memory is stored under the actor that backs it. Where a command
takes only `--actor` or `--project` (`conv fact-actions`), pass the agent's
`actor_id`.

## Actors

An actor is an identity memories are attributed to: a person, a customer, a
bot. Actors exist account-wide; memory exists per workspace.

```bash
memorylake actor me
memorylake actor list --name alice
memorylake actor list --tags vip,cn
memorylake actor get user-001 --by-custom-id
memorylake actor list --workspace ws-123
```

- `actor me` is the actor your API key represents. Use its `id` for "remember
  this about me".
- `--custom-id` is the caller's own id for the actor, unique account-wide.
  `actor get <custom-id> --by-custom-id` looks it up.
- `--tags` filters with AND: `vip,cn` means tagged both. Matching is exact and
  case-sensitive. Metadata cannot be filtered on, so filterable labels belong
  in tags.
- `actor list --workspace <id>` returns **bindings** (`actor_id`, `bound_at`,
  `status`), not actor objects. It answers who has memory in that workspace.

### Binding

An actor's memory in a workspace hangs off its binding there: without one,
facts cannot be written or read for it in that workspace, and it cannot be
named in a boundary. The same holds for agents (`Agent not bound to
workspace`). `actor me` is often not bound.

```bash
memorylake actor bind --actor act-123 --workspace ws-123
memorylake actor unbind --actor act-123 --workspace ws-123
```

Binding changes who participates in a shared workspace, so confirm with the
user before binding or unbinding anyone other than themselves.

### Creating and changing actors

```bash
memorylake actor create --custom-id user-001 --display-name "Alice Chen" --tags vip,cn
memorylake actor update act-123 --display-name "Alice Chen-Wang"
```

On `actor update`, `--tags` and `--metadata` replace the stored value whole:
read the actor first and pass every tag or key to keep. `--clear-tags` removes
all tags. `actor delete` is irreversible; the actor's bindings remain, marked
`INACTIVE`.

## Projects and documents

A project's memory is its facts plus its documents. Search returns both;
conflicts can be raised between a project fact and a project document (`m2d`).
Importing documents is covered by the `memorylake proj document` commands.

## Conversations

A conversation is a log of messages between actors, created against one
project. The server reads it in batches in the background ("cooking") and
writes facts from it, attributing each to an actor or to a project as it sees
fit. The conversation's `--project` sets where it may read context from and
write to; it does not force every fact into that project.

## Boundaries

A boundary is a named, saved search scope in a workspace: a set of projects,
plus optionally one human actor and one agent. Everything it names must exist
in, or be bound to, its workspace. `memorylake search` does not take a
boundary; it takes `--projects` and `--actors` directly.

```bash
memorylake boundary list --workspace ws-123
memorylake boundary create --name "Sales team" --projects proj-1,proj-2 --human-actor act-123
memorylake boundary update bnd-123 --projects proj-1,proj-2,proj-3
```

`--projects` on `boundary update` replaces the list: name every project to
keep.
