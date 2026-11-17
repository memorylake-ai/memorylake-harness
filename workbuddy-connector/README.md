# MemoryLake CLI connector for WorkBuddy

A [WorkBuddy connector](https://open.workbuddy.cn/docs/connector) of the
**CLI + Skill** kind. One click on **Connect** in WorkBuddy:

1. installs the [`memorylake` CLI](https://github.com/memorylake-ai/memorylake-cli)
   (and a Node runtime, if the machine has none),
2. opens a page in the browser where the user signs in and picks a workspace,
3. hands the agent skills that teach it to drive the CLI.

Nothing needs to be installed beforehand.

## How it relates to the other WorkBuddy integrations

| Integration | Where | What it gives |
| --- | --- | --- |
| Plugin | [`workbuddy-plugin/`](../workbuddy-plugin/) | Automatic memory through hooks: search-first recall every turn, per-turn conversation sync |
| MCP connector (`source: memorylake`) | the `memorylake-mcp` repository | Memory and library tools over MCP, cloud OAuth |
| CLI connector (`source: memorylake-cli`) | this directory | The whole CLI surface on demand: memory, workspaces, projects, files, team and access |

A connector has no hooks. The agent reaches for the CLI only when a skill
triggers, so this does not replace the plugin's automatic recall and sync.
`memorylake-cli-recall` is the closest a connector gets: its description
asks the agent to search at the start of any turn that could depend on the
user's history, and it carries the plugin skill's rules for phrasing and
judging a search (adapted from `workbuddy-plugin/skills/memorylake`, with
`memorylake search` in place of `ml-recall`). Whether the agent follows it
is up to the agent. Nothing is saved unless the user asks. With the plugin
installed as well, the skill steps aside for the plugin's `ml-recall`.
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
        │   └── scripts/login.mjs    the sign-in page (browser login, or an API key)
        ├── memorylake-cli-recall/   when and how to recall, written for the connector
        ├── memorylake-cli-memory/   verbatim from the CLI repository
        └── memorylake-cli-access/   verbatim from the CLI repository
```

`memorylake-cli-memory` and `memorylake-cli-access` are unmodified copies of
`skills/` in memorylake-cli at tag `v20261117`. The CLI repository tests
every command in them against its argument parser, so refresh them by copying
rather than editing here, and raise `versionCheck.minVersion` to the tag they
came from:

```bash
git -C ../../memorylake-cli archive v20261117 skills/memorylake-cli-memory skills/memorylake-cli-access | tar -x -C memorylake-cli
```

The entry skill `memorylake-cli` starts from the same upstream file and
differs where the connector owns the login: how to find the binary, what to
do when logged out or when the key has expired or been refused (reconnect
the connector, never `auth login`), a rule against running `auth login` or
`auth logout`, and a warning that revoking the connector's own key logs the
computer out.

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
for the browser to come back), but it has to be told which deployment first:
China and Global have separate accounts, and nothing in WorkBuddy can ask.
`scripts/login.mjs` asks: it serves a one-off page on `127.0.0.1`, prints its
URL for WorkBuddy to open, and exits when the user is done.

On the page the user:

1. picks the deployment (China, Global, or the one `MEMORYLAKE_BASE_URL` in
   `cli.json`'s `env` names, for a deployment of one's own);
2. clicks **Sign in with browser**. The page runs
   `memorylake auth login --no-browser --base-url … --key-name "WorkBuddy · <host>" --timeout …`
   and opens the URL it prints in a new tab. The user signs in and approves
   there; MemoryLake sends the browser back to the CLI's own loopback port,
   and the CLI stores the API key MemoryLake creates for this machine. The
   page watches for the CLI to finish;
3. picks a default workspace when the account has more than one.

**Use an API key instead** keeps the old path: paste a key, which goes to
`auth login --api-key`. It is also the only path when the installed CLI
predates browser login (`auth login --help` has no `--no-browser`); the page
then shows the key field alone.

Every step is carried out by the CLI (`auth login`, `workspace list`,
`workspace use`), which stays the only thing that reads or writes its
credentials. The page follows the browser's language, Chinese or English.

Details that matter:

- The tab is opened when the button is clicked, before the CLI has printed
  the URL, because browsers allow a new tab only during a click. Where none
  is allowed, the page itself goes to MemoryLake; the CLI still finishes the
  login, `login.mjs` sets the default workspace if there is exactly one, and
  exits 15 seconds after the login, since no page is left to ask.
- The page only follows a URL on the chosen deployment's own origin.
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

## Testing

`dev/` holds what the flow was verified with.

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
cd workbuddy-connector && zip -r memorylake-cli.zip memorylake-cli -x '*.DS_Store'
```
