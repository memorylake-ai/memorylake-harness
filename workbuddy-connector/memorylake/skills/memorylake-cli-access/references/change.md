# Changing access

Every command here takes effect immediately. Before each one, tell the user
what will change, for whom, and what it unlocks or removes; run it only after
an explicit yes. Pass `--reason` on every command that takes it, and
`--idempotency-key` when a retry must not repeat the change.

Choose the smallest tool that does the job:

| Goal | Tool |
| --- | --- |
| Let a member reach one more instance they are scoped out of | `access grant --member` |
| Let several people reach an instance | `access grant --group` |
| Give a member a level on one instance (adds only) | `access set-level` |
| Limit a member to certain instances of a type | `member scope set` |
| Limit everyone with a role | `role scope set` |
| Allow a new kind of action | `perm rule create` on a custom role, or a group permission |

## Per instance: grant, revoke, level

```bash
memorylake access grant project proj-123 --group grp-123 --reason "Atlas reviewers need the project, per Bob"
memorylake access grant project proj-123 --member usr-123 --reason "Alice joins Atlas, per Bob"
memorylake access revoke project proj-123 --member usr-123 --reason "Alice left Atlas"
memorylake access set-level project proj-123 --member usr-123 --level read --reason "Read-only reviewer"
```

- `grant --member` adds the instance to a member whose scope for that type is
  **already limited** to listed instances, with everything their role allows
  there. For a member who reaches every instance it is refused (`409`), since
  it would fence them to that one instance; check `member scope get` first.
  You can only grant instances you can see yourself.
- `revoke` refuses to remove a limited member's last instance of a type,
  because that would lift the limit instead. Narrow the scope with
  `member scope set` if that is the intent.
- `grant` and `revoke` with `--group` change the group's instance list.
- `set-level` sets the member's level here: `read`, `write`, `manage`, or
  `none`. Levels only add (see [model.md](model.md)): `read` does not take
  writing away from someone whose role allows it, and `none` only removes the
  levels set here. The last member who can manage the instance cannot be
  lowered.

## Scopes: read, edit, write back

Keep `scope.json` and the ETag files in a temporary directory, not in the
user's project.

```bash
memorylake member scope get usr-123 > scope.json 2> etag.txt
memorylake member scope set usr-123 --scopes-file scope.json --reason "Limit Alice to the Atlas workspace" --if-match "$(cat etag.txt)"
```

`scope get` prints the scope on standard output and `ETag: "..."` on
standard error. Edit the JSON, then write it back with that ETag as
`--if-match` (the value, with or without quotes, or the whole line). A `412`
means someone changed it in between: read again and redo the edit.

The written JSON is an array of entries, or the whole object `scope get`
printed:

```json
[
  {
    "resource_type": "memorylake:project",
    "mode": "instances",
    "instances": [
      { "id": "proj-123", "actions": ["project:read"] }
    ]
  }
]
```

- Only the listed resource types change; leave a type out to keep it.
- `mode` is `all` or `instances`. `instances` must list at least one.
  Switching a type from `all` to `instances` cuts the member off from every
  instance not listed; list all the ones they should keep.
- `actions` is optional; without it the instance allows everything the role
  allows there.
- A project's `workspace_id` is filled in by the server when left out.
- Read-only fields from `scope get` (`available_actions`,
  `effective_actions`, `shadowed_actions`, `permission_level`) are accepted
  and dropped. `shadowed_actions` are taken out of `actions`, since the
  server refuses them.

The same loop works for `role scope get|set <role key>` (everyone holding the
role) and `ag scope get|set <group id>` (the group's extra instances; mode
`all` there removes the type's instances).

## Custom roles and rules

Only the team owner manages roles. Built-in roles cannot change.

```bash
memorylake role create --label Reviewers --description "Read projects and their documents"
memorylake perm catalog
memorylake perm rule create --role reviewers --resource memorylake:project --action project:read --auto-grant-prerequisites --reason "Reviewers read projects"
memorylake perm rule list --subject-type role --subject-id reviewers
memorylake perm rule delete rule-123 --reason "Reviewers no longer read databases"
memorylake member set-role usr-123 --role reviewers
```

- `role create` without `--base-role` starts empty; `--base-role
  tenant_member` copies that role's rules. Least privilege usually means
  starting empty and adding rules.
- One rule per action; `--action a,b` creates one for each.
- `--auto-grant-prerequisites` adds whatever the actions depend on, which can
  be more than the user asked for. Afterwards list the role's rules and tell
  the user exactly what was added.
- `--resource memorylake:project:proj-123` limits a rule to one instance.
- `perm rule create --member <principal id>` grants one member directly.
  Prefer a role or a group: direct grants are easy to forget.
- `role delete` removes the role with its rules and scope, and is refused
  while anyone holds it.

## Access groups

```bash
memorylake ag create --name "Atlas reviewers" --description "Read access to Atlas" --base-role tenant_member
memorylake ag member add grp-123 usr-123 usr-456
memorylake ag member remove grp-123 usr-456
memorylake ag get grp-123 2> etag.txt
memorylake ag permissions set grp-123 --permission memorylake:project:project:read --reason "Atlas reviewers read projects" --if-match "$(cat etag.txt)"
memorylake ag scope get grp-123 > group-scope.json 2> scope-etag.txt
memorylake ag scope set grp-123 --scopes-file group-scope.json --reason "Atlas projects only" --if-match "$(cat scope-etag.txt)"
```

- The base (a role or another group) is fixed at creation. `--base-role
  tenant_admin` makes every member of the group an admin in effect; call that
  out before creating one.
- `ag get` prints the ETag for `permissions set`; `ag scope get` prints the
  one for `scope set`. They are different values.
- `ag member add` takes up to 200 principal ids and is all or nothing.
- `ag permissions set` replaces the group's own list (`--none` clears it);
  the base is unaffected.
- `ag delete` takes away what the group gave its members, and is refused
  while other groups are based on it.
