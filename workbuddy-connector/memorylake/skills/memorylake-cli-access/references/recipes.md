# Recipes

Ids such as `usr-123` stand for real ones taken from earlier output. Every
write needs the user's explicit yes first.

## Explain why someone cannot reach something

1. Find the member and run the diagnosis in [diagnose.md](diagnose.md):

   ```bash
   memorylake member list --name alice
   memorylake access show project proj-123
   memorylake member explain usr-123
   memorylake member scope get usr-123
   ```

2. Report the blocking layer in one sentence, then offer the smallest fix and
   what it would unlock. Make no change until the user picks one.

## Give one person read-only access to one project

1. Check what they have now:

   ```bash
   memorylake member explain usr-123
   memorylake member scope get usr-123
   memorylake access levels project proj-123 --member usr-123
   ```

2. Pick the case that matches:

   - **Their project scope is limited and leaves proj-123 out.** A `read`
     level opens it for reading only:

     ```bash
     memorylake access set-level project proj-123 --member usr-123 --level read --reason "Read Atlas for the Q4 review, per Bob"
     ```

     Not `access grant`: that opens the project with everything their role
     allows there, writing included if the role writes.

   - **They already reach every project, or proj-123 is in their scope.**
     They can read it already. If their role also lets them write and they
     should not, a level cannot take that away. It takes narrowing: a scope
     entry for proj-123 with `"actions": ["project:read"]` (see the scope
     loop in [change.md](change.md)), or a role that only reads. Switching
     their project scope from `all` to `instances` limits them to the listed
     projects, so list every project they keep. Explain this to the user
     before proposing it.

   - **`settable_levels` is empty or `blocked_reason` is set.** Report the
     reason; the role or a group has to grant the action first.

3. Verify and report:

   ```bash
   memorylake access levels project proj-123 --member usr-123
   memorylake member explain usr-123
   ```

## Limit someone to a single workspace

1. Read their scope and keep the ETag:

   ```bash
   memorylake member scope get usr-123 > scope.json 2> etag.txt
   ```

   Use a temporary directory for these files.

2. Edit the `memorylake:workspace` entry to `"mode": "instances"` with only
   the allowed workspace, show the user the diff, then write it back. They
   lose every other workspace at once, including any the agent itself works
   in if `usr-123` is its own member:

   ```bash
   memorylake member scope set usr-123 --scopes-file scope.json --reason "Contractor limited to the Atlas workspace" --if-match "$(cat etag.txt)"
   ```

3. Confirm with `member explain usr-123`: `scopes` lists the limit.

## Give a team access through a group

A group's instances only help with actions someone holds: from their role,
or from the group's own base or permissions. If the members' roles already
allow working on projects, instances are enough; otherwise give the group a
base or permissions too (see [change.md](change.md)).

```bash
memorylake ag create --name "Atlas team" --description "Everyone working on Atlas"
memorylake ag member add grp-123 usr-123 usr-456 usr-789
memorylake access grant workspace ws-123 --group grp-123 --reason "Atlas team works in the Atlas workspace"
memorylake access grant project proj-123 --group grp-123 --reason "Atlas team works on the Atlas project"
memorylake ag explain grp-123
```

Leaving the team is then one command: `ag member remove grp-123 usr-456`.

## A least-privilege identity for automation

For a CI job or a script that should act with exactly the rights it needs,
here one that only reads the Atlas project for a nightly report. Only the
team owner can create roles.

1. Look up the actions the job needs and their prerequisites, then make a
   role that starts empty and allow only those:

   ```bash
   memorylake perm catalog
   memorylake role create --label "CI reader" --description "Reads the Atlas project for the nightly report"
   memorylake perm rule create --role ci-reader --resource memorylake:project:proj-123 --action project:read --auto-grant-prerequisites --reason "Nightly report reads Atlas"
   ```

   Use the role `key` that `role create` printed in place of `ci-reader`.

2. Create the virtual member with that role and check what it holds. Use the
   `principal_id` that `member create` printed:

   ```bash
   memorylake member create --name "CI reader bot" --role ci-reader
   memorylake member explain usr-999
   ```

3. Issue a key for it, with an expiry and, where possible, an IP restriction:

   ```bash
   memorylake api-key create --name ci-reader --member usr-999 --expires-at 1798761600 --allowed-ip 203.0.113.0/24
   ```

   The key is printed once. Hand it to the user to put in their CI secrets;
   do not write it anywhere else.

4. Verify with `member explain usr-999` and report what the key can and
   cannot do.

## Revoke a member's access

For someone who should lose access to some or all of the team's data but
stay a member. Removing them from the team entirely is `member remove`
(team administration; it disables their keys).

1. List every source of what they hold:

   ```bash
   memorylake member explain usr-123
   memorylake perm rule list --subject-type member --subject-id usr-123
   ```

2. Show the user the list. On a yes, take away what was added on top of the
   role:

   ```bash
   memorylake ag member remove grp-123 usr-123
   memorylake perm rule delete rule-123 --reason "Carol moved off Atlas"
   memorylake access set-level project proj-123 --member usr-123 --level none --reason "Carol moved off Atlas"
   memorylake access revoke project proj-123 --member usr-123 --reason "Carol moved off Atlas"
   ```

   `revoke` only applies where her scope for the type is limited to listed
   instances, and is refused for the last one.

3. Run `member explain` again. What her role grants is still there: none of
   the above is a deny. If that is more than she should keep, propose one of
   these as a separate change, each with its own yes:
   - Limit her scope to the instances she keeps (the scope loop in
     [change.md](change.md)).
   - Move her to a role that grants less with `member set-role`. Compare the
     two with `role get` first: a built-in role such as `tenant_member` can
     grant *more* than a narrow custom role. Nobody can change their own
     role.

4. Report what is left, from the second `member explain`.
