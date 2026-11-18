# MemoryLake connector for WorkBuddy

A [WorkBuddy connector](https://open.workbuddy.cn/docs/connector) of the
**CLI + Skill** kind. One click on **Connect** in WorkBuddy:

1. installs the [`memorylake` CLI](https://github.com/memorylake-ai/memorylake-cli)
   (and a Node runtime, if the machine has none),
2. opens a page in the browser where the user signs in, picks a workspace and
   may import WorkBuddy's own memory files,
3. hands the agent skills that teach it to drive the CLI.

Nothing needs to be installed beforehand.

## How it relates to the other WorkBuddy integrations

| Integration | Where | What it gives |
| --- | --- | --- |
| Plugin | [`workbuddy-plugin/`](../workbuddy-plugin/) | Automatic memory through hooks: search-first recall every turn, per-turn conversation sync |
| MCP connector (`source: memorylake`) | the `memorylake-mcp` repository | Memory and library tools over MCP, cloud OAuth |
| CLI connector (`source: memorylake-cli`) | this directory | The whole CLI surface on demand: memory, workspaces, projects, files, team and access |

A connector has no hooks, so by itself the agent reaches for the CLI only
when a skill triggers. `memorylake-cli-recall` asks it to search at the start
of any turn that could depend on the user's history, with the plugin skill's
rules for phrasing and judging a search; whether the agent follows it is up
to the agent, and nothing is saved unless the user asks.

The sign-in page closes that gap for users who want it: its last step offers
**automatic memory**, which installs a small WorkBuddy plugin holding the
MemoryLake plugin's hooks and `ml-recall` and nothing else (see
[Automatic memory](#automatic-memory)). The two products stay separate and
each is complete alone:

| Installed | Sign-in, CLI, import, managing MemoryLake | Recall and saving |
| --- | --- | --- |
| Plugin only | `/memorylake:init`, the plugin's skill | automatic (the plugin's hooks) |
| Connector only, automatic memory off | the connector | when the agent or the user decides |
| Connector only, automatic memory on | the connector | automatic (the same hooks, installed by the page) |
| Both | either | automatic, by the plugin; the page installs nothing and the connector's hooks stand down |
The `source` differs from the MCP connector's because WorkBuddy requires it
to be globally unique.

## Layout

```
workbuddy-connector/
├── README.md                    this file, not part of the package
├── dev/                         tools to test the package, not part of it
└── memorylake-cli/              the package to submit
    ├── connector-meta.json      marketplace listing
    ├── cli.json                 install / upgrade / login / status / disconnect
    ├── icon.png
    └── skills/
        ├── memorylake-cli/          entry skill, adapted for the connector
        │   └── scripts/
        │       ├── login.mjs        the sign-in page (browser login or an API key, the import, automatic memory)
        │       └── auto-memory/     generated: the plugin the page installs for automatic memory
        ├── memorylake-cli-recall/   when and how to recall, written for the connector
        ├── memorylake-cli-import/   one-off import of WorkBuddy's own memory files
        ├── memorylake-cli-memory/   from the CLI repository, one section rewritten
        └── memorylake-cli-access/   verbatim from the CLI repository
```

`memorylake-cli-memory` and `memorylake-cli-access` are copies of `skills/`
in memorylake-cli at tag `v20261117`. The CLI repository tests every command
in them against its argument parser, so refresh them by copying rather than
editing here, and raise `versionCheck.minVersion` to the tag they came from.
One section differs and has to be put back after a refresh: in
`memorylake-cli-memory/SKILL.md`, "Alongside the MemoryLake harness" is
"With automatic memory on" here (same advice, worded for the connector's own
hooks as well as the plugin's); it holds no commands.

```bash
git -C ../../memorylake-cli archive v20261117 skills/memorylake-cli-memory skills/memorylake-cli-access | tar -x -C memorylake-cli
```

The entry skill `memorylake-cli` starts from the same upstream file and
differs where the connector owns the login: how to find the binary, what to
do when logged out or when the key has expired or been refused (reconnect
the connector, never `auth login`), a rule against running `auth login` or
`auth logout`, and a warning that revoking the connector's own key logs the
computer out.

`memorylake-cli-import` gives a new account something to recall. WorkBuddy
keeps its own memory in Markdown files (`~/.workbuddy/USER.md`,
`~/.workbuddy/memory/<account>_memory.md`, and `MEMORY.md` plus daily notes
under each workspace's `.workbuddy/memory/`; paths seen in 5.11.3, not a
documented interface). The files the user picks are uploaded as documents
of one project, `WorkBuddy memory` (custom id `workbuddy-memory`), and the
distilling is left to MemoryLake, which builds memory from documents by
itself and drops that memory again when a document is deleted. So a repeat
import replaces a file cleanly, with no duplicate facts to hunt down. Files
are stored verbatim, so lines that look like a credential are left out of
the copy that is uploaded. It is a one-off copy; a connector has no hook to
follow later notes.

The import is offered in two places, and they store under the same names so
either can replace what the other stored:

- **The sign-in page**, as its last step. An agent reads a skill only when it
  decides to, so a step that every new user should at least see cannot live
  in a skill alone. The page does it without the model (see below).
- **The skill**, for later: an import that was skipped, a repeat after the
  files changed, and workspaces outside `~/WorkBuddy/`, which the page does
  not look for. The first marketplace example and the page's closing hint
  name the sentence that triggers it.

## What happens on Connect

WorkBuddy runs the commands in `cli.json` in this order
(`ConnectorService.doConnectCli`, read from WorkBuddy 5.3.14 and checked
again in 5.11.3):

| Step | WorkBuddy does | `cli.json` |
| --- | --- | --- |
| Installed? | `which` on the first word of the `auth` command | that word is `memorylake` |
| Install | runs `init` if not installed | the CLI's own installer, pointed at WorkBuddy's tools directory |
| Version | runs `versionCheck`; below `minVersion` it runs `init` again | reads the date tag `v20261117` as one number |
| Logged in? | runs `status`, matches `statusMatch` | `memorylake auth status`, `Logged in: yes` |
| Log in | runs `auth`, opens the first URL it prints that contains `authUrlDomain`, waits for the process to exit | `scripts/login.mjs` |
| Done? | polls `status` every 3 seconds for up to 5 minutes | |

Disconnect runs `unAuth`. After a restart WorkBuddy only runs `status`.

Why each piece of `cli.json` is the way it is:

- **`runtime: node`** makes WorkBuddy provide Node (the user needs none) and
  put its tools directory, `~/.workbuddy/binaries/node/cli-connector-packages`,
  on `PATH` for these commands and for the agent's shell. `init` installs the
  CLI there (`$npm_config_prefix/bin`), so it is found everywhere without
  touching the user's shell profile. Node also runs the sign-in page.
- **`init`** fetches the installer into a variable before running it, because
  a plain `curl | sh` exits 0 when the download fails and WorkBuddy would
  take that for a finished install. `MEMORYLAKE_NO_SETUP` skips the
  installer's guided login, which needs a terminal. `MEMORYLAKE_NO_SKILLS`
  stops it from writing skills into Claude Code, Codex and other agents on
  the machine: a WorkBuddy user did not ask for that.
- **`auth`** starts with `memorylake version` so that its first word is the
  CLI. Were it `node`, WorkBuddy would find Node, conclude the CLI was
  installed, and never run `init`.
- **`MEMORYLAKE_CONNECTOR_HOME`** is where WorkBuddy unpacks this package,
  spelled out as `$HOME/.workbuddy/connectors-marketplace/connectors/<source>`.
  Older WorkBuddy unpacks there literally. Newer WorkBuddy (seen in 5.11.3)
  keeps packages elsewhere and rewrites exactly this prefix, in `env` values,
  to the real directory, as long as `<source>` matches the package name. It
  also accepts `${WORKBUDDY_CONNECTOR_PACKAGE_DIR}`, which older versions do
  not know, so the spelled-out form is the one that works on both.
- **`status`** exits 0 whether or not the CLI is logged in, so `statusMatch`
  decides. A stored key MemoryLake rejects still prints `Logged in: yes`, but
  `status` then checks it online and exits 1, which WorkBuddy reads as not
  connected. The check takes about 2 seconds, well inside the 10-second limit.
- **`unAuth`** ends in `|| true` because `auth logout` fails when already
  logged out, and WorkBuddy requires it to be idempotent.

Requires WorkBuddy 4.24.0 (`versionCheck`, localized listing fields).

## The sign-in page

WorkBuddy runs `auth` with no terminal and no standard input, and a CLI
connector gets no credential form. The CLI does log in through the browser
(`auth login --no-browser` prints the MemoryLake authorization URL and waits
for the browser to come back), but a default workspace still has to be
chosen, and nothing in WorkBuddy can ask. `scripts/login.mjs` asks: it
serves a one-off page on `127.0.0.1`, prints its URL for WorkBuddy to open,
and exits when the user is done.

The page signs in to the **China deployment** (`app.memorylake.cn`) and does
not offer a choice: WorkBuddy's users are in China, and China and Global
have separate accounts, so a choice mostly offered a way to pick the wrong
one. `MEMORYLAKE_BASE_URL` in the environment overrides it, which is what
the tests use; an account on `app.memorylake.ai` cannot connect otherwise.

On the page the user:

1. clicks **Sign in with browser**. The page runs
   `memorylake auth login --no-browser --base-url … --key-name "WorkBuddy · <host>" --timeout …`
   and opens the URL it prints in a new tab. The user signs in and approves
   there; MemoryLake sends the browser back to the CLI's own loopback port,
   and the CLI stores the API key MemoryLake creates for this machine. The
   page watches for the CLI to finish;
2. picks the default workspace, or creates one (`workspace create` with a
   generated `--custom-id`). The workspace already in use is selected: the
   CLI's default, or after a logout the one in `config.md`. An account with
   no workspace is offered only a new one;
3. is shown the WorkBuddy memory files found on this computer, grouped
   (profile, account memory, each workspace's `MEMORY.md`, each workspace's
   daily notes) with size, date, how many lines will be left out as
   credentials, and whether MemoryLake already holds them. The long-term
   files are ticked, daily notes are not. **Import selected** uploads them;
   **Not now** skips. The step does not appear when no file is found or no
   workspace was chosen;
4. is asked whether to turn on automatic memory, with what it saves spelled
   out. **Turn on automatic memory** installs it; **Not now** skips. See
   [Automatic memory](#automatic-memory) for when the step appears.

The import runs `project get --by-custom-id` / `project create`,
`library list` / `mkdir`, then per file `library upload --on-conflict
overwrite` and `project document import`. A document a previous import
stored under the same name is deleted first, because uploading over a
Library file does not index it again; a `duplicate` answer from `import` is
handled the same way. It does not wait for processing, so it fits in what is
left of WorkBuddy's five minutes, and stops 20 seconds before the deadline
with the rest reported as not imported. The page sends back group ids only,
never paths, and files over 2 MB or empty are not offered.

**Use an API key instead** keeps the old path: paste a key, which goes to
`auth login --api-key`. It is also the only path when the installed CLI
predates browser login (`auth login --help` has no `--no-browser`); the page
then shows the key field alone.

Every step is carried out by the CLI (`auth login`, `workspace list`,
`workspace use`, and the import's `project` and `library` commands), which
stays the only thing that reads or writes its
credentials. The page follows the browser's language, Chinese or English.

Details that matter:

- The tab is opened when the button is clicked, before the CLI has printed
  the URL, because browsers allow a new tab only during a click. Where none
  is allowed, the page itself goes to MemoryLake; the CLI still finishes the
  login, `login.mjs` sets the default workspace if there is exactly one, and
  exits 15 seconds after the login, since no page is left to ask.
- The page only follows a URL on the deployment's own origin.
- The CLI's wait is bounded by what is left of WorkBuddy's five minutes,
  and stopping `login.mjs` (Cancel on the page, a timeout, or WorkBuddy
  killing it) stops the CLI with it.
- A key from browser login expires (90 days by default). `auth status` then
  says so, and the entry skill tells the agent to ask for a reconnect.
- Disconnect runs `auth logout`, which revokes a key created by browser
  login before forgetting it. A pasted key is only forgotten.

What keeps the page private to the person who clicked Connect:

- it listens on the loopback interface only, on a random port;
- every request must carry a random token that exists only in the URL
  WorkBuddy opened, and a `Host` header naming `127.0.0.1`;
- a pasted key is never logged, and is scrubbed from any error the CLI
  prints.

A pasted key does reach the CLI as a command-line argument, the only way the
CLI accepts one without a terminal, so the user's own processes could see it
for the moment that command runs. Browser login has no such moment.

### Which CLI has browser login

Browser login arrived in CLI release `v20261117`, and both deployments serve
it. `versionCheck.minVersion` is that tag, so WorkBuddy upgrades a CLI that
is already installed (it runs `init` again when the version is lower). A
CLI that is still older for some reason gets the API key field alone.

## Automatic memory

WorkBuddy runs hooks from plugins only, and the connector format has no place
for them. So the page installs a plugin, `memorylake-auto@memorylake-connector`,
which is the MemoryLake plugin for WorkBuddy reduced to its hooks and
`ml-recall`: no commands and no skill, because the connector already installs
the CLI, signs in, and ships the skills.

**It is generated, never edited.** `dev/build-auto-memory.mjs` copies
`workbuddy-plugin/scripts` and `bin` into `scripts/auto-memory/`, rewrites the
few sentences that point at the plugin's commands and skill (each must match
exactly once, or the build fails), and routes every hook through a `run.sh` of
the connector's own. `--check` fails when the copy is out of date, and
`dev/test-auto-memory.mjs` runs it first. The plugin itself is not changed by
any of this and stays a product of its own.

```bash
node dev/build-auto-memory.mjs           # after any change under workbuddy-plugin/
node dev/build-auto-memory.mjs --check
```

**Installing.** The page uses the `codebuddy` CLI that ships inside WorkBuddy
(`…/app.asar.unpacked/cli/bin/codebuddy plugin marketplace add` and
`plugin install`, with `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1`), found by walking
up to the app that started the command and then in the usual install
locations. The marketplace is added from a copy under
`~/.memorylake/harness/workbuddy-auto-memory/`, because the connector's own
directory is replaced when WorkBuddy updates the connector. Before that the
page writes `~/.memorylake/harness/config.md`, the file the hooks read, with
the workspace chosen on the page and the account's own actor (bound to the
workspace if it was not). An existing configuration keeps its switches,
gains any missing WorkBuddy keys, and takes the chosen workspace; its actor
is kept only when the workspace did not change, so a reconnect to another
workspace or account never writes to the old one. The other MemoryLake
harnesses on the computer read the same file, so they follow the choice too.
Last, it links `~/.memorylake/bin/memorylake` to the CLI the connector
installed, unless something is already there: that is where the hooks look
when the CLI is not on their `PATH`, and in WorkBuddy 5.11.3 a hook's `PATH`
does not include the directory connectors install into.

**When the step appears.**

| The page finds | It does |
| --- | --- |
| The MemoryLake plugin enabled in WorkBuddy | installs nothing, and says the plugin provides automatic memory |
| Automatic memory installed by an earlier connect | installs it again without asking, so a reconnect brings the current hooks |
| No WorkBuddy CLI, no `bash`, or no `jq` | skips the step |
| Otherwise | asks |

**Never both.** If the user installs the MemoryLake plugin later, the
connector's hooks see it enabled in WorkBuddy's `settings.json` and exit
before doing anything (`run.sh`), so a turn is never reminded or synced
twice.

**Disconnecting** runs `login.mjs --disconnect` before `auth logout`: it
uninstalls the plugin, removes the marketplace and the CLI link. `config.md`
stays, since the other MemoryLake harnesses on the computer read it. A
conversation that is already open keeps the hooks it started with (WorkBuddy
holds an uninstalled plugin's files until its sessions end); with the login
gone they report MemoryLake as unreachable rather than searching.

**The skills know both modes.** `memorylake-cli-recall` tells the agent how to
see which one it is in (the session opens with `MemoryLake: connected` and
every message carries the `ml-recall` reminder), to search with `ml-recall`
instead of `memorylake search` there, and not to `fact add` what the
conversation sync already saves.

## Testing

`dev/` holds what the flow was verified with.

The sign-in page's import step has a test of its own, which needs no
browser: it starts the stand-in API and the page, signs in with the test
key, and drives the page's API over fixture files, with `dev/cli-stub.mjs`
answering the `project` and `library` commands so the test can see what was
uploaded.

```bash
node dev/test-import.mjs      # MEMORYLAKE_REAL_BIN=/path/to/memorylake for a particular CLI
```

Automatic memory has one too. It needs a WorkBuddy on the computer, whose
bundled CLI installs the plugin into a temporary configuration directory, not
the real one. It then runs the installed hooks the way WorkBuddy does, checks
that they stand down when the MemoryLake plugin is enabled, reconnects, and
disconnects:

```bash
node dev/test-auto-memory.mjs
```

Replay WorkBuddy's connect flow from a shell, into scratch directories, with
a stand-in for the MemoryLake API so no real key is involved:

```bash
node dev/mock-api.mjs &   # accepts the key sk-test-mock on port 18765
SIM_URL_FILE=/tmp/ml-url node dev/wb-sim.mjs connect memorylake-cli /tmp/ml-packages \
  MEMORYLAKE_CONNECTOR_HOME="$PWD/memorylake-cli" \
  MEMORYLAKE_CONFIG_DIR=/tmp/ml-config \
  MEMORYLAKE_BASE_URL=http://127.0.0.1:18765
```

It installs the real CLI release into `/tmp/ml-packages`, then waits at the
sign-in page; open the URL written to `/tmp/ml-url`. `wb-sim.mjs disconnect`
with the same arguments runs `unAuth`.

The stand-in also serves browser login: its consent page has **Approve**
and **Deny** links, and it checks PKCE, spends each code and token once, and
creates and revokes keys. To run the page against a particular CLI, such
as a build from source, name it in `MEMORYLAKE_BIN`:

```bash
MEMORYLAKE_BIN=../../memorylake-cli/target/debug/memorylake \
MEMORYLAKE_CONFIG_DIR=/tmp/ml-config MEMORYLAKE_BASE_URL=http://127.0.0.1:18765 \
  node memorylake-cli/skills/memorylake-cli/scripts/login.mjs
```

Show the connector in the real WorkBuddy app, next to every official one:

```bash
python3 dev/build-test-marketplace.py memorylake-cli /tmp/ml-marketplace/connectors-config.zip
(cd /tmp/ml-marketplace && python3 -m http.server 18766 --bind 127.0.0.1) &
echo '{"connectorMarketplaceUrl":"http://127.0.0.1:18766/connectors-config.zip"}' > ~/.workbuddy/connectors/connector-marketplace.json
```

Restart WorkBuddy to make it read the override. (5.3.14 also re-read it
every ten minutes; 5.11.3, which takes its catalog from a market API, was
not seen to fetch it while running.) Delete
`~/.workbuddy/connectors/connector-marketplace.json` to go back to the
official index. Extra `KEY=VALUE` arguments to the build script are added to
`cli.json`'s `env` in the zip only; `MEMORYLAKE_CONFIG_DIR=...` gives the
connector a login state of its own, which lets a machine that is already
logged in go through the sign-in page.

## Known gaps

- **Reaching GitHub from mainland China.** The installer and the release
  archives come from GitHub, which is unreliable there, so `init` can fail on
  the network WorkBuddy's users are on. Fixing it means serving both from a
  reachable host, or publishing an npm package that wraps the binaries
  (`init` then becomes `npm install -g`, through WorkBuddy's mirror).
- **Windows is untested.** The `win32` commands follow what listed connectors
  do but have not been run.
- **Disconnect logs the CLI out everywhere.** Login state lives in the CLI's
  default profile, which the plugins for Claude Code, Codex and the rest
  share. A dedicated profile would isolate it, at the cost of passing
  `--profile` on every command the agent runs.
- **Not yet run inside the WorkBuddy app.** Every step was run through a
  replay of WorkBuddy's connect flow (`dev/wb-sim.mjs`) with the real
  installer and CLI, and a stand-in API for the key. The last proof, a click
  on Connect in the app with a real key, is still to do.
- **The import has only met a stand-in CLI.** `dev/test-import.mjs` and a
  pass through the page in a browser cover the scan, the credential filter,
  the upload order and a repeat import, with `dev/cli-stub.mjs` in place of
  the `project` and `library` commands. Their arguments were checked against
  the real CLI's parser, and the output shapes against the plugin's
  attachment sync, which uses the same commands in production. No file has
  been imported into a real MemoryLake account through this page.
- **Accounts on the Global deployment cannot connect.** The page signs in to
  China only.
- **Automatic memory leans on WorkBuddy internals.** Where the bundled
  `codebuddy` CLI lives and how it is started are not documented interfaces
  (read from 5.11.3 on macOS). When it cannot be found or fails, the step is
  skipped or reports the error, and the connection itself is unaffected. The
  Windows location is a guess and untested. The hooks are shell scripts that
  need `bash` and `jq`, as the plugin's do.
- **Automatic memory was seen working in the app once, with a probe.** On
  WorkBuddy 5.11.3 (macOS), a plugin installed this way while the app was
  running had its `SessionStart`, `UserPromptSubmit` and `Stop` hooks fire in
  the first new conversation, with no restart. That run started its session
  cold; WorkBuddy also keeps a pre-started process for new conversations, and
  one started before the install might not have the plugin, which would cost
  the first conversation only. The connector's own plugin, installed by a
  real Connect in the app, has not been run: `dev/test-auto-memory.mjs`
  installs into a temporary configuration directory and runs the hooks by
  hand.
- **The connector format does not mention plugins.** A connector that installs
  one on the user's say-so may or may not pass review.
- **Browser login through this page has only met the stand-in.** Every
  path of `login.mjs` (approve, deny, cancel, a re-login revoking the key
  it replaces, no new tab allowed) was run against `dev/mock-api.mjs`. The
  CLI's own login (`v20261117`) was run against the China deployment:
  approved in a browser, key created, a command run with it, and
  `auth logout` revoking it. The two together, inside WorkBuddy, have not
  been run.

## Packaging

Submit the `memorylake-cli/` directory, zipped, through
[open.workbuddy.cn](https://open.workbuddy.cn):

```bash
cd workbuddy-connector && node dev/build-auto-memory.mjs --check && zip -r memorylake-cli.zip memorylake-cli -x '*.DS_Store'
```
