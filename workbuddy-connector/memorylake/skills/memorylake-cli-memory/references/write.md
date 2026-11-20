# Writing memory

There are two ways in. Pick by what you have.

| | `fact add` | A conversation |
| --- | --- | --- |
| You have | a statement worth keeping, already distilled | raw dialogue: a chat, a meeting transcript, an agent session |
| Stored as | your text, verbatim | facts the server extracts |
| Searchable | immediately | after the server processes it |
| Owner | the one you name | chosen by the server, per fact |
| Good for | "remember that ..." | "save this conversation" |

## `fact add`

```bash
memorylake fact add --actor act-123 "Alice Chen prefers pnpm over npm"
memorylake fact add --project proj-123 "The billing service is written in Go" "Billing deploys every Tuesday"
memorylake fact add --agent agt-123 "The staging database resets nightly at 02:00 UTC"
```

Each argument becomes one fact. The response lists the stored facts with their
ids; keep those ids if you will refer to the facts again.

`fact add` is not idempotent: running it twice stores the fact twice. If it
fails without a clear answer (a timeout, a dropped connection), check with
`fact list --query` before running it again.

### Writing a good fact

A fact is read later, out of context, by someone or something that never saw
the conversation it came from. Write it so that reader needs nothing else.

- **One statement per fact.** `Alice prefers pnpm` and `Alice works in
  Berlin` are two facts, not one joined by "and".
- **Names, not pronouns.** `Alice Chen's review deadline is 2026-11-01`, not
  `her deadline is next month`.
- **Absolute dates.** Convert "yesterday", "last quarter", "next Friday" to
  dates. Add the date a preference was stated when it may change.
- **Specific over vague.** `The API rate limit is 600 requests per minute per
  key`, not `the API has a rate limit`.
- **No secrets.** Never store passwords, API keys, tokens or other credentials
  as facts.

Before adding, check whether the fact already exists. If an older version is
there, update it instead of adding a contradicting one:

```bash
memorylake fact list --actors act-123 --query pnpm
```

## Conversations

### Create one

```bash
memorylake conv create --custom-id support-2026-10-15-alice --project proj-123 --actors act-123,act-456 --name "Support call with Alice" --kind GROUP
```

- `--custom-id` is unique within the project; reuse a stable id from the
  source system (ticket number, meeting id) so a re-run finds the same
  conversation with `conv get <custom-id> --by-custom-id`.
- `--actors` lists everyone taking part; the API refuses an empty list. Each
  must be bound to the workspace.
- `--kind` is `DIRECT` (two participants, the default) or `GROUP`.

### Append messages

```bash
memorylake conv msg append conv-123 --actor act-123 --custom-id msg-0001 --text "Can we move the review to Friday?"
memorylake conv msg append conv-123 --actor act-456 --custom-id msg-0002 --text "Friday works, 2026-10-17 at 10:00." --wait --timeout 300
```

- `--actor` is who sent the message.
- `--custom-id` is unique within the conversation and makes a retry
  idempotent: the same id returns the message created the first time.
- `--timestamp 2026-10-15T09:30:00Z` records when the message was really
  sent, for imported history. Without it the server's clock is used.
- Each `--text` becomes one text block. For other block types (`FILE`,
  `IMAGE`, `THINKING`, `TOOL_USE`, `TOOL_RESULT`) pass a JSON array with
  `--content-json` or `--content-file`.

Messages form a chain: each names the message it follows. Without `--parent`
the CLI looks up the latest message for you, which needs a workspace. When
appending many messages in order, pass `--parent` with the previous message's
id to skip that lookup. `--parent` takes the `id` the previous append printed,
never its `--custom-id`.

Each message is one request. A long transcript takes a while; append in
order, one at a time. If the API answers `429` (rate limited), wait and retry
the same message with the same `--custom-id`.

Appends to one conversation are serialized. A `409` means another append got
there first: run `conv msg list conv-123`, then retry with `--parent` set to
the last message and the same `--custom-id`.

### Wait for the memory

A message is stored the moment `append` returns, but its facts are extracted
later. Before telling the user it is remembered:

```bash
memorylake conv msg append conv-123 --actor act-123 --custom-id msg-0003 --text "Decision: ship on 2026-10-20" --wait
memorylake conv cook-status conv-123
```

`--wait` polls until `cook_finished` is true (600 seconds by default). Append
the earlier messages without `--wait` and pass it only on the last one.
`cook-status` reports the same thing on demand.

If the wait times out, nothing failed: the messages are stored and processing
continues on the server. Tell the user the memory is still being built rather
than that it failed, and check `cook-status` later. Not every conversation
reaches a finished state, so do not poll forever.

### See what it produced

Facts from a conversation may land under any participant's actor or under the
project, so look in both:

```bash
memorylake conv fact-actions conv-123 --project proj-123
memorylake conv fact-actions conv-123 --actor act-123
```

Each entry says whether a fact was added, updated or forgotten. An empty list
can simply mean processing has not finished.
