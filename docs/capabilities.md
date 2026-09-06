# Terry — functions and capabilities

A complete description of what Terry does. It is kept alongside the code and
changes with it; `git log -- docs/capabilities.md` says when it last moved.

Terry turns a private Discord channel into the front end for a long-running
coding-agent conversation. You leave the terminal, wake him from your phone, talk
about the work, change his model and effort, and read the results in the same
channel. He survives restarts and reboots: the conversation is keyed to the
channel and resumed by id.

Terry starts **asleep** and does nothing until an authorised operator wakes him.

---

## 1. The model

| Concept | What it is |
| --- | --- |
| **Room** | One Discord channel, identified by `(guild_id, channel_id)`. Rooms never share a conversation. |
| **Conversation** | One coding-runtime session, identified by a UUID. Owned by exactly one room. |
| **Turn** | One message from an authorised author, answered by the runtime. |
| **Operator** | A human permitted to command Terry and queue work. |
| **Peer** | Another bot permitted to hold a conversation, but not to command. |

A room is in one of three states:

| State | Behaviour |
| --- | --- |
| `asleep` | Ordinary chat is ignored entirely. Commands still work. |
| `awake` | Chat is queued as turns. |
| `working` | A turn is running. Further messages queue behind it. |

### Addressing Terry

Terry acts on a message that begins with a direct mention of him, and on
un-mentioned messages while an attention window is open (see below). Both forms
count: the user mention `<@id>` and the managed role Discord auto-creates for a
bot, `<@&id>`, because both render identically on screen and refusing one makes
him look broken. Anything not addressed to him is logged at debug and dropped —
deliberately logged, because a silently discarded message is indistinguishable
from a dead service.

---

## 2. Commands

All commands work whether Terry is asleep or awake. Case-insensitive.

| Command | Effect |
| --- | --- |
| `@Terry menu` / `help` | The command list |
| `@Terry wakeup` / `wake` | Start or resume this room's conversation |
| `@Terry wakeup: <text>` | Wake and queue `<text>` as the first turn, in one message |
| `@Terry sleep` | Interrupt work, drop pending input, stop taking chat |
| `@Terry stop` | Interrupt the current task, stay awake |
| `@Terry status` | State, conversation id, model, effort, permissions, queue depth |
| `@Terry ping` | Connection check and runtime version |
| `@Terry list models` / `models` | Models the installed runtime advertises |
| `@Terry model <id>` | Choose a model |
| `@Terry effort` | Effort levels the runtime supports |
| `@Terry effort <level>` | Choose one |
| `@Terry instructions` | What this conversation is pinned to, and what has drifted |
| `@Terry accept instructions` | Adopt the current versions from the registry |
| `@Terry new session` | Replace this room's conversation — asks first |
| `@Terry new session confirm` | Confirm the replacement |
| `@Terry activity <text>` | Set custom presence text |
| `@Terry activity auto` | Return to automatic presence text |

Anything else addressed to Terry while awake is a turn in the conversation.

**Queueing.** A message arriving while a turn is running is queued, and Terry says
how many are waiting. The queue drains in order.

**Streaming.** A placeholder is posted the moment a turn starts and edited in
place as text arrives, with a ticker line naming what the runtime is doing and a
footer saying what the turn cost. Edits are coalesced; overflow continues in a
new message with code fences kept balanced. Peer turns and overheard turns are
posted whole instead — a mention added by edit notifies nobody, and a placeholder
would already be a reply to something that may not be for him.

**Interruption.** `stop` asks the runtime to interrupt in-band and keeps the
process warm for the next turn; a runtime that does not stop within
`INTERRUPT_GRACE_MS` is killed instead. `sleep` always stops the process. Either
way, output produced before the interruption is **discarded**, because posting
it after "Task interrupted" would contradict the message the operator has just
read. Stop means stop.

### Ambient listening

Mention Terry once and an **attention window** opens. Inside it, un-mentioned
messages are handed to the runtime, which decides from conversational context
whether they were meant for him and answers with **silence** when they were not.
Every reply he gives re-opens the window; it closes after
`ATTENTION_WINDOW_SECONDS` of nobody speaking to him (default 90, 0 disables).

A message outside an open window never reaches the runtime, so idle chatter is
free. A message inside one costs a turn, because judging it is the runtime's job.

Never overheard: **peers** (a peer must always address him directly), a
**sleeping room**, and anyone who is not an operator. An overheard message that
arrives while he is working queues in silence.

---

## 3. Presence

| Room state | Discord shows |
| --- | --- |
| asleep | idle |
| awake | online |
| working | do not disturb |
| connecting | idle |
| unavailable | invisible |

