# Recipes

Each recipe assumes login and workspace are confirmed (see the
`memorylake-cli` skill). Ids such as `act-123` stand for real ones taken from
earlier output.

## Remember something about the user

1. Find the user's actor and check it is bound to the workspace:

   ```bash
   memorylake actor me
   memorylake actor list --workspace ws-123
   ```

   The bindings come a page at a time; follow `continuation_token` before
   concluding the actor is missing. If `actor me`'s `id` is not among them,
   ask before binding it:

   ```bash
   memorylake actor bind --actor act-123 --workspace ws-123
   ```

2. Check for an existing version of the fact:

   ```bash
   memorylake fact list --actors act-123 --query "package manager"
   ```

3. Update the old fact if there is one; otherwise add:

   ```bash
   memorylake fact add --actor act-123 "Alice Chen prefers pnpm over npm (stated 2026-10-15)"
   ```

4. Confirm it is searchable and tell the user what was stored, word for word:

   ```bash
   memorylake search "Alice Chen package manager" --types fact
   ```

## Answer "what do you know about X?"

1. Search with two or three phrasings; include other people's actors if the
   question is about them:

   ```bash
   memorylake search "Project Atlas launch date" --top-k 20
   memorylake search "Atlas release schedule" --top-k 20
   ```

2. Keep only hits that answer the question. Quote facts verbatim; cite
   documents by name.
3. If nothing relevant came back, say so. Do not fill in from general
   knowledge without marking it as such.

## Save a conversation to memory

1. Create the conversation with a stable custom id:

   ```bash
   memorylake conv create --custom-id meeting-2026-10-15-atlas --project proj-123 --actors act-123,act-456 --kind GROUP --name "Atlas sync 2026-10-15"
   ```

2. Append the messages in order with their real timestamps, `--wait` on the
   last one only. `--parent` is the `id` the previous append printed (here
   `msg-901`), not its custom id:

   ```bash
   memorylake conv msg append conv-123 --actor act-123 --custom-id m001 --timestamp 2026-10-15T09:00:00Z --text "Launch slips to 2026-11-03."
   memorylake conv msg append conv-123 --actor act-456 --custom-id m002 --parent msg-901 --timestamp 2026-10-15T09:01:00Z --text "Then QA sign-off moves to 2026-10-31." --wait
   ```

3. Report what was extracted, from both the project and the participants:

   ```bash
   memorylake conv fact-actions conv-123 --project proj-123
   memorylake conv fact-actions conv-123 --actor act-123
   memorylake conv fact-actions conv-123 --actor act-456
   ```

## Correct a wrong memory

1. Find it and its owner:

   ```bash
   memorylake search "Alice Chen office location" --actors act-123 --types fact
   memorylake fact list --actors act-123 --query "office"
   ```

2. Read its history, so you know whether a person or a conversation wrote it:

   ```bash
   memorylake fact trace --actor act-123 fct-123
   ```

3. Show the user the current text and the proposed correction. On a yes:

   ```bash
   memorylake fact update --actor act-123 fct-123 --text "Alice Chen works from the Berlin office (since 2026-03)"
   ```

4. If it came from a conversation (`source_kind: COOK`), mention that the
   conversation may produce similar facts again, and offer to set a fact
   instruction.

## Forget something

1. Find every fact on the topic, across the owners it could live under:

   ```bash
   memorylake fact list --actors act-123 --projects proj-123 --query "salary"
   ```

2. Show the user the full list with ids and text. Delete only what they
   confirm:

   ```bash
   memorylake fact delete --actor act-123 fct-123 fct-124
   ```

3. Run the search again to confirm no fact on the topic remains.
4. If `fact trace` showed `source_kind: COOK`, or search still returns
   documents on the topic, tell the user the source still holds it and could
   yield the fact again (see "Deleting a fact does not delete where it came
   from" in [maintain.md](maintain.md)). Delete sources only on a separate,
   explicit yes: `conv delete` removes the entire conversation.

## Clean up contradictions

1. List open conflicts for the owner:

   ```bash
   memorylake fact conflict list --project proj-123 --resolved false
   ```

2. For each, show the user the facts involved (and the document, for `m2d`)
   and the strategies its category allows.
3. Resolve with the strategy they choose:

   ```bash
   memorylake fact conflict resolve --project proj-123 cfl-123 --strategy keep_fact --keep-fact-id fct-456
   ```

## Steer what a project remembers

1. Read the current instruction:

   ```bash
   memorylake fact instruction get --project proj-123
   ```

2. Draft one from the user's intent, in their language:

   ```bash
   memorylake fact instruction draft --project proj-123 --guidance "Keep decisions, owners and dates; ignore greetings and scheduling chatter" --language "Simplified Chinese" --use-existing-facts
   ```

3. Show the draft, revise it with the user, save it to a file, then set it:

   ```bash
   memorylake fact instruction set --project proj-123 --file instruction.md
   ```
