# Diagnosing access

Everything here only reads. Run it freely.

## "What can I do?"

```bash
memorylake perm me
```

Prints your role, every permission you hold, and per resource type whether
you reach every instance. A command refused with a permission error is
explained here first. If `member explain`, `access show` or `perm rule list`
is refused, you lack the rights to inspect others; tell the user that a team
owner or admin has to run the diagnosis.

## "Why can't member M reach instance I?"

1. Find the member's principal id:

   ```bash
   memorylake member list --name alice
   memorylake member list --email alice@example.com
   ```

2. Ask the instance who can reach it and why:

   ```bash
   memorylake access show project proj-123
   ```

   `allowed` lists members and groups with access and the reason for each;
   `blocked` lists members who cannot. If M is in `allowed`, the problem is
   elsewhere (wrong workspace, wrong profile, a typo in the id).

3. Ask the member what they hold and where it comes from:

   ```bash
   memorylake member explain usr-123
   ```

   `permissions` shows each action with its source (the role, an access
   group, or a direct rule). `scopes` shows the types limited to listed
   instances; types not listed are unrestricted.

4. Check the scope and the level on the instance:

   ```bash
   memorylake member scope get usr-123
   memorylake access levels project proj-123 --member usr-123
   ```

5. Name the blocking layer:

| Finding | Blocking layer | Typical fix |
| --- | --- | --- |
| No source grants the action | role | a rule on a custom role, or an access group with the permission |
| Action granted, but the type is limited and I is not listed | access scope | `access grant` (adds I to the scope) or a group with I |
| Action granted only on some instances via `actions` | access scope | edit that instance's `actions` |
| Level on I is below what is needed | permission level | `access set-level` |
| `access levels` shows a `blocked_reason` | stated there | follow it |

A team owner is never blocked by any of these. Someone who can do *more*
than expected got it from one of the sources in `member explain`: a group, a
direct rule, or a level. Groups and levels reach past a narrowed scope.

Memory is guarded by bindings: reading or writing an actor's or agent's
facts in a workspace is a permission on its binding there, not on the actor
or agent itself. For "Alice cannot see Bob's memories", ask the binding, with
the `workspace-actor` and `workspace-agent` kinds and `--workspace`:

```bash
memorylake access show workspace-actor act-123 --workspace ws-123
```

## "Who can reach this?"

```bash
memorylake access show workspace ws-123
memorylake access show skill skl-123
```

## "What does this group or role give?"

```bash
memorylake ag list
memorylake ag explain grp-123
memorylake ag member list grp-123
memorylake role get reviewers
memorylake role scope get reviewers
memorylake perm rule list --subject-type role --subject-id reviewers
memorylake perm rule list --subject-type member --subject-id usr-123
```

## "Who changed this?"

Every scope, rule, level and grant change is in the audit log with the
`--reason` it was made with. Filter by who acted or by what was changed:

```bash
memorylake audit-log list --category management --target-id usr-123
memorylake audit-log list --actor usr-456 --page-size 50
```

`--actor` here takes a principal id (the member who acted), not a memory
actor.
