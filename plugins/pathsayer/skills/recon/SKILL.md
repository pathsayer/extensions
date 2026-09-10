---
name: recon
description: Recall the reasoning and decisions behind existing work before building or editing it. Ask recon a one-sentence question, or give it a span of code, and it returns the prior turns that produced the code — what was written, why, and how much of it still stands — plus the paths those turns belong to, ranked. Use before implementing a feature, before editing an unfamiliar region of code, when planning an approach, or whenever new work feels like it might already exist.
---

# recon — recall the reasoning behind existing work

`recon` recalls the reasoning behind existing work. Ask it what you're about
to touch and it returns the **attributions** — one record per write turn: what
was written, the decision stated at that moment, and how much of that code
still stands — plus the **paths** those turns belong to (a reconstructed
intent-arc: summary, files, commits), ranked. Use it to learn why
something is shaped the way it is, whether a question was already settled,
what was tried and abandoned, and which decisions are still live in the code.

Run it *before* you act: about to implement a feature, about to edit code you
didn't write, planning an approach to a subsystem, or when the work feels novel
— novelty is the signal you may be re-deriving. If you can't say who decided it
should work this way, run recon.

The Pathsayer MCP (`https://pathsayer.com/mcp`) must be connected and
authenticated — `/mcp` in your coding agent runs the sign-in the first time.
recon is an op under its `call` tool; `describe({ op: "recon" })` gives the
exact contract. With the Pathsayer plugin installed, recon also fires on its
own as hooks — on each prompt and around Bash — and injects up to **two
attributions** into context: each carries its `[intent]` synthesis, date,
author, its `atr_…` id, the turn address, its owning path, a `[since]` line —
and, when the matched work has been materially revised, a `[now]` block: the
work's CURRENT form (its causal head), with the head's own date, author,
`atr_…` id, address, owning path, and intent synthesis. On prompts it also
lists up to three **additional paths** the question bears on. The calls below
are how you go deeper than what a hook served. Recon runs at two efforts.
**Quick** is one serve: the two attributions above, with their since and now —
what every hook injects, and what `recon` / `recon_get` return when you call
them. **Deep** is Recon Walk and the recipe below: a kept graph of the history
around what you hold, its checks read, its questions asked, its findings cited.
Hooks run quick because they must be fast; the one exception is the commit hook,
which runs deep because a diff is an unambiguous ask. A prompt that asks for
recon — "recon X", "deep recon X", "what did we decide about X" — means deep.

## Search, then open

**Search** — `recon` with `query` (one sentence, asked the way you'd ask a
teammate) and/or `code_spans` (the code you hold). Omit `space_id`; recon
resolves it. It is the same serve the hooks inject — one implementation — so
what comes back is what a hook would have given you, as text:

```
call({ op: "recon", args: {
  query: "why does the tag walk skip past unreadable paths instead of retrying?",
  code_spans: [
    { file: "core/runtime/src/derive/tag-paths.ts", code: "<verbatim source you're about to edit>" },
    { file: "core/runtime/src/derive/worker.ts", code: "*" },   // whole-file history — '*' must be explicit
  ],
  full: true,   // the big composition: up to 10 additional paths (attributions stay a hook's 2; default paths: 3)
  session_id: "<your session uuid>",   // when you know it — the fire lands in the ledger under your session, not 'anon'
}})
```

Each `code_spans` entry carries `code`: the verbatim source you hold (exact
line match — survives squashes, rebases, moves; authorship outranks similarity)
or an explicit `'*'` for the whole file. There is no bare-file shorthand.
`query` goes to the prompt lane (the question), `code_spans` to the edit/file
lane (who wrote these lines) — the render is the same. When nothing recorded
bears on the ask, it says so.

**Open** — `recon_get` takes ONE list, `ids`; each entry is resolved by its shape:

