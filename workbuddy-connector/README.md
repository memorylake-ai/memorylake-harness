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
| CLI connector (`source: memorylake`) | this directory | The whole CLI surface on demand: memory, workspaces, projects, files, team and access |

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
└── memorylake/                  the package to submit
    ├── connector-meta.json      marketplace listing
    ├── cli.json                 install / upgrade / login / status / disconnect
    ├── icon.png
    └── skills/
        ├── memorylake-cli/          entry skill, adapted for the connector
        │   └── scripts/
        │       ├── login.mjs        the sign-in page (browser login, an API key or the login already there; the import, automatic memory), status and disconnect
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
git -C ../../memorylake-cli archive v20261117 skills/memorylake-cli-memory skills/memorylake-cli-access | tar -x -C memorylake
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
| Install | runs `init` if not installed | `npm install -g` of `@memorylake/cli` into WorkBuddy's tools directory |
| Version | runs `versionCheck`; below `minVersion` it runs `init` again | reads the date tag `v20261123` as one number |
| Logged in? | runs `status`, matches `statusMatch`; a match skips the sign-in page | `login.mjs --status`, `Logged in: yes` |
| Log in | runs `auth`, opens the first URL it prints that contains `authUrlDomain`, waits for the process to exit | `scripts/login.mjs` |
| Done? | polls `status` every 3 seconds for up to 5 minutes | |

Disconnect runs `unAuth`. After a restart WorkBuddy only runs `status`.

Why each piece of `cli.json` is the way it is:

- **`runtime: node`** makes WorkBuddy provide Node (the user needs none) and
  put its tools directory, `~/.workbuddy/binaries/node/cli-connector-packages`,
  on `PATH` for these commands and for the agent's shell. `init` installs the
  CLI there (`$npm_config_prefix/bin`), so it is found everywhere without
  touching the user's shell profile. Node also runs the sign-in page.
- **`init`** installs the CLI from npm (`@memorylake/cli`, the release
  binaries as npm packages). WorkBuddy points npm at a registry mirror it can
  reach (Tencent, npmmirror, Huawei, then npmjs.org), so the install does not
  depend on GitHub, which is slow or blocked for many users in mainland
  China. The version is pinned to the release this package was tested with;
  keep it at or above `versionCheck.minVersion`. `--force` lets npm replace
  the binary an earlier version of this connector put in the same place with
  the CLI's own installer; without it npm stops with `EEXIST`. On Windows
  that older binary is `memorylake.exe`, which would win over npm's
  `memorylake.cmd`, so it is deleted once npm has succeeded.
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
- **`status`** is `login.mjs --status`, not `memorylake auth status`. The
  CLI keeps one login per computer (`~/.memorylake/credentials.toml`), shared
  with every other MemoryLake tool there. Were that login enough, a computer
  already set up for Claude Code or Codex would show the connector as
  connected without ever opening the sign-in page: no workspace choice, no
  import, no automatic memory. So `--status` prints `Logged in: no` until
  the page has recorded a connect in
  `~/.memorylake/harness/workbuddy-connector.json`, and from then on passes
  `memorylake auth status` through. That exits 0 whether or not the CLI is
  logged in, so `statusMatch` decides; a stored key MemoryLake rejects still
  prints `Logged in: yes`, but the check online then exits 1, which WorkBuddy
  reads as not connected. It takes about 2 seconds, well inside the
  10-second limit. WorkBuddy also runs `status` when it starts, and connects
  whatever matches.
