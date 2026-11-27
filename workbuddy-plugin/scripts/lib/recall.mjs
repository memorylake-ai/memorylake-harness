// ml-recall: search MemoryLake and print a digest that is easy on the
// model's context.
//
// A thin wrapper over `memorylake search`, which prints the whole API
// payload; one search can run to thousands of tokens. The trimming rules
// each answer an observed failure:
//
//   - facts first: short, and the likeliest answer to a question about the
//     user. Models read in order.
//   - file summaries clipped to 120 characters: a full summary lets one
//     unrelated hit take over the model's attention.
//   - matched passages clipped to 400 characters, at most 3 per document.
//   - an empty result carries a hint, never a bare empty list, which invites
//     the model to make an answer up.
//   - relevance scores ORDER the results and are never shown: they are
//     weakly calibrated, and a model shown the number treats it as authority.
//     Nor are hits dropped below a threshold: that kills real ones.
import { findCli, loadConfig, projectIds, runCli, tailLine } from "./common.mjs";
import { REPAIR } from "./host.mjs";

const PROG = "ml-recall";
const USAGE = `usage: ${PROG} <query> [--top-k N]

Searches MemoryLake for memories written from any project, machine, or client.
Write the query as statement-style keywords with pronouns resolved and relative
dates made absolute.
`;

class Exit extends Error {
  constructor(code, stderr = "") {
    super(stderr);
    this.code = code;
  }
}

// A failed search and an empty one must never look the same: a model that
// reads "no results" while the backend is down tells the user, with
// confidence, that they never mentioned something they did.
const fail = (kind, detail) =>
  new Exit(1, `${kind}: ${detail}\nMemoryLake recall is UNAVAILABLE for this call — do not read this as "no relevant memories". Tell the user the memory backend could not be reached.\n`);

const clip = (value, max) => {
  const chars = Array.from(String(value));
  return chars.length > max ? chars.slice(0, max).join("") + "…" : String(value);
};
const or = (...values) => values.find((value) => value !== undefined && value !== null && value !== false);

/** The digest of one search result, as the model reads it. */
export function digest(result, query) {
  const facts = [...(or(result.facts, []) || [])].sort((a, b) => -(or(a?.score, 0)) - -(or(b?.score, 0)));
  const docs = or(result.documents, []) || [];
  if (!facts.length && !docs.length) {
    return `No MemoryLake matches for: ${query}\n\nRetry ONCE with different wording — entity names, synonyms, statement-style keywords. If still nothing, tell the user honestly; do not invent an answer.`;
  }
  let out = "";
  if (facts.length) {
    out += `FACTS (${facts.length}, most relevant first)\n`
      + facts.map((fact) => `  - ${clip(or(fact.fact, ""), 300)}  [${or(fact.id, "?")}]`).join("\n")
      + "\n\n  Judge each fact against the question by its content — the list may include unrelated matches.\n";
  }
  if (docs.length) {
    out += `\nFILES (${docs.length})\n`
      + docs.map((doc) => {
        const summary = or(doc.document_summary, "");
        const passages = (or(doc.items, []) || [])
          .flatMap((item) => (or(item.text, "") !== "" ? [item.text] : (or(item.highlight?.chunks, []) || []).map((chunk) => or(chunk?.text, ""))))
          .filter((text) => String(text).length > 0)
          .slice(0, 3)
          .map((text) => `\n      "${clip(text, 400)}"`)
          .join("");
        return `  ${or(doc.document_name, doc.file_name, "?")}${summary !== "" ? ` — ${clip(summary, 120)}` : ""}  [${or(doc.document_id, "?")}]${passages}`;
      }).join("\n")
      + "\n";
  }
  return out;
}

/** Run ml-recall: { code, stdout, stderr }. */
export function recall(args) {
  try {
    let query = "";
    let topK = "5";
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--top-k") {
        if (i + 1 >= args.length) throw new Exit(2, USAGE);
        topK = args[++i];
      } else if (arg === "-h" || arg === "--help") {
        return { code: 0, stdout: "", stderr: USAGE };
      } else if (arg.startsWith("-")) {
        throw new Exit(2, `${PROG}: unknown option ${arg}\n${USAGE}`);
      } else {
        if (query) throw new Exit(2, `${PROG}: pass the query as one quoted argument\n`);
        query = arg;
      }
    }
    if (!query) throw new Exit(2, USAGE);
    if (!/^\d+$/.test(topK)) throw new Exit(2, `${PROG}: --top-k must be a positive integer\n`);

    if (!findCli()) throw fail("CLI_NOT_FOUND", `the 'memorylake' binary is not installed; ${REPAIR}`);
    const config = loadConfig(process.cwd());
    if (!config) {
      throw fail("NOT_CONFIGURED", `no global config (~/.memorylake/harness/config.md) and no project .claude/memorylake.local.md with a workspace; ${REPAIR} and turn on automatic memory`);
    }

    // Without --projects the endpoint returns no document hits at all.
    // Facts are unaffected, so a workspace with no projects still searches.
    const projects = projectIds(config);
    const search = runCli(["search", "--workspace", config.workspace, ...(projects ? ["--projects", projects] : []), "--top-k", topK, query]);
    const raw = search.stdout + search.stderr;
    if (search.code !== 0) throw fail("UPSTREAM_UNAVAILABLE", tailLine(raw, 3, Infinity));
    let result;
    try {
      result = JSON.parse(search.stdout);
    } catch {
      throw fail("UNEXPECTED_RESPONSE", `the CLI did not return JSON: ${raw.slice(0, 200)}`);
    }
    if (result === null || typeof result !== "object") result = {};
    return { code: 0, stdout: digest(result, query) + "\n", stderr: "" };
  } catch (error) {
    if (error instanceof Exit) return { code: error.code, stdout: "", stderr: error.message };
    throw error;
  }
}
