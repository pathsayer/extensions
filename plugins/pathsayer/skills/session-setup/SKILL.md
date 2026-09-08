---
name: session-setup
description: How Pathsayer arms a machine. If a mint hook injects a directive to call mint_client_token, do exactly that once, silently — in ANY session (local Claude Code, Codex, or a container); the client token it mints authenticates the recon command hooks everywhere. Otherwise there is nothing to do — arming is hook-driven, not something you initiate. Use this to answer a user asking how to enable or verify the hooks.
---

# session-setup — arming a machine

The recon hooks authenticate with a client token. One bundled **mint hook**
(UserPromptSubmit) gets it minted the first time a machine has none.

## Your only possible action

If the mint hook injects a directive (you'll see it as a system reminder) telling
you to **call `mint_client_token` on the Pathsayer connector with a `ticket`** —
do exactly that, once, silently, then carry on. It fires ONCE PER MACHINE per
connector, not per session: the client token it mints is the account's credential
through that connector grant, it lives as long as the grant, and every later session
on the machine is armed already — you will only see the directive on a first
install, or after the connector was disconnected and reconnected. The recon
command hooks redeem it to authenticate their serves. You get nothing back and
needn't mention it. If the op reports `not armed`, do nothing further. **Never**
write token or ticket files yourself, and never invent this call — only act on
the injected directive.

That single op call is the whole "agent in the loop": the bearer it mints is
stashed server-side under the ticket and reaches the hooks out-of-band, so it
never enters this transcript.

## How it's enabled

Two things, once per account: connect the **Pathsayer connector** (the OAuth
grant — this is the consent act), and install the **Pathsayer plugin** on the
surface you use. Nothing is added to any repo; the install is yours alone.

**Local Claude Code** — two commands, once. The plugin persists in `~/.claude`
and its hooks arm every session after that:

```
claude plugin marketplace add https://pathsayer.com/plugin/marketplace.json
claude plugin install pathsayer@pathsayer
```

**Claude Code on the web (claude.ai/code)** — in the cloud environment's
settings, once:

1. Network access → **Custom**, and add `pathsayer.com` and `*.pathsayer.com`.
   The default allowlist covers package registries only; without this the
   plugin cannot reach Pathsayer and every hook fails open.
2. Setup script → these three lines:
   ```
   claude plugin marketplace add https://pathsayer.com/plugin/marketplace.json
   claude plugin install pathsayer@pathsayer
   claude plugin update pathsayer@pathsayer
   ```
   The script runs before Claude Code starts, so the plugin is bound at boot.
   Three lines because a cloud VM image can carry an earlier boot's install:
   `install` no-ops against it, and `update` is what refreshes it.

Every session there then installs and arms on its own.

**claude.ai chat and Cowork** — connector only; there is no plugin surface
there. MCP ops work; no hooks run.

**Codex** — the plugin is delivered as a git marketplace
(`codex plugin marketplace add pathsayer/extensions`). Hooks and skills run.

There is **no environment variable and no secret to paste** — the connector is
the credential. Connect Pathsayer once on claude.ai and it is live in claude.ai
chat, Cowork, Claude Code on the web, and CLI Claude Code signed in with that
account; the plugin's own `/mcp` sign-in is the fallback for API-key sign-ins.

The hooks share the life of the connection that armed them: a token minted
through claude.ai serves while the account has a live claude.ai connection, a
token minted through the plugin's `/mcp` sign-in while that sign-in stands. A
reconnect replaces the connection and the hooks follow it with no re-mint. Note
that claude.ai's own Disconnect button tells Pathsayer nothing; a connection ends
when a newer authorization of the same kind replaces it, thirty days after it was
authorized, or when the account is deleted. Then the next prompt on that machine
re-asks for the mint until you reconnect.

## Where capture lives today

Your sessions reach Pathsayer through the **Pathsayer tray** on your machine — a
device is a machine that runs the tray; a plugin install holds a credential. A
surface without the tray (a container, Codex) gets recon context.

## Scratch-work hygiene

If you spawn nested `claude` runs (evals, scratch), set `CLAUDE_CONFIG_DIR`
outside `$HOME/.claude` so their transcripts stay out of the tray's scan roots.
Subagent transcripts are real work and are captured on purpose; scratch must not be.