One component owns presence. With several rooms active the busiest wins —
working beats awake beats asleep — so the indicator reflects the busiest room
rather than whichever changed last. Updates are coalesced onto a trailing timer
and identical states are skipped, so a busy room cannot flood the socket.
Presence is re-asserted after every reconnect.

---

## 4. Conversations and the runtime

Terry drives a coding runtime as a child process over newline-delimited JSON.
Built and tested against **Claude Code 2.1.263**.

**Capability discovery.** At startup Terry reads the runtime's own `--help` and
refuses to run if the flags it needs are absent. It never hard-codes a model or
effort list — the menu comes from the installed runtime, so it cannot drift out
of step with reality. Permission settings are validated against the choices the
runtime actually advertises.

**Model and effort** are per room, settable from Discord, and apply to the **next**
turn. Work already running is never switched underneath you. A model change is
applied to the running process in-band; an effort change restarts the runtime and
resumes the same conversation by id, because the runtime offers no in-band effort
switch. No context is lost either way. A switch the runtime refuses falls back to
a restart.

**Create versus resume.** The runtime rejects the wrong verb — `--session-id` for
an id it already knows, `--resume` for one it does not. Terry records in the
database whether a conversation has actually been started, so the distinction
survives a service restart rather than living only in memory.

**New session.** `new session` asks for confirmation, then retires the old
conversation rather than deleting it: the id is filed in `session_history` and
stays resumable.

**Restart behaviour.** A restart returns every room to `asleep` while keeping its
conversation mapping, so waking resumes rather than starting fresh. Staying awake
across a restart is opt-in via `RESUME_AWAKE_ON_RESTART`.

---

## 5. Instructions (the registry)

Terry has no built-in personality or house rules. What he is like comes from a
database-backed registry, not from files in the repository.

- Instructions are **keyed** and **scoped**, with precedence `global < guild <
  channel`. The most specific row for a key wins.
- Rooms declare which keys they load, **in order**.
- They are read **on every turn**, so an edit is visible on the next message with
  no restart.
- A key marked `--required` that resolves to nothing **stops the turn** with a
  visible error naming the key. It is never a silent skip.
- The registry ships empty. Nothing is seeded.
- A room declares no keys until told to, so a new channel inherits
  `DEFAULT_INSTRUCTION_KEYS`. A room with its own keys always wins, and a room
  loading nothing at all is logged at warn.

Instructions are edited only through the operator CLI, never from chat. Terry
cannot be redefined by talking to him.

---

## 6. Pinned instructions and drift

Resolving live every turn is right while editing an instruction and wrong for a
conversation already running under it: the edit rewrites that conversation's
rules mid-thread, and the conversation cannot report it, because from its side
the rules were always these ones.

So a conversation is **pinned**. On its first turn Terry mints what he was told —
each resolved body and its sha256, frozen against that conversation's id. Every
later turn compares the registry against the pin, and a difference is **drift**.

| `INSTRUCTION_DRIFT_POLICY` | Behaviour |
| --- | --- |
| `hold` (default) | Load the version the conversation started with; report which keys moved. |
| `live` | Load the new version; report that it did. |
| `off` | No pinning; resolve live every turn. |

Each distinct drift state is reported **once** — repeating it every turn teaches
the reader to skip it. Editing the same key a second time is a new state and is
reported again, because the signature includes the content hash, not just the key.

Deliberate edges:

- A key **added** after minting is loaded live, not called drift. There is no
  earlier version for it to have drifted from.
- A key **deleted** mid-conversation keeps its pinned copy under `hold`. Under
  `live` a required one becomes a missing-instruction error.
- `new session` mints a fresh set. Old pins stay attached to the retired
  conversation they describe, which is what makes them worth keeping.
- Accepting authors nothing — it only chooses which version a running
  conversation is held to — so it is a room control rather than a registry edit.

---

## 7. Peer agents

Terry can hold a conversation with another bot in the same channel. Name its bot
user id in `PEER_AGENTS`.

**Terry addresses a peer back with a real mention.** Every other message Terry
sends suppresses mentions entirely, so a reply cannot ping whoever the runtime
happened to name. A reply to a peer is the single exception, and it is what makes
the conversation possible at all: a mention-gated peer hears nothing otherwise
and the exchange ends after one turn.

**The exchange is budgeted.** Two agents that both answer when mentioned will
answer each other until something runs out. `PEER_TURN_LIMIT` (default 6) caps
consecutive peer turns; Terry then says so, once, addressed to nobody — a mention
there would restart the loop it just ended. **Any operator message refills the
budget**, so the conversation resumes by a human joining in.

The budget protects this side unilaterally. It does not depend on the peer being
well-behaved.

What a peer cannot do:

