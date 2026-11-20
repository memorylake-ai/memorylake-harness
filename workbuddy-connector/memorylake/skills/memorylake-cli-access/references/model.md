# The access model

## Who

- **Members** are the team's people. Each has a **principal id** and exactly
  one primary role. `member list` shows them; `--type human` or
  `--type virtual` filters.
- **Virtual members** have no login. They act only through API keys issued
  for them (`api-key create --member <principal id>`), with the virtual
  member's role and scope. They are how automation gets its own, limited
  identity.
- An **API key** acts as the member it belongs to. A key created without
  `--member` acts as you.

Actors are something else: the identities memories are about. A person can
be both a member (who may do things) and an actor (whom facts describe), with
two unrelated ids.

## Roles

```bash
memorylake role list
memorylake role get reviewers
```

- Built-in roles: `tenant_owner`, `tenant_admin`, `tenant_member`. They cannot
  be changed. The owner role cannot be assigned; ownership is transferred
  with `team transfer-ownership`.
- A **custom role** is created by the team owner, optionally starting as a
  copy of another role's rules (`--base-role`). The copy is independent: later
  changes to either role do not reach the other.
- What a role grants is a set of **permission rules**. Only allow rules
  exist; to take a permission away, delete the rule that grants it.
- `role get` shows a role's `permissions` with their sources only to callers
  who may manage policies.

## Permission rules

A rule allows one action on a resource type, or on one instance of it, for a
custom role or for one member:

```text
--resource memorylake:project                  every project
--resource memorylake:project:proj-123         that one project
--action   project:read                        one action; repeat or comma-separate for several
```

`perm catalog` lists every resource type and its actions. For each action it
says whether it is `destructive`, whether it is `grantable` (owner-only
actions are not), and its `prerequisites`: other actions it needs to be
useful. `--auto-grant-prerequisites` on `perm rule create` adds missing
prerequisites; without it the request fails and names them.

## Access scopes

A scope says, per resource type, whether a member reaches every instance
(`mode: all`) or only the listed ones (`mode: instances`). A scope is set per
member (`member scope`) or for everyone holding a role (`role scope`).

- A scope **only limits**. It never grants an action the role lacks.
- Each listed instance may name `actions`, narrowing further; without
  `actions` it allows everything the role allows there.
- A limited type must leave the member at least one instance.
- `scope get` reports `available_actions` per type (the most an entry can
  allow) and, per instance, `effective_actions` and `shadowed_actions`
  (actions listed that the role no longer grants). These are read-only.
- The owner role has no scope: the team owner can do everything, and no
  scope, level or group changes that.

## Access groups

An access group gives its members **extra** permissions and **extra**
instances. It never takes anything away.

- An optional **base**, fixed at creation: a role (`tenant_member`, or
  `tenant_admin`, which needs an owner or admin) or another group. The group
  grants everything its base grants.
- Its **own permissions**, written `<resource_type>:<action>`, for example
  `memorylake:actor:actor:create`. `perm catalog --access-group` lists what
  is accepted.
- Its **instances** (`ag scope`), the instances it opens to its members, even
  to members whose own scope leaves them out. Mode `all` for a type removes
  its instances: a group never limits. Instances only open what a role or
  group already grants: a group with instances but no permissions gives
  read to someone whose role reads, and nothing to someone whose role does
  not.

## Permission levels

A level is `read`, `write` or `manage` on one instance, set per member with
`access set-level`. Levels **only add**: a level is the most this member gets
from levels on that instance, on top of what their role, scope and groups
already give. Setting `read` for a member whose role lets them write there
changes nothing; to make them read-only, narrow their role or scope.

- `none` removes every level set on the instance for that member. It is
  **not a deny**: they keep whatever their role, scope or groups give them.
- For a member whose scope leaves the instance out, a level is what opens it,
  and only as far as the level reaches.
- Lowering someone else's level needs a higher level than theirs there, or
  an owner or admin. The last member who can manage an instance cannot be
  lowered, not even by themselves.
- Access groups cannot hold levels.

## Where to look

| Question | Command |
| --- | --- |
| What may I do? | `perm me` (your role, permissions, and per type whether you reach every instance) |
| What may member M do, and why? | `member explain` (`permissions` with sources, `scopes`, `sources`) |
| Who can reach instance I, and why? | `access show` (`allowed` with reasons, `blocked`, `grantable_levels`) |
| What level does M have on I? | `access levels` (`current_level`, `settable_levels`, `blocked_reason`) |
| What does group G grant? | `ag explain` |
| Which rules exist? | `perm rule list` |
| Who changed what? | `audit-log list` |
