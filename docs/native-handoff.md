# Native Codex handoff (experimental)

Bind a Markdown document to a separate Codex child conversation. Quire forks the
specified completed turn, including that turn but excluding later parent turns,
without asking a model anything. New human comments and follow-ups continue the
child. Replies appear in the comment thread; artifact edits are suggestions that
reach the Markdown file only after a human accepts them.

## Start from the CLI

Use a locally installed, authenticated Codex with the app-server protocol used by
the adapter (the local integration check targets Codex 0.151.0). Quire does not
install Codex, sign in, or change global Codex configuration.

```sh
npm run build
node packages/cli/bin/quire.js /path/to/vault \
  --doc report.md \
  --origin-provider codex \
  --origin-session EXACT_SESSION_ID \
  --origin-turn EXACT_COMPLETED_TURN_ID \
  --origin-label "Report review"
```

`--origin-provider`, `--origin-session`, and `--origin-turn` must be supplied
together with `--doc`. Only `codex` is supported. `--origin-label` is optional,
at most 80 characters, and must not contain session IDs. `--doc` alone just opens
a document. Handoff is incompatible with `--no-persist`.

The printed review URL contains only `?doc=report.md`. Never put session or turn
IDs in a URL or share them in a receipt. There is no HTTP bind endpoint and no
browser Connect button. Start the binding through the CLI; use the comments pane
to see connecting/connected/working status, review a one-time approval, retry a
failed connection, or disconnect. Closing a browser does not disconnect the child.

To resume an existing binding after a server restart, omit all origin flags:

```sh
node packages/cli/bin/quire.js /path/to/vault --doc report.md
```

Quire restores rooms for bound documents even before a browser opens them. It
rejects rebinding an already-bound document; Disconnect first to choose a new origin.

## Obtain the exact IDs

Use the intended source conversation, not a "most recent session" shortcut.
Codex's native app-server `thread/read` response identifies the thread and its
turns, including each turn's `id` and `status`. Select the delivery turn whose
status is `completed`. The adapter checks this again before forking.

If inspecting a known local Codex rollout file instead, its `session_meta.payload.id`
is the session ID and a `turn_context.payload.turn_id` is a turn ID. For example,
these read-only commands list identifiers from a file you have explicitly selected:

```sh
jq -r 'select(.type == "session_meta") | .payload.id' /path/to/known-rollout.jsonl
jq -r 'select(.type == "turn_context") | .payload.turn_id' /path/to/known-rollout.jsonl
```

The presence of `turn_context` alone does **not** prove completion. Confirm the
delivery finished in the native client or with `thread/read`. Do not modify
rollout files. Quire reads bounded native metadata (up to 64 MiB) to recover the
delivery model, provider, and recorded reasoning effort. Missing or unsupported
metadata fails closed; it never silently substitutes the current default model.

## Guarantees and recovery

- Fork uses `thread/fork` with the explicit inclusive `lastTurnId`. Quire reads
  the child back and checks its turn IDs against the source prefix. No model
  turn is started by binding, and Quire never resumes or prompts the source.
- A document's human comment revisions are serialized. Dispatch is persisted
  before launching the native run. A dispatched revision is never automatically
  repeated, including after a crash. Agent replies do not trigger new turns.
- If a run fails, times out, is cancelled, or the server stops mid-run, its
  result is uncertain: filesystem actions or suggestions might already exist.
  Inspect the child in Codex before **Retry after checking session**. Retry
  clears the pause for new/queued comments; it never replays the dispatched
  comment. If another turn is needed, explicitly post a new human follow-up.
  This favors at-most-once execution over guaranteed reply delivery.
- Replies live in the normal comment CRDT, not in binding receipts. A crash
  before a reply is durably delivered can lose that reply; recovery will not
  duplicate native actions to reconstruct it.
- The author has a stable opaque per-binding ID and displays `Codex` plus the
  optional label. The model is run provenance, not author identity.
- `quire_read_artifact` returns committed text and a revision.
  `quire_propose_replacement` requires a previously read, unchanged revision and
  one unique exact match. It respects locks, cumulative edit budgets, read-only
  policy, existing suggestions, and Quire attribution. Even in edit mode it only
  proposes. Human acceptance uses the existing suggestion workflow.
- Native command/file approvals use only **Approve once** or **Decline**.
  File approval requires an actual diff. Unsupported callbacks, including new
  permission protocols or interactive questions, fail closed; return to Codex
  for those workflows. No session-wide approval is emitted.
- Disconnect cancels and waits for the active native process before deleting the
  binding. It does not delete the Codex child or accepted edits, comments, or
  suggestions. Renames move binding files; deleted documents remain paused.

## Storage and security boundary

Private routing is stored in `.quire/conversations/<encoded-doc-path>.json`.
Encoding reuses the bridge's `stateFileName`, changing `.bin` to `.json`. Writes
use a temporary file plus atomic rename and fsync, with mode `0600` files and
`0700` directories on POSIX. Directory/file symlinks are refused. Do not track or
share this directory: it contains origin/child session IDs, but no transcripts
or credentials. Receipts contain only comment IDs, revision hashes, execution
states, and models. Raw session IDs are not published to the browser status API,
CRDT attribution, receipts, or shared exports. Keep the entire `.quire/` private;
the vault watcher and document-path validator exclude it.

On Windows, file privacy depends on the vault's Windows ACLs; POSIX modes and
directory fsync are not a portable ACL or durability guarantee. Keep the vault
accessible only to the intended local user. Run only one Quire server per vault;
the dispatch ledger is local to that server, not a distributed locking service.

Each run gets a separate loopback MCP server and a fresh random bearer capability.
Only the two artifact tools are exposed. Requests with a browser Origin, wrong
Host, or wrong/missing capability are refused. On completion, failure, or
cancellation, tools are revoked immediately: open connections are closed and the
listener shuts down, so the capability URL stops answering. The existing
vault-wide MCP endpoint is unchanged and receives no new authentication semantics.

**The agent's native filesystem and shell tools retain their existing permissions.**
The two artifact tools are a review boundary, **not a sandbox around Codex**.
The prompt asks Codex not to edit this artifact through native filesystem tools,
but Quire cannot enforce that instruction on those tools. Such writes can bypass
suggestion review and enter Quire as ordinary external disk changes. Configure
Codex's own permissions accordingly and trust the people allowed to comment in
your vault: their comments can trigger native agent work. Native model use also
uses the existing account/provider, may send document context there, and may cost
money. Loopback-only approvals do not turn the whole vault into an authenticated
multi-user service. See [SECURITY.md](../SECURITY.md).

## Offline tests and optional local check

`npm test` uses fixtures and mock providers, never an installed Codex or a real
model. Some integration fixtures require local loopback sockets and process-tree
inspection (`ps` on POSIX); an OS sandbox that forbids these cannot run that part
of the suite. Do not skip the tests to hide that restriction.

Only when you explicitly choose to exercise the installed native client:

```sh
npm run build
QUIRE_CHECK_CODEX_NATIVE=1 node scripts/check-codex-native.mjs
```

This manual script creates a synthetic native thread, attaches the ephemeral MCP
server, calls read/propose/accept directly through Codex, and archives the synthetic
thread when possible. It never calls `turn/start`, never reads an existing real
conversation, and does not prove model-driven editing or persisted-session resume.
It is not part of `npm test`, CI, or `npm run verify`. No real-model test is enabled
by this PR. Claude Code, Hermes, HTML/LaTeX, and a built-in agent are out of scope.