```
call({ op: "recon_get", args: { ids: [
  "path_5227fe…",                                   // a path: digest + its attributions
  "atr_…", "<session-uuid>/<turn-uuid>",            // one attribution, in full
  "<session-uuid>/<turn-a>..<turn-b>",              // a range: every turn between a and b
  "<session-uuid>/<turn-a>..", "<session-uuid>/..<turn-b>",   // open-ended ranges
  "<session-uuid>/*",                               // the whole session
], session_id: "<your session uuid>" }})            // when you know it — same as on recon
```

Use addresses you were served — `<session>/<turn>` or an `atr_…` id; one you
construct yourself will not resolve. **Form follows shape:**

- An attribution you name comes back **full**: `what`/`why`, `intent`, owning
  path, `commits`, `since` expanded — and, when the work was materially
  revised, `now` in full: the head's complete `what`/`why`, not a teaser.
- A **path** opens to its digest (summary, topics, commits) plus `attributions`:
  every one the path owns, in session order, in **short form** — `intent`,
  address, `atr_id`, author, owning path, one `since` line, and `now` when it
  applies. A path with none says `note: "no attributions recorded"`.
- A **range** returns `attributions` in short form the same way. A range runs
  forward within one session; both ends must be turns you were served, or the
  call says so.
- Short form caps at **10** per path or range. When more exist, `more` carries
  `remaining` and `continue_from` — an address you pass straight back
  (`"<session>/<next-turn>..<turn-b>"`) to read the next page. Nothing to
  remember, no cursor.
- To read one in full, name it — the same two-step as above.

`since` is always an array of lines — one in short form, many in full. Pass
`since: 'full'` to expand it on everything returned, when a full `since` ends
in a `+N files …` roll-up and you need the rest. It never changes the form.

Naming an attribution and a range that contains it returns it once, in full.
`path_ids` and `turns` still work as spellings of `ids` for this release.

Pass `session_id` — your harness session uuid, when you know it — so the fire
joins your session in the ledger rather than `anon` (the hooks always pass it).

## What comes back

A search returns the hook render:

```
recon (prompt):

attributions:
- [intent] 2026-08-11 · Gary · atr_895cfcf1b3e78896 · turn <session>/<turn> · path_… — <title>
  <the synthesis: what was written, and the decision stated at that moment>
  [since] 99% alive (137/138 lines)
  [now] 2026-08-17 · Gary · atr_d478f4ca6585c0cd · turn <session>/<turn> · path_… — <title>
    <the head's synthesis>

additional paths:
- path_5485970fc576f7df — path ranking recipe readiness and shipping plan · 2026-08-26
```

**`attributions:`** — the turns: `[intent]` (the synthesis), date, author, its
`atr_…` id, the address, its owning path, one `[since]` line (below), and — when
the work was materially revised — a `[now]` block (below). The verbatim
`what`/`why` is on `recon_get`.

**`additional paths:`** — the arcs the ask bears on that no served attribution
already belongs to, best first (paths several signals agree on come before
paths only one found): `path_…`, title, start date. Open one to read its
attributions. Two paths may disagree; surface that rather than resolve it.

Interactive `recon` and `recon_get` responses end with a
`<!-- pathsayer-recon/6 rcn=… -->` comment — the join key to the ledger row;
leave it intact when quoting a serve.

## `since` — how stale the attribution is

One line per attribution. It reads one of these ways:

```
100% alive
94% alive · replaced by 1 attr 3d ago → atr_6b1b5289cb2f4cfb
36% alive · replaced by 6 attrs last 21d ago → atr_9ffd873c905b 41%, atr_e236b22c621b 22%
71% alive · removed 74d ago
removed 40 lines
drift unknown, write never committed
drift unknown, write not captured
drift unknown, write outside this repo
drift unknown, file not in git
```

