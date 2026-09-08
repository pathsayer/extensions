# Pathsayer extensions

Pathsayer's public distribution — one place for everything we ship for AI coding
agents. This repo is **both**:

- **`plugins/`** — a Claude Code plugin marketplace. Add it, install the plugin,
  and you get the skill **and** the Pathsayer MCP server wired up in one step.
- **`skills/`** — the same skills as raw, portable `SKILL.md` files (the open
  Agent-Skills format), for any tool or for reading directly.

## Claude Code

```
/plugin marketplace add https://pathsayer.com/plugin/marketplace.json
/plugin install pathsayer@pathsayer
```

This installs the skills (`/pathsayer:recon`, `/pathsayer:session-setup`) and
connects the Pathsayer MCP server. On first use, run `/mcp` to authenticate.
(`/plugin marketplace add pathsayer/extensions` — this repo — works too; the
URL is the primary channel.)

### Claude Code on the web (claude.ai/code)

Cloud sessions run on a fresh VM, so the plugin is installed by the
environment, once, in its settings:

1. Network access → **Custom**, and add `pathsayer.com` and `*.pathsayer.com`
   (the default allowlist covers package registries only).
2. Setup script:
   ```
   claude plugin marketplace add https://pathsayer.com/plugin/marketplace.json
   claude plugin install pathsayer@pathsayer
   claude plugin update pathsayer@pathsayer
   ```
   It runs before Claude Code starts, so the plugin is live at boot. The
   `update` line refreshes an install a VM image may already carry.

Every session in that environment then installs and arms itself; the recon hooks
serve there like anywhere else. (Capture belongs to the Pathsayer tray on your
machine today.)

## Codex

Codex reads local and git marketplaces, never URL ones (a plain URL is treated as
a git remote) — so this repo is its channel. Codex 0.126 or newer.

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

## What's here

- **`recon`** — recall the reasoning and decisions behind existing work before
  building or editing it, and deep recon: the same recipe over a commit, run for
  you after every `git commit`.
- **`session-setup`** — how a machine arms itself, once per connector.

---

*This tree is generated from the Pathsayer monorepo (`core/extensions`) — do not
edit it here; edit the source and let the publish pipeline rebuild it.*
