# Pathsayer extensions

Pathsayer's public distribution — one place for everything we ship for AI coding
agents. This repo is **both**:

- **`plugins/`** — a plugin marketplace for Claude Code and Codex — one artifact,
  both harnesses. Add it, install the plugin, and you get the skills **and** the
  Pathsayer MCP server wired up in one step.
- **`skills/`** — the same skills as raw, portable `SKILL.md` files (the open
  Agent-Skills format), for any tool or for reading directly.

## Claude Code

```
/plugin marketplace add pathsayer/extensions
/plugin install pathsayer@pathsayer
```

This installs the skill (`/pathsayer:recon`) and
connects the Pathsayer MCP server. On first use, run `/mcp` to authenticate.
Turn on auto-update for the `pathsayer` marketplace in `/plugin` so releases
arrive on their own; otherwise `/plugin update pathsayer@pathsayer`. From
1.0.20260908.12 an update takes effect in the running session on its next hook
fire — the hooks run the newest installed version, no restart. From
1.0.20260916.2 the plugin keeps itself current: every hook reply tells it which
build the marketplace serves, and a session behind it updates itself in the
background (Claude Code, the public marketplace only). A release that adds a
hook event, changes the MCP connection or rewrites the skill still loads at the
next session start — the assistant tells you once to run `/reload-plugins`,
naming what it picks up.

(Installed before 2026-09-08 from `https://pathsayer.com/plugin/marketplace.json`?
That channel is retired: `/plugin marketplace remove pathsayer`, then the two
lines above. Then verify from a shell, not the in-app UI:
`claude plugin list` must show `pathsayer@pathsayer` enabled — an in-app
`/plugin install` has been seen to report success and persist nothing, leaving
every cached version orphaned and no hook firing; `claude plugin install
pathsayer@pathsayer` from the shell fixes it.)

### Claude Code Web (claude.ai/code)

Cloud sessions run on a fresh VM, so the plugin is installed by the
environment, once, in its settings:

1. Network access → **Custom**, check **Also include default list of common package
   managers**, and add `pathsayer.com` to Allowed domains. (Nothing for GitHub: that
   traffic rides the GitHub proxy and never passes the allowlist.)
2. Setup script:
   ```
   claude plugin marketplace add pathsayer/extensions
   claude plugin install pathsayer@pathsayer
   claude plugin update pathsayer@pathsayer
   ```
   It runs before Claude Code starts, so the plugin is live at boot. The
   `update` line refreshes an install a VM image may already carry — once, on
   the day the environment is made: the script re-runs only when it is edited.
   From 1.0.20260916.2 the plugin updates itself from inside a session, so a
   later release reaches an environment on its own. An environment still holding
   an older build crosses over once by hand: `claude plugin update
   pathsayer@pathsayer` in any session (or edit the setup script).

Every session in that environment then installs and arms itself; the recon hooks
serve there like anywhere else, and once the environment holds a token (see
**Tokens** below) its transcripts are captured as the session runs.

## Codex

The same repo, the same plugin. Codex 0.126 or newer.

```
codex plugin marketplace add pathsayer/extensions
codex plugin add pathsayer@pathsayer
```

Two steps Codex adds that Claude Code does not:

1. **Trust the hooks once.** Codex runs a plugin's hooks only after you review
   them: `/hooks` in Codex lists the Pathsayer set — trust it. Codex records
   trust against each hook's definition, so a plugin update re-asks only when a
   hook itself changes, not on every version.
2. **Approve the mint on first use.** The first prompt directs the model to call
   `mint_client_token` on the Pathsayer MCP server; Codex asks you to approve
   that call once. After it, the recon hooks are armed for the machine.

Then hooks and skills run as in Claude Code — recon on prompts and edits, the
deep recon on a commit after every `git commit`. The session is captured locally by the Pathsayer
tray. (The status line is Claude Code's; Codex has no plugin-drivable one, and
the plugin installs nothing there.)

### The Pathsayer status line

The plugin also wires the Pathsayer status line into your profile (a SessionStart
hook writes `statusLine` into your `settings.json` on first run — Claude Code has
no manifest field for status lines, so this is the documented plugin pattern). It
shows the last recon serve riding along under your session, and wraps your
existing usage bar (`ccusage`, when installed) above it. It appears at your
next interaction after the hook runs — settings hot-reload, no restart needed.

- **Your own status line is never touched**: if `settings.json` already has one
  that isn't ours, the hook does nothing, ever.
- **Opt out**: delete the `statusLine` block from your `settings.json` (or set
  your own via `/statusline`). That sticks — the hook records the install in
  `<config-dir>/pathsayer/statusline-installed.json` and never re-adds a status
  line you removed.
- **Opt back in**: delete that marker file and start a session, or point
  `/statusline` at the plugin's `scripts/statusline.sh` yourself.

## Raw skill (any tool)

```
curl --create-dirs -o ~/.claude/skills/recon/SKILL.md \
  https://raw.githubusercontent.com/pathsayer/extensions/main/skills/recon/SKILL.md
```

## Tokens

The plugin's hooks and MCP tools sign in through the **Pathsayer tray** on your machine: sign in
once and the tray writes a client token they read. Nothing else to do on a laptop.

**Claude Code Web** — on Home, beside Devices, **Connect Cloud Device** walks the three
cloud-environment settings, once, with nothing in any repo (in the prompt box's environment
dropdown, at claude.ai/code or in the Claude app, select "Add cloud environment..." or modify an
existing environment from its settings gear in the Cloud submenu): network access set to Custom, the
default package-manager list kept, and `pathsayer.com` in Allowed domains; a setup script that installs the plugin
(`claude plugin marketplace add pathsayer/extensions` then `claude plugin install pathsayer@pathsayer`);
and a `PATHSAYER_TOKEN` environment variable holding the token it creates. **Create** then adds
the environment as a cloud device on Home, named **Claude Code Web** (rename it from its card). Its
sessions are their own harness: a repo shared from that card is the stream **Claude Code Web ·
owner/repo**, beside the laptop's **Claude Code · owner/repo**, placed wherever you choose — sharing
is per harness × repo, per device, explicit, as on a laptop. Every new session there arrives signed in, and the
device's card shows when a session there last reached Pathsayer ("never connected" means the
network setting or the setup script is wrong). A token never expires; the one way to sign a cloud
device out is the revoke icon beside its name on its card (it asks first). The device stays, reading
"unlinked", with what it shared still in its spaces; the same icon then creates a new token for it.
Signing out of the tray on a laptop does not touch it.

## What's here

- **`recon`** — recall the reasoning and decisions behind existing work before
  building or editing it, and deep recon: the same recipe over a commit, run for
  you after every `git commit`.

---

*This tree is generated from the Pathsayer monorepo (`core/extensions`) — do not
edit it here; edit the source and let the publish pipeline rebuild it.*
