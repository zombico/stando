# stando

An agent multiplexer. A small daemon runs agent CLIs (`claude`, `qwen`, `hermes`, anything you add) as
sessions; a desktop app and a terminal CLI watch and steer them. Each session can use a different API
key, and you can switch keys between turns.

```
stando daemon  ── runs CLIs, owns keys and spike folders, listens on ~/.stando/stando.sock
   ▲        ▲
 app      stando CLI
```

Closing the app never stops a session. Web pages can't reach a Unix socket, so only local programs can
drive the daemon.

## Run

```bash
npm install
npm run app                      # the desktop app (starts the daemon if needed)
node cli/stando.js help          # the CLI; `npm link` puts `stando` on your PATH
```

```bash
stando keys add anth-work anthropic       # value is read hidden
stando run -k anth-work "make a looping synth pad and render its waveform as a PNG"
stando run -d -r qwen "…"                 # -d: start in the background
stando ls
stando attach 2                           # chat from the terminal; ctrl-c detaches
stando pause 2 / resume 2 / close 2 / reopen 2
stando send 2 -i shot.png "what is wrong here"   # attach images, repeatable
```

## Models and thinking level

Each runner lists the models its pickers offer and, if its CLI has one, its thinking levels. For `claude`
that's the aliases `fable`, `opus`, `sonnet` and `haiku` (they follow the newest model of each family), the
pinned names (`claude-opus-5-5` and so on), and `--effort` levels `low`, `medium`, `high`, `xhigh`, `max`.
In the app the model is a toggle: **auto** passes no `--model`, so the CLI uses its own default, and
stando reads that default from `~/.claude/settings.json` to show it (`auto · opus`). **more…** has the pinned
names and Custom, for any other name the CLI accepts (or pass it to `-m`).

Both are per session and can change between turns; the next turn picks them up and the conversation
carries on. Every turn shows what it ran on. Switching runner drops a model or level the new CLI doesn't
know.

```bash
stando run -m opus -e high "…"
stando set 2 -m sonnet -e low      # "" goes back to the CLI's default
stando models                      # what each runner offers
```

Add `models`, `effort: { flag, levels }` and `defaultModel: { file, key }` to a runner in `~/.stando/runners.json` to give other CLIs
the same pickers.

## Theme

Colors in the app stand for concepts, not places: **live** (running, connected, added), **act** (anything
that changes something: send, start, commit, merge), **think** (model and thinking level), **record**
(branches, commits) and **fault** (errors, deletions), on surfaces from **void** to **bench**, with three
inks. Dark is the default look (after mojulo's workshop); light and system modes come with it.

Settings → Appearance changes any concept's color per mode; they're saved in `~/.stando/settings.json`.
Anything else (fonts, radii, spacing) goes in `~/.stando/theme.css`, which loads after the app's styles:

```css
:root { --font-sans: "Inter"; --radius-card: 2px; }
:root[data-theme="dark"] { --live: #7cf0a0; }
```

The tokens are documented at the top of `app/style.css`. Geist ships in `app/fonts` (SIL Open Font License).

Images can be attached in the app (button, paste or drop) or with `-i`. They are saved to the session's
`uploads/` folder and their paths are added to the prompt; the agent opens them with its own file tools.
Stando doesn't check whether the model can see images.

Pause ends the running turn and holds the queue; sending a message resumes. Close pauses and hides the
session from the list. Its folder and history stay, and reopen brings it back.

`app/icon.svg` is the mark (favicon and sidebar); `app/icon-app.svg` is the dock tile, rendered to `app/icon.png`.

## Fresh or in a repo

A session is either **fresh** (it works in its own spike folder) or attached to a **repo**. A repo session
gets a new branch `stando/<id>` checked out in its own worktree under `~/.stando/worktrees/<id>`, so
parallel sessions never share a working copy and yours is never touched. `--here` (or unticking "Own
branch" in the app) works in the repo's own working copy instead. Agents are told to commit on their
branch and never push.

```bash
stando run --repo ~/Documents/mojulo "fix the failing locale test"
stando run --repo ~/Documents/mojulo --base 3.1-rc "…"
```

Repo sessions get a Git tab in the app:

- **Changes:** staged and unstaged files with diffs; stage, unstage or discard per file; commit with a
  message (with nothing staged, Commit commits everything).
- **Graph:** the commit log across branches with lanes and labels; click a commit for its files and diffs.
- **Merge into base:** merges the session's branch in your own working copy, which must be on the base
  branch with no uncommitted changes. A conflicting merge is undone, not left half-done.
- **Push:** pushes the session's branch to `origin`.
- **Finish:** removes the worktree and, if you choose, deletes the branch. It refuses to lose work
  (uncommitted changes, or an unmerged branch) unless you tick Force. Reopening a finished session whose
  branch still exists restores its worktree.

```bash
stando commit 3 "fix locale fallback"
stando merge 3                 # into its base, in your working copy
stando finish 3                # remove the worktree; delete the branch if merged
stando clean -n                # closed sessions that are merged and clean: what would be removed
stando clean                   # remove them; --force also removes unmerged or dirty ones (branches kept)
```

## Where things live

- `~/spikes/<date>-<time>-<slug>/`: one folder per session. `session.json` is its state,
  `events.jsonl` is everything that happened, `inbox.jsonl` holds messages waiting to be sent, and the
  rest is what the agent made. Any tool can append to `inbox.jsonl` to talk to a session.
- `~/.stando/keys.json`: key profiles, mode 600. Values reach a CLI only as env vars and never reach the app.
- `~/.stando/runners.json`: add or override runners. The defaults are in `daemon/config.js`.
- `~/.stando/usage.jsonl`: spend per key, for the "today" totals.

The full event and socket contract is at the top of `shared/protocol.js`.

## Runners

Each turn starts the runner's CLI fresh, with the session's key in its environment and its folder as the
working directory. `stream-json` runners (Claude-style JSON events) get tool cards and resume the same
CLI session on the next turn. `text` runners show plain output. Approvals are off: `--dangerously-skip-permissions`
for claude, `--yolo` for qwen and hermes. With no key chosen, the CLI uses its own login.

```json
{ "codex": { "kind": "text", "argv": ["codex", "exec", "--full-auto", "{prompt}"], "provider": "openai" } }
```