- **Use commands.** No `sleep`, `stop`, `model`, `effort` or `new session`.
  Attempts are logged, not answered — replying to a bot to say no is one more
  message it may answer.
- **Wake a sleeping room.** A human opens the room before two agents can use it.
- **Speak through a webhook.** A webhook carries no identity worth allowlisting,
  so it is refused even wearing a peer's id.

Peers and operators are separate lists. Adding a peer grants it nothing an
operator has — including runtime authority. `PERMISSION_MODE` belongs to the
service rather than to whoever is talking, so a peer turn runs at
`PEER_PERMISSION_MODE` instead, which defaults to `plan`: a peer can read and
reason, and cannot write. Switching between the two is an in-band message to
the running process, not a restart.

---

## 8. Channel history and attachments

**Every** turn carries what has been said in the channel since the last one, as
**labelled background context** and explicitly not as instructions to replay. The
first turn of a conversation carries the last `HISTORY_LIMIT` messages; each turn
after carries only what is new, so nothing is repeated and a turn with nothing
new carries no block at all.

This is not a nicety. A conversation the bot cannot see is one it cannot follow,
and deciding whether an un-mentioned message was meant for it is exactly a
question about what came before.

Attachments are **described** — filename, type, size — and explicitly marked as
not inspected. A URL is not proof an image was looked at.

---

## 9. Security model

Discord is a transport, not an authority. Every message passes independent gates
before it is acted on:

1. A **webhook** is refused, always, and first.
2. It must be a **guild channel** — direct messages are refused.
3. The **guild** must be allowlisted, if `ALLOWED_GUILDS` is set.
4. The **channel** must be allowlisted.
5. The **author** must be an allowlisted operator, or an allowlisted peer.

Beyond the gates:

- **The service refuses to start** with an empty channel or operator allowlist.
  An empty allowlist is a configuration mistake, not an open door.
- **Discord input cannot widen the runtime's authority.** `PERMISSION_MODE` and
  `PERMISSION_PROMPTS` are read from the environment and are not settable from
  chat. The default (`plan` + `none`) can read and reason but cannot write, run
  or deploy; anything needing approval fails clearly rather than being granted.
- **Instructions live in the database**, not in chat.
- **The token never reaches a log line or an error message.** It is registered as
  a secret at startup and redacted from all structured output. API failures
  report status and path, never response bodies.
- **Replayed Gateway events are de-duplicated**, so a RESUME cannot run the same
  work twice. De-duplication keys are pruned every six hours.

---

## 10. Resilience

- Heartbeat with acknowledgement tracking; a missed ack drops the zombie
  connection and resumes.
- RESUME on reconnect, with re-identify when the session cannot be resumed.
- Exponential backoff with jitter, capped at 30 s.
- Authentication and intent failures (close codes 4004, 4010–4014) stop rather
  than retry — they will never succeed on a retry, and hammering the Gateway is
  how a token gets rate-limited. The service writes a halt sentinel and exits;
  see §14.
- Discord 429s are honoured using the returned `retry_after`.
- Messages over Discord's 2000-character limit are split, preferring paragraph
  boundaries, and a split code block is re-fenced on both sides.
- A delivery failure is logged even though the operator cannot be told — telling
  them is precisely what just failed.

---

## 11. Operator CLI

```
bun run src/admin.ts <command>

Instructions
  instructions list
  instruction show <key>
  instruction set <key> --body-file <path> [--scope global|guild|channel]
                        [--scope-id <id>] [--required]
  instruction rm  <key> --scope <scope> [--scope-id <id>]

Rooms
  rooms
  room show     <guildId> <channelId>
  room use      <guildId> <channelId> <key,key,...>
  room sleep    <guildId> <channelId>
  room history  <guildId> <channelId>
```

Database migrations are versioned and reversible. A migration without a matching
`.down` file is rejected at load time rather than silently applied.

```
bun run migrate          # apply
bun run migrate:status   # what is applied
bun run migrate:down     # roll back the most recent
```

---

## 12. Configuration

