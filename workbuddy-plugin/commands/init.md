---
description: Set up MemoryLake for WorkBuddy, or change its account, workspace or switches -- opens the sign-in page
disable-model-invocation: true
allowed-tools: Bash
---

Open MemoryLake's sign-in page for the user:

```bash
memorylake-connect
```

It opens in their browser and prints its address. Tell the user the page is
open, and pass the address on in case the browser did not come up. Everything
happens on that page: signing in (or keeping the login already on this
computer), choosing a workspace, importing the memory WorkBuddy already keeps
here, and the switches for automatic memory. The page stays open for half an
hour.

Never ask for an API key, type one into a command, or run `memorylake auth
login` yourself: the page is where the user signs in.

When the user says they are done, confirm it took:

```bash
memorylake auth status
memorylake ws current
```

Report the account and the workspace in one line. What they chose applies
from the next message; the session-start status line appears with the next
new conversation.
