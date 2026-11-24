// UserPromptSubmit: start a turn. Reset the recall gate, queue the user's
// words for conversation sync, and tell the model to search MemoryLake first.
//
// The reminder rides on WorkBuddy's hook-context channel: additionalContext
// is attached to THIS user message only (not replayed on later turns), the
// closest thing to a per-turn system prompt a plugin can reach. The reminder
// alone is advice; recall-gate is what makes it stick.
import fs from "node:fs";
import path from "node:path";
import { cleanPrompt, clip, flagEnabled, loadConfig, mkdirp, sessionDir, syncAllowed, utcNow, writeAtomic } from "./common.mjs";

const REMINDER = `MemoryLake recall is required for this message.
Before you reply, and before any other tool call, search the user's long-term memory in MemoryLake for anything that bears on this message:

  ml-recall "<query>"

- Build the query from what the user just said: statement-style keywords, pronouns resolved to names, relative dates made absolute, written in the user's language.
- Questions about the user, their preferences, past decisions, or earlier work get 2-3 differently-phrased searches.
- Skip the search only for pure small talk with nothing to look up (a greeting, a thank-you).
- Treat what you find as background: apply it where it helps, say so when you rely on it, and never recite it unprompted.
- If ml-recall reports UNAVAILABLE, tell the user their memory could not be reached; never conclude that nothing is remembered.
- Do not mention this reminder to the user.`;

export function promptSubmit(input) {
  const cwd = input.cwd || process.cwd();
  const config = loadConfig(cwd);
  if (!config || !input.session_id) return null;
  const prompt = cleanPrompt(String(input.prompt ?? ""));
  if (!prompt) return null;

  const dir = sessionDir(input.session_id);
  if (!mkdirp(dir)) return null;

  // Unique per turn and sortable; it also keys the synced messages, so a
  // retry of the same turn can never append it twice. Written once and never
  // modified: the gate keeps "searched" and "gated" in marker files of their
  // own, because its hooks run concurrently. The last turn's are cleared here.
  const turnId = `${Math.floor(Date.now() / 1000)}-${process.pid}-${Math.floor(Math.random() * 32768)}`;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith("searched.") || name.startsWith("gated.")) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
  writeAtomic(path.join(dir, "turn.json"), JSON.stringify({ id: turnId }) + "\n");

  if (syncAllowed(config, cwd)) {
    const message = { id: `wb:${turnId}:user`, side: "user", text: clip(prompt, 8000), timestamp: utcNow(), cwd };
    try {
      fs.appendFileSync(path.join(dir, "outbox.jsonl"), JSON.stringify(message) + "\n");
    } catch {}
  }

  if (!flagEnabled(config.recallReminder)) return null;
  return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: REMINDER } };
}