| Key | Meaning |
| --- | --- |
| `DISCORD_TOKEN` | Bot token. Required. Never persisted or logged. |
| `DISCORD_APPLICATION_ID` | Bot application id. Required. |
| `ALLOWED_CHANNELS` | Channels Terry answers in. Required; empty refuses to start. |
| `OPERATORS` | Users permitted to command Terry. Required; empty refuses to start. |
| `ALLOWED_GUILDS` | Optional extra restriction. Empty means any server holding an allowlisted channel. |
| `PEER_AGENTS` | Bot ids permitted to converse. Empty refuses every bot. |
| `PEER_TURN_LIMIT` | Consecutive peer turns before stopping. Default 6. |
| `CLAUDE_BIN` | Runtime binary. Default `claude`. |
| `WORKSPACE_DIR` | Working directory handed to the runtime. Defaults to the current directory. |
| `DEFAULT_MODEL` / `DEFAULT_EFFORT` | Starting values; both settable per room from Discord. |
| `PERMISSION_MODE` / `PERMISSION_PROMPTS` | Runtime authority. Default `plan` + `none`. Not settable from chat. |
| `PEER_PERMISSION_MODE` | Runtime authority for a peer-authored turn. Default `plan`. |
| `DEFAULT_INSTRUCTION_KEYS` | Keys a room inherits when it declares none. |
| `INSTRUCTION_DRIFT_POLICY` | `hold` (default), `live`, or `off`. |
| `HISTORY_LIMIT` | Background context messages. Default 25. |
| `STREAMING` | Show a reply growing in place. Default on; `off` restores post-at-end. |
| `STREAM_EDIT_INTERVAL_MS` | Minimum gap between streaming edits. Default 1500. |
| `INTERRUPT_GRACE_MS` | How long an interrupted turn may take to stop before the process is killed. Default 3000. |
| `ATTENTION_WINDOW_SECONDS` | How long an awake room keeps listening after being spoken to. Default 90; 0 disables. |
| `RESUME_AWAKE_ON_RESTART` | Whether a restart leaves awake rooms awake. Default off. |
| `DATABASE_PATH` | Default `./data/terry.sqlite`. |
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error`. |
| `LOG_FILE` | File the service appends structured JSON to. Set by the launcher. |

The operator CLI also has `halt show` / `halt clear` for the sentinel described
in §14.

Malformed ids are rejected at startup with the offending value named, rather than
silently ignored.

---

## 13. Persistence

SQLite, at `DATABASE_PATH`.

| Table | Holds |
| --- | --- |
| `rooms` | One row per channel: state, conversation id, model, effort, activity, whether the conversation has been started |
| `session_history` | Retired conversation ids, with the reason — never deleted |
| `processed_events` | De-duplication keys for replayed Gateway events |
| `instructions` | The registry: key, scope, scope id, body, required |
| `room_instructions` | Which keys a room loads, and in what order |
| `instruction_pins` | What each conversation was minted with: body and sha256 |

---

## 14. Running as a service

Installed as a Windows scheduled task with an at-boot trigger, restart on failure
(999 attempts, one minute apart) and no execution time limit. `service/` holds
the installer, an elevated installer, and the launcher.

- The service **owns its log file** rather than being redirected into one, so the
  file handle's lifetime is tied to the process doing the logging.
- Opening the log **degrades rather than fails**: if a process left from an
  earlier run holds the day's file open, it falls back to a process-specific file
  and says so. Losing a log is worth tolerating; refusing to start over one is not.
- The launcher **refuses to start a second instance**, using an exclusively held
  lock file rather than process inspection — a task running under S4U lives in
  session 0, where an ordinary session cannot read a process's command line at all.
- Not elevated, the installer falls back to a logon trigger and says plainly what
  that costs.
- The launcher **reaps orphaned service processes** before starting. Stopping
  the task kills the launcher but not the `bun` child beneath it, so restarts
  were stacking copies; every message reached the runtime once per copy.
- A failure that can never succeed on retry — a rejected token, a missing
  intent, a refused configuration — writes a **halt sentinel** at
  `data/halt.json` and exits zero. The launcher declines to start while it
  exists and says why in `logs/run-error.log`. `bun run src/admin.ts halt clear`
  allows a start again.

---

## 15. What Terry deliberately does not do

Worth knowing before you plan around him.

- **No direct messages.** Guild channels only.
- **No slash commands.** Addressing is by mention, or by speaking inside an
  open attention window.
- **One workspace for all rooms.** `WORKSPACE_DIR` is global, so every room's
  conversation sees the same codebase.
- **No instruction editing from chat.** The registry is CLI-only, on purpose.
- **No permission changes from chat.** `PERMISSION_MODE` is an environment
  decision made on the machine.
- **Attachments are never opened.** They are described only.
- **No character budget on instructions.** A large registry entry goes in whole.
- **No mint record beyond the pins**, and no continuity journal — the runtime
  carries its own conversation history and is resumed by id.
- **Peers cannot collaborate on controls**, only converse.

---

## 16. Tests

Run with `bun test`, which reports the current count; a number written here
would be wrong within a week. The acceptance harness drives the
real controller against a real database with a stand-in for Discord's socket, so
everything except the transport is the shipping code. A stub runtime enforces the
same create-versus-resume rules as the real CLI, so a restart bug cannot pass.

`docs/acceptance.md` records the ten live checks and the five defects running them
found.