- **`unAuth`** is `login.mjs --disconnect` (below), which logs out only a
  login the connector made. It ends in `|| true` because WorkBuddy requires
  it to succeed every time.

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
3. sees every memory feature, **all switched on**, and turns off what they
   do not want, then **Done**:
   - **Recall before answering** (`recall_reminder` and `recall_gate`),
     **Save conversations** (`sync_conversations`) and **Save files you
     send** (`sync_attachments`, resting while conversations are off,
     since files only travel with the conversation). These are automatic
     memory; see [Automatic memory](#automatic-memory) for when they show.
     On a later connect they show as `config.md` has them, so a switch the
     user turned off stays off.
   - **Import existing memory**, when WorkBuddy memory files are found on
     this computer. **Choose what to import** opens them, grouped (profile,
     account memory, each workspace's `MEMORY.md`, each workspace's daily
     notes) with size, date, how many lines will be left out as credentials,
     and whether MemoryLake already holds them. The long-term files are
     ticked, daily notes are not. An account out of quota turns the switch
     off and says so; **Done** again carries on without it.

   The step does not appear when no workspace was chosen, or when there is
   neither a file to import nor automatic memory to set.

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
- A login already on the computer (another MemoryLake tool's, or an earlier
  connect's) whose key still works is offered first: **Continue with this
  account**, showing the account and the server, or **Sign in with another
  account**, which says that the other MemoryLake tools on the computer
  switch too, since they share the login.
- Once logged in, the page leaves the CLI it ran at `~/.memorylake/bin`,
  where the MemoryLake installer puts it and the other MemoryLake tools look:
  copied there when nothing is, replacing an older release. A newer release,
  or one whose release it cannot read (a build of one's own), is kept.
  Inside WorkBuddy the connector always runs its own copy, which WorkBuddy
  puts first on the `PATH`. A `memorylake` installed some other way (a
  package manager) is not touched.
- Disconnect runs `auth logout` only for a login made on this page, which
  revokes a key created by browser login before forgetting it (a pasted key
  is only forgotten). A login that was kept stays, for the tools that made it.

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
which does what the MemoryLake plugin for WorkBuddy's hooks and `ml-recall`
do: no commands and no skill, because the connector already installs the
CLI, signs in, and ships the skills.

**It is written in Node, not copied from the plugin.** The plugin's hooks are
bash scripts that need `jq` (and `perl`, `git`, `shasum`). A connector is
installed with one click, often on Windows, on a computer that may have none
of them; WorkBuddy always has Node for a connector that declares
`runtime: node`. So `scripts/auto-memory/memorylake-auto/` is a port to Node
of `workbuddy-plugin/scripts` and `bin`, using Node's own modules only: one
entry point, `scripts/hook.mjs <hook>`, with the hooks in `scripts/lib/`, and
`bin/ml-recall` (plus `ml-recall.cmd` for a Windows shell that is not Git
Bash). It reads a repository's remotes from `.git` itself instead of running
git, and names a project exactly as the bash hooks do (on Windows, a folder
with no remote is spelled the way Git Bash spells it), so both meet in one
MemoryLake project. A change to the plugin's hooks has to be made here too,
by hand. `dev/test-hooks.mjs` runs every hook and `ml-recall` against a
stand-in CLI with nothing on `PATH` but Node, including a turn whose
process kills its whole process group (Unix) or tree (Windows, with the hook
under Git Bash) while the upload is still running, and a session start that
sends what an earlier session left.

```bash
node dev/test-hooks.mjs
```

**Installing.** The page uses the `codebuddy` CLI that ships inside WorkBuddy
(`…/app.asar.unpacked/cli/bin/codebuddy plugin marketplace add` and
`plugin install`, with `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1`), found under
`WORKBUDDY_RESOURCES_PATH`, which WorkBuddy sets for the processes it starts
and a connector's commands inherit; failing that by walking up to the app
that started the command, and then in the usual install locations. The marketplace is added from a copy under
`~/.memorylake/harness/workbuddy-auto-memory/`, because the connector's own
directory is replaced when WorkBuddy updates the connector. Before that the
page writes `~/.memorylake/harness/config.md`, the file the hooks read, with
the workspace chosen on the page and the account's own actor (bound to the
workspace if it was not), and the four switch keys set to what the page
showed, `true` or `false`. Every switch starts on, `sync_attachments`
included: where the plugin leaves attached files to an explicit opt-in,
here the switch is in front of the user with its own line. With recall and
conversation sync both off there is nothing for the hooks to do, so the
plugin is uninstalled instead. An existing configuration keeps its other
settings and takes the chosen workspace; its actor
is kept only when the workspace did not change, so a reconnect to another
workspace or account never writes to the old one. The other MemoryLake
harnesses on the computer read the same file, so they follow the choice too.
In WorkBuddy 5.11.3 a hook's `PATH` does not include the directory
connectors install into, so the hooks look there first: they run the
connector's CLI even where an older `memorylake` is on the `PATH`. They run
the binary behind npm's `memorylake` launcher directly, never a `.cmd`.

**Uploads run on their own.** WorkBuddy 5.11.3 runs each turn in a process
of its own and ends it about a second after the turn (SIGTERM). On the way
out that process kills every hook still running, children included
(`killAllHooksSync`), and a hook that answered `{"async": true}` is no
exception: it stays on the list until it exits. An upload started by a Stop
hook was killed every time, with the messages left in the outbox. So the
two Stop hooks only do what is quick and local (queue the reply, note the
session's folder and transcript in `session.json`), start
`node hook.mjs run <hook> <session>` detached, and return within
milliseconds. Once the hook has exited, that process is no hook's child, so
nothing WorkBuddy kills reaches it; it runs on the Node that ran the hook.
What it could not send stays queued, and goes with the session's next turn
or when any session starts: SessionStart starts `node hook.mjs flush` the
same way, which sends what sessions of the last 14 days left. The per-session
locks keep two runs from sending the same messages.

**When the step appears.**

| The page finds | It does |
| --- | --- |
| The MemoryLake plugin enabled in WorkBuddy | leaves the switches out, installs nothing, and says the plugin provides automatic memory |
| Automatic memory installed by an earlier connect | shows the switches as they are; **Done** installs again, so a reconnect brings the current hooks |
| No WorkBuddy CLI | leaves the three switches out |
| Otherwise | shows the three switches, on |

**Keeping up to date.** A computer that is already connected never sees the
page again: WorkBuddy updates the connector, the status command says
`Logged in: yes`, and the page, where the hooks and the CLI copy are
installed, is skipped. So when the status command finds the login it starts
`login.mjs --refresh` on its own (WorkBuddy gives `status` ten seconds, and
an install takes a few), which installs the hooks again when the installed
files differ from the ones in the connector, and replaces an older CLI copy
at `~/.memorylake/bin`. Uninstalling leaves a plugin's files in WorkBuddy's
cache, and installing the same version takes them from there, so every
install first deletes this plugin's cache directory. Failures go to
`workbuddy-hooks.log`.

**Never both.** If the user installs the MemoryLake plugin later, the
connector's hooks see it enabled in WorkBuddy's `settings.json` and exit
before doing anything (`scripts/hook.mjs`), so a turn is never reminded or synced
twice.

**Disconnecting** runs `login.mjs --disconnect`: it uninstalls the plugin,
removes the marketplace, forgets the connect, and logs out if the page made
the login. `config.md` stays, since the other MemoryLake harnesses on the
computer read it. A
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
that they stand down when the MemoryLake plugin is enabled, reconnects,
checks that the status command brings outdated hooks up to date, and
disconnects:

```bash
node dev/test-auto-memory.mjs
```

A computer that already had the CLI, logged in, has a third: WorkBuddy's
`status` must still say not connected, the page must offer to keep the login
or use another account, an older CLI at `~/.memorylake/bin` must be replaced
and a newer one kept, and disconnecting must log out only a login the page
made:

```bash
node dev/test-existing-login.mjs
```

Replay WorkBuddy's connect flow from a shell, into scratch directories, with
a stand-in for the MemoryLake API so no real key is involved:

```bash
node dev/mock-api.mjs &   # accepts the key sk-test-mock on port 18765
SIM_URL_FILE=/tmp/ml-url node dev/wb-sim.mjs connect memorylake /tmp/ml-packages \
  MEMORYLAKE_CONNECTOR_HOME="$PWD/memorylake" \
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
  node memorylake/skills/memorylake-cli/scripts/login.mjs
```

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
  skipped or reports the error, and the connection itself is unaffected.
  `WORKBUDDY_RESOURCES_PATH` was read from the source and seen on macOS only.
- **The hooks have not run in WorkBuddy on Windows.** `dev/test-hooks.mjs`
  passes with only Node on `PATH`, but WorkBuddy itself starting them
  (`node "${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs" …` under its bundled Git
  Bash, or PowerShell where that is turned off) and putting its own Node on
  the hook's `PATH` were read from the source, not seen.
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
- **Browser login through this page** was run inside WorkBuddy 5.11.3
  against the China deployment once, with a new account. Every other path of
  `login.mjs` (deny, cancel, a re-login revoking the key it replaces, no new
  tab allowed, keeping a login already on the computer) was run only against
  `dev/mock-api.mjs`.

## Packaging

Submit the `memorylake/` directory, zipped, through
[open.workbuddy.cn](https://open.workbuddy.cn):

```bash
cd workbuddy-connector && node dev/test-hooks.mjs && zip -r memorylake.zip memorylake -x '*.DS_Store'
```