`N% alive` — of the lines git could place, how many still stand. `replaced by
K attrs` — how many attributions' writes took over the dead lines; the date is
the latest death; `→` names up to three (share of the dead lines each) — pass an
`atr_…` to `recon_get` to read one. `removed` — the lines died with no successor.
`drift unknown, <why>` — this attribution's code cannot be tracked, so nothing
here says whether it still stands: `write never committed` (the decision lives
only in the conversation — apply the ruling, don't look for the code), `write
not captured` (it changed code we didn't record), `write outside this repo`
(a scratchpad, the memory dir), `file not in git` (a local or ignored file).

In full (an attribution you name on `recon_get`), `since` is the same line;
then a `→ atr_… · date · <its own since>` line per pointer, with the first
sentence of its intent; then one stanza per file, files with the most replaced
lines first:

```
api-recon.test.ts · 4/9 lines alive L63, L66-68 · 9 lines never committed
  L44-46, L48, L52 replaced @38e5d9df 5d ago → atr_97e6c561e6324586
  5 replaced → atr_97e6c561e6324586
+3 files · 40/61 lines alive · 7 lines never committed
```

`L…` on a row is the range `git show <sha>` displays (the hunk — it may be
wider than the dead lines); a bare count is a replacement before any commit.
Stanzas fit a ~600-token budget; whole stanzas only, and the files that don't
fit are summed into one `+N files …` line. Pass `since: 'full'` to get them
all. `commits` is the turn's own commits; `landed: false` means that sha never
reached the repo.

## `now` — the current form of the matched work

A card earns a `now` only when its code was MATERIALLY superseded (≥10% of its
lines moved, or ≥20 lines) — cosmetically-revised work serves as a plain card.
`now` names the causal HEAD of the revision chain, resolved ask-conditioned
(the branch whose replaced text your question actually touches), and carries
the head's own `atr_…` id — one `recon_get` from its full record. The `[since]`
roll-up and `now` are related but different: `[since]` lists everyone who
replaced lines (with shares); `now` is the single place the work's reasoning
lives TODAY.

---

## Recon Walk — `recon_walk`, then `recon_walk_query`

Recon Walk builds the graph of who replaced whose lines around what you hold,
stores it under an id (`rcn_…`), and returns the header and the three `checks`
lists. `recon_walk_query` reads the stored graph by that id. Walk, read the
checks, then ask the stored graph your questions — the recipe is below.

### Why a graph

Every write turn in the record is an attribution. When a later write replaces some
of an earlier write's lines, that is an edge, pointing from the earlier write to the
later one. Edges only point forward in time, so the structure is a directed graph
with no cycles: who replaced whose lines. Three things fall out of the shape that no
search over text can give you:

- **Direction is time.** Follow edges forward from any write and you reach the
  *heads* — the writes nobody has replaced, which is where the code stands today.
  Follow them backward and you reach the *origins* — the first decisions, which is
  why the code is shaped this way.
- **A missing edge is a fact.** Two writes whose living code sits on the same lines
  with no path between them means nobody ever built on both — a disagreement nobody
  has settled. You can only see that as structure; the text of either write looks
  fine on its own.
- **Distance is relevance.** The walk starts at what you asked from (the seeds) and
  lets relevance spread along the edges, fading with distance; each attribution's
  `mass` is how close it is to your question. That is how a walk stays small on a
  big history.

Each attribution in a walk has a `role`: `seed` (what you asked from), `origin` (it
took nobody's lines here — where the story starts), `head` (nobody has taken its
lines — where it stands now), `mid` (both happened). The server builds this graph
around what you hold and stores it under an id; you read it with a handful of
questions instead of scanning it.

### 1. Walk

```
call({ op: "recon_walk", args: {
  code_spans: [{ file: "…", code: "<the exact lines you would quote>" }],  // the code you hold
                                            // OR code: "*" — everyone whose living code is in the file now
                                            // OR ids: ["atr_…", "<session>/<turn>"]
                                            // OR spans: [{ file, start, lines }]
                                            // OR diff: "<a unified diff, verbatim>" — the commit you just made
                                            // OR commit: "<sha>" / base+head: a range — the commit's diff, from the record
  session_id: "<your session uuid>",        // when you know it
}})
```

What to seed with. `code_spans` — pass the exact lines you would quote (a comparator,
a guard, a check), not boilerplate; lines the record cannot match come back named in
`misses`. `code: "*"` — everyone whose living code is in the file right now. When more
than 25 people hold a file, the 25 holding the most lines are the seeds, the rest are
listed in `budget.frontier`, and the header says so (`seeded 25 of 103 holders of
<file> (61% of its living lines)`). This is not the same as recon's `"*"`: recon's
answers *who wrote here, ever*; the walk's answers *who holds here now*. Every door
resolves the path you name against HEAD first: a file renamed since answers for its
current name and the header says so (`seeded 15 holders of old.ts → new.ts (renamed
43ed910d)`); a name with no live file is a named miss, never the old path served alive. `commit` /
`base`+`head` — the commit's own diff, as the record saw it: the attributions whose
lines that commit removed, hunk by hunk. It works once the record has synced and
measured the commit; until then the response says `not in the repo lane yet` or
`walked, not yet swept — pass the diff`. For the commit you just made, pass `diff` —
a commit minutes old is never in the record yet; `commit` is for one the record has
synced (hours, on a connected repo). **Deep recon on a commit** is this same
recipe with the diff as the ask — the plugin runs it for you after every `git commit`
(the walk lands in your turn; do not walk it again), and when it cannot, it tells you
to gather the diff (`git show HEAD -U3`) and walk it yourself.

What comes back:

```
walked 0s ago · rcn_… · 28 nodes · 68 edges · 2 components · 2 overlaps · mass 81% kept · 16 seeds. <legend>

{ "seeds": [...], "checks": { "replaced": [...], "overlaps": [...], "absences": [...] },
  "misses": [...], "budget": { "massKept", "truncated", "frontier" }, "newGround"?, "unmatchable"? }

<!-- pathsayer-recon/6 rcn=rcn_… walk=n:28,rp:15,ov:2,ab:0 -->
```

- **The header** — how big the walk was and its id (`rcn_…`). The nodes and
  edges are stored under that id, with every attribution's full intent, `mass`,
  `role`, `since` and `holds`; ask for them with `recon_walk_query`.
- **`seeds`** — what the walk started from, as `atr_…` ids.
- **`checks`** — the three lists: `replaced` (attributions whose living code the
  ask touches, highest `mass` first), `overlaps` (pairs of attributions whose
  living code sits on the same lines, nobody having settled which stands — each
  pair carries `candidates`: up to 3 later writes that took lines from both
  sides), `absences` (diff and commit walks: files that historically change with
  the ones you touched and did not this time — `{file, absent, together, of,
  lastTogether}`, at most 3).
- **`misses`** — everything you asked for that resolved to nothing, named: an id,
  a file `(no holders)`, a positional span as `file:start+lines`, a code span as
  its file and first distinctive line.
- **`moved`** — seeds that arrived through a refactor: the writer whose lines
  were moved into the file you asked about, and the file it wrote them in. The
  mover's turn says "moved"; this writer's says why.
- **`budget`** — `massKept` (the share of relevance the walk kept), `truncated`,
  and `frontier` (ids to re-seed from if you want more).
- **`newGround`** / **`unmatchable`** — diff and commit walks only: hunks with no
  recorded prior (no recorded reason exists — say that, never invent one), and
  hunks whose removed lines were all too short to look up (we could not check,
  which is a different claim).

Walking the same thing again within a minute returns the same walk (the header
says `walked 23s ago`) — don't walk twice to read twice. Ids in a walk are the full
`atr_…` — the same `atr_…` that `recon_get` opens.

### 2. Read the checks first

Read `overlaps` and `replaced` before asking anything else — they show you the
disagreements you didn't know to look for. `replaced` is who holds the lines you
are touching; `overlaps` is where two writes disagree and nobody settled it;
`absences` is the file that usually changes with yours and did not this time.
The three checks ARE the recipe below — this is what a deep recon runs.

### 3. Ask the stored graph

```
call({ op: "recon_walk_query", args: { rcn: "rcn_…", verb: "now", id: "<seed id>", session_id: "…" }})
```

`verb` is one of: `checks` — the three lists again (the default). `top` — which
attributions matter most (by mass; `n`, default 10). `grep` — which attributions talk
about X (`pattern`, a regex; a lower-case pattern matches either case; `placement
tick` also finds `placementTick`; narrow with `file`, a substring or glob over the
files an attribution holds, or `author` — either works alone; rows show the matching
text; `n` caps them at 25). `node` — one attribution as it sits in this walk (`id`),
or several at once (`ids: [...]`, up to 10 per call — past that the answer names the
ones it did not serve): its intent, mass, role, holds, since, and who it replaced and
who replaced it; its what/why, commits and owning path are `recon_get`'s, not the
walk's. `now` — where this attribution's lines stand today: the heads that took them,
with a count of the writes on the way. `origins` — where this decision started: the
roots, the same way. `arc` — how `a` became `b`, step by step (the way itself). `candidates` — did
anyone settle `a` and `b` (any pair). An id is the `atr_…` you were served; a unique
prefix of it works too. If most of the nodes are seeds, `top` tells you little — start
with `grep`.
Only you can read your own walks.

### Deep recon — the recipe

"Deep recon" is the short name for this: walk what you hold, run the three
checks the walk hands you, and check your plan — or the commit you just made —
against what they found. Before a change the ask is the lines you are about to
touch; after a commit the ask is the diff, and the plugin runs the walk for you.
Same recipe, same checks, one list:

1. **Walk what you hold.** The ask decides the seed; the record decides what
   matters inside it. Before a change: the lines you are about to touch — a
   guard, a comparator, a consent check, the branch you will change — one
   `code_spans` entry per region. On a question: find the code the ask names
   however you do that best (grep and glob the repo, follow imports, open the
   directory), then seed the units that implement it — the function, the
   handler, the route, the component, the migration — each quoted verbatim as
   one `code_spans` entry, several files in one call, eight units at most (a long
   unit's opening lines are enough; seventeen units gave 67 seeds and a flat,
   unreadable graph). Not single lines picked for their importance, not whole
   files; `code: "*"` only when the file is the thing (a short script, a plan
   document). A plan number is its plan document
   plus the units it names. After a commit: the diff (just made) or `commit`
   (older) — the plugin does this one for you. Read the header: how many nodes,
   how many seeds, how much mass was kept, whether it was truncated. Read
   `misses` too — a region the record could not match is not "no history", it
   is "not looked up". When the header's seed count is more than half the
   nodes, mass is flat: `grep` for the words of your ask — the function, the
   table, the flag — instead of `top`.
2. **The replaced check** — *whose recorded reasoning do these lines carry, and
   does my change honor it?* `node` the ids in `checks.replaced` above about
   0.02 mass — ten at most, one call, `ids: [...]`; when mass is flat, the first
   ten (the list is mass-ordered) — and read each intent in full. An `intent` of
   `null` is a turn that wrote code and said nothing: read the code, or
   `recon_get` it for its what/why. Before a change: am I about to reverse this reason? After a
   commit: did I, and does the message say so? If the message names the change,
   it is deliberate; move on. If not, check the code first — the guard may have
   moved rather than disappeared — then raise it. An attribution whose `since`
   says most of its code is gone is history: ask `now` for who holds those lines
   today and check that intent instead.
3. **The overlaps check** — *two live intents on the same lines — did anyone
   settle it?* For each `checks.overlaps` pair, `node` both sides, then read the
   pair's `candidates` — the later writes that took lines from both sides. A
   candidate is often not a node of this walk: `recon_get` it. One whose intent
   addresses the disagreement settled it; taking lines from both is not by
   itself a settling. An empty list means nobody ever built on both sides: the
   conflict definitely stands — say so, and do not change that region (or, after
   a commit, do not let the diff pick a side) without saying which side you took
   and why. A side with no intent and today's date is the record still catching
   up, not a dispute: skip that pair. For a pair the response did
   not list: `verb: "candidates"`. The cross-file case — two mostly-alive
   attributions claiming different things about one mechanism, in different
   files — is yours to spot from the intents; reconcile from evidence, never by
   recency.
4. **The absence check** *(diff and commit walks only — it needs changed files
   to compare against history)* — *commits touching these files almost always
   touch something else — where is it?* Each `checks.absences` entry says files
   like yours usually change together (`together` of `of` prior commits, last on
   `lastTogether`). For each one: the edit already exists elsewhere, or make it,
   or name in one clause why it is not needed this time ("release bump — no code
   change"). If you cannot name the reason in one clause, treat it as the miss —
   the forgotten-companion class (a migration without its floor, a skill without
   its dispatch) that no line-based reading can see. When the plugin walked the
   commit for you and most of the hunks are new ground, its serve carries a
   `recon (new ground)` block — who built and decided about the files the
   additions land in; read those intents for anything the additions cross, since
   they replace no one's lines. A walk you called yourself carries no such
   block: `grep` the walk for the files' names instead.
5. **Origins, when the question is why.** `origins` walks back to the first
   decision. Cite the origin for "why is this shaped this way"; cite a head for
   "what is true now".
6. **Write down what you carry.** One line per attribution you will build on or
   reverse — its id, the walk it came from, how much of it still stands, what it
   decided: `atr_… (in walk rcn_…) · 94% alive · "…"`. Those lines go verbatim
   into the plan or the commit message. A finding is raised to the user with its
   receipt — the attribution's own words, its id, the walk, and the line that
   conflicts:

   > ⚠ `<file>` line `<+ line>` conflicts with the reason `atr_<id>` wrote it
   > (in walk `rcn_<walk>`): *"<verbatim intent>"* (`<date>`). The commit message doesn't mention it.

   An absence finding cites the coupling numbers:

   > ⚠ `<file>` changed without `<absent>` — together in `<together>` of `<of>`
   > prior commits (last `<lastTogether>`), and no reason not to this time.

   Where the record holds nothing, say "no recorded reason" — never invent one.
   Hunks under `newGround` have no recorded reason; say that. Before a change or
   after a commit, if nothing conflicts, say **"Deep recon checks are clean."**
   On a question there is no change to check: close with what the record holds
   on the ask, in the walk's own terms — what stands, what was replaced and by
   what, which pairs are unsettled — each with its `atr_…` and the `rcn_…`. If
   nothing bears on the ask, say so.

### Two more moves

The checks above are the standing check, the contradiction check and the absence
check. Two moves the recipe reaches for less often, each ending in a receipt:

- **Edge walk** *(a path)* — how one write became another: `verb: "arc"`; each
  step's intent carries the step's reason. Finds the term the fixes skipped,
  which grep cannot.
- **Origin hunt** *(backward to a source)* — `verb: "origins"`: back to the first
  decision (step 5 above), for "why is this shaped this way".

### 4. Cite

When you report a finding, name the attribution and the walk it came from:
`atr_…` (in walk `rcn_…`). When you queried a walk, say "Read rcn_…" in your response —
the walk's own id from its header; each query reply ends with a marker of its own,
which is that read's ledger row, not the walk.
Don't count edges by eye — ask the graph. Don't summarize the graph — read it. A
claim with no attribution or edge behind it is not a walk finding.

## Reading what comes back

Read the attributions (served best first), then write a 1–3 line synthesis
with a citation before coding — *"path_commits already exists (atr_…, 87/87 lines standing);
I'll extend it, not add a parallel table."* Quote the attribution's own
`what`/`why` or its address; a title or summary is a label, never the
authority. Let `since` set the weight: a `100% alive` attribution is a standing
decision; one that is mostly `replaced` is history — and when a `now` block
rides it, that IS the current form: cite the head for present-state claims and
the matched card for why the decision was made. Without a `now`, the `→ atr_…`
in `[since]` is the hop to take before citing the old card.
Follow the cheap hops yourself: open the cited doc, `git show` the commit.

## Nothing back

An empty result means **no recorded reason exists** — say exactly that; never
invent a rationale. If `derive_lag` shows pending sessions or turns, say
"unrecorded or not yet processed."

For better recon results on future work: write and edit files with the Edit/Write tools
rather than shell scripts (`python3 - <<EOF`, `sed -i`). Tool edits increase transcript
provenance for writes.

---

*recon skill v1.0.20260909.3*
