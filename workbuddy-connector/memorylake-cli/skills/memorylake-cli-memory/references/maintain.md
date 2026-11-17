# Maintaining memory

Everything here changes stored memory immediately and cannot be undone. Show
the user what will change and get an explicit yes before running any write.

## Finding a fact's owner

Commands that change a fact need its owner. Search results do not include
it, so look the fact up by its text among the likely owners:

```bash
memorylake fact list --actors act-123 --projects proj-123 --query "pnpm"
```

Take `owner.type` and `owner.id` from the matching fact.

## Correcting a fact

```bash
memorylake fact trace --actor act-123 fct-123
memorylake fact update --actor act-123 fct-123 --text "Alice Chen prefers bun over pnpm (2026-10-15)"
memorylake fact update --project proj-123 fct-456 --metadata '{"source":"design review 2026-10-14"}'
```

- Read `fact trace` first: it shows where the fact came from and how it has
  changed, so you do not undo a deliberate edit.
- `--text` replaces the text. The old text stays in the trace.
- `--metadata` replaces the whole metadata object. To change one key, read the
  fact, merge the key yourself, and pass the full object. `'{}'` clears it.
- Prefer `update` to delete-and-add: it keeps the fact's id and history.

## Deleting facts

```bash
memorylake fact delete --actor act-123 fct-123 fct-456
```

The response lists `forgotten` and `not_found` ids. An id belonging to another
owner lands in `not_found`, and the command then exits non-zero after
printing; the other ids were still deleted. A deleted fact disappears from
search and `get`, but `fact trace` keeps its history.

Ids are deleted one request at a time. If the command fails part way with an
error rather than `not_found` (network, permission), the ids before the
failure are already gone and nothing was printed. Run `fact list` again to
see what remains before retrying; retrying is safe, because an id already
deleted only lands in `not_found`.

### Deleting a fact does not delete where it came from

A fact extracted from a conversation or a document still exists there:

- The conversation's messages keep the original text, and new messages in the
  same conversation can lead the server to extract the fact again.
- A project document keeps saying it, and `search` keeps returning the
  document.

When the user wants something gone, not just out of the fact list, tell them
where else it lives (`fact trace` shows the conversation; search shows
documents) and let them decide: `conv delete` removes the whole conversation
and every message in it; documents are removed with the `proj document`
commands; a fact instruction can tell the server to stop recording the topic.

## Explaining a fact

`fact trace` returns the fact and its history, newest first. Each entry has:

| Field | Meaning |
| --- | --- |
| `event` | `ADD`, `UPDATE` or `FORGET` |
| `source_kind` | `COOK` (extracted from a conversation) or `MANUAL` (written through the API) |
| `old_fact`, `new_fact` | the text before and after |
| `conversation_id`, `source_entry_ids` | for `COOK`: which conversation and messages it came from |

To see the messages behind a `COOK` entry:

```bash
memorylake conv msg get conv-123 msg-123 msg-124
memorylake conv consumed-messages conv-123 --message msg-123
```

`consumed-messages` lists every message the server read in the same batch,
which is the full context a fact was drawn from.

From the other direction, `conv fact-actions` lists every fact a conversation
added, updated or forgot in one owner's memory:

```bash
memorylake conv fact-actions conv-123 --actor act-123
memorylake conv fact-actions conv-123 --project proj-123 --message msg-123
```

## Conflicts

The server records contradictions it finds as conflicts, per owner, for
review.

```bash
memorylake fact conflict list --project proj-123 --resolved false
memorylake fact conflict list --actor act-123 --resolved false --stale false
memorylake fact conflict get --project proj-123 cfl-123
```

| Category | Between | Strategies |
| --- | --- | --- |
| `m2m` | two facts | `keep_fact` (`--keep-fact-id`; the other fact is forgotten), `dismiss` |
| `m2d` | a fact and a document (projects only) | `trust_fact`, `trust_document`, `dismiss` |
| `self` | one fact contradicting itself | `edit_fact` (`--edit FACT_ID=TEXT`), `dismiss` |

`--conflict-type` is `logical` (cannot all be true) or `knowledge`
(disagrees with known material; projects only). `--stale true` keeps
conflicts whose facts changed after detection: check whether they still
apply before resolving.

```bash
memorylake fact conflict resolve --project proj-123 cfl-123 --strategy keep_fact --keep-fact-id fct-123
memorylake fact conflict resolve --project proj-123 cfl-456 --strategy trust_document
memorylake fact conflict resolve --actor act-123 cfl-789 --strategy edit_fact --edit "fct-789=Alice Chen moved to Berlin in 2026-03"
memorylake fact conflict resolve --actor act-123 cfl-790 --strategy dismiss
```

A conflict resolves once. `dismiss` marks a false alarm and changes no fact;
the others change or forget facts. Present each conflict's facts to the user
and let them choose. When one fact is clearly superseded by a dated, later
statement, say so and recommend it, but still wait for their answer.

## Fact instructions

Each owner has a fact instruction: Markdown saying what its memory is for and
what it should leave out. The server follows it when extracting facts from
conversations. With none set, a built-in default applies.

```bash
memorylake fact instruction get --project proj-123
memorylake fact instruction draft --project proj-123 --guidance "Record architecture decisions and their reasons; skip small talk" --use-existing-facts --use-documents
memorylake fact instruction set --project proj-123 --file -
memorylake fact instruction clear --project proj-123
```

- `draft` asks a language model for a candidate and saves nothing. Show it to
  the user, edit it with them, then `set` it.
- `--language` takes an English language name such as `"Simplified Chinese"`,
  not a locale tag.
- `set` replaces the instruction whole; the limit is 2000 characters,
  counted as UTF-16 units (a Chinese character counts once, most emoji
  twice). `--file -` reads standard input, which avoids leaving a file behind
  in the user's directory; `--text` works for short ones.
- An instruction shapes future extraction only; it does not rewrite existing
  facts.
