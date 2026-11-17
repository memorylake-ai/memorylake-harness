# Reading memory

## Search

```bash
memorylake search "Alice Chen package manager preference"
memorylake search "quarterly revenue 2026 Q3" --types document,fact --top-k 20 --compact
memorylake search "quarterly revenue 2026 Q3" --projects proj-1,proj-2
memorylake search "onboarding checklist" --actors act-123,act-456
```

The response has three lists: `documents`, `facts` and `databases`. Every
entry has a `rank` that is unique across all three, so sorting by `rank`
restores the overall order.

| Flag | Default | Note |
| --- | --- | --- |
| `--projects` | every project in the workspace | narrow to some projects; each document carries its `project_id` |
| `--actors` | **your own actor only** | name other people to include their memories |
| `--types` | all | `document`, `fact`, `database` |
| `--top-k` | 10 | 1-1000, shared across all types, not per type |
| `--compact` | off | ids, name, `project_id` and one short snippet per hit |

There is no paging: raise `--top-k` for more.

A document hit is opened with the ids it carries (`project_id`,
`document_id`):

```bash
memorylake proj doc get --project proj-123 doc-456
memorylake proj doc download --project proj-123 doc-456 -o -
```

To browse rather than search, `proj doc list --compact` lists every project's
documents (`id`, `name`, `project_id`, `status`), or one project's with
`--project`. Page with the `continuation_token` it prints.

Search facts carry `id`, `fact` (the text), `score` and `rank`, but not their
owner. To change one, find its owner with `fact list` (see
[maintain.md](maintain.md)).

### Writing the query

How the query is phrased matters more than how many times you search.

- **Statement-style keywords beat questions.** `Alice Chen package manager`
  finds more than `what package manager does Alice like?`.
- **Resolve pronouns to names.** `Alice Chen's review deadline`, not
  `her deadline`.
- **Absolute dates.** `2026-09 migration`, not `last month's migration`.
- **One intent per query.** Two topics in one query match neither well; run
  two searches.
- For a broad question, run two or three differently phrased searches rather
  than one long one.

### Judging results

Search returns matches for any query, related or not. For each hit, read the
text and decide whether it answers the question. Discard what does not,
however high its rank. Document hits are pointers: judge them by
`document_name` and `document_summary`, then quote the matched `items`.

When nothing relevant comes back, retry once with other words (synonyms, the
entity's full name, a different angle). Facts are stored in the language they
were written in, so for memory kept in more than one language, also try the
query in the other language (`Alice Chen 包管理器` as well as `Alice Chen
package manager`). If that also fails, tell the user nothing was found. Never
fill the gap from your own assumptions.

An empty result has other causes worth ruling out before "nothing stored":
the wrong workspace (`ws current`), another person's memory without
`--actors`, or a conversation still being processed (`conv cook-status`).
A workspace id that names no workspace is not one of them: listings fail with
`[WORKSPACE_NOT_FOUND]` (or the API's `[NOT_FOUND]`) and a non-zero exit, so
an empty list always means the workspace exists and holds nothing there.

When facts disagree, prefer the most recent `updated_at`, mention the
disagreement to the user, and consider whether it is a conflict worth
resolving ([maintain.md](maintain.md)).

## Listing facts

`fact list` is exhaustive rather than ranked: every fact of the named owners,
newest first.

```bash
memorylake fact list --actors act-123
memorylake fact list --projects proj-123 --query "rate limit" --page-size 200
memorylake fact list --actors act-123,act-456 --agents agt-123
```

- At least one of `--actors`, `--projects`, `--agents` is required; 50 owners
  at most in total.
- `--query` keeps facts whose text contains the substring. It is a plain
  substring match, not semantic search.
- Pages hold up to 200 facts; follow `continuation_token` with
  `--continuation-token` for the rest.
- Each fact carries `owner` (`type`, `id`), which is what `fact get`,
  `update`, `trace` and `delete` need.

## One fact

```bash
memorylake fact get --actor act-123 fct-123
```

The id must belong to that owner. A deleted (forgotten) fact is not found by
`get`; `fact trace` still shows it.
