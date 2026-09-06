# Terry

A persistent Discord control room for a coding-agent session.

Terry turns a private Discord channel into the front end for a long-running
coding conversation. You can leave the terminal, wake it from your phone, talk
about the work, change its model and effort, and see results in the same
channel. It survives restarts: the conversation is keyed to the channel and
resumed by id.

Terry starts **asleep** and does nothing until an authorised operator wakes it.

## What it is made of

| Concern | Where |
| --- | --- |
| Discord transport (Gateway + REST) | `src/discord/` |
| Command and session control | `src/controller/` |
| Coding-runtime adapter | `src/runtime/` |
| Database and migrations | `src/db/` |
| Operator CLI | `src/admin.ts` |

Four responsibilities, kept apart. The runtime owns the conversation's content;
Terry owns the mapping from channel to conversation, and the preferences.

## Requirements

- [Bun](https://bun.sh) 1.4 or later
- A coding runtime with a headless streaming interface. Built and tested against
  **Claude Code 2.1.263**, which provides everything the adapter needs:
  `--print`, `--input-format stream-json`, `--output-format stream-json`,
  `--session-id`, `--resume`, `--fork-session`, `--model`, `--effort`,
  `--permission-mode`.
- A Discord bot application of its own.

Terry checks the runtime's real capabilities at startup and refuses to run if the
flags it needs are missing. It never hard-codes a model or effort list — those
are read from the installed runtime's own help, so the menu cannot drift out of
step with reality.

## Install

```sh
git clone <your-remote> terry
cd terry
bun install
cp .env.example .env
```

Fill in `.env`. See that file for what each setting does; the ones you cannot
skip are `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, `ALLOWED_CHANNELS` and
`OPERATORS`.

### Creating the Discord bot

1. https://discord.com/developers/applications → **New Application**.
2. **Bot** → **Reset Token** → copy it into `DISCORD_TOKEN`. It is shown once.
3. On the same page enable the **MESSAGE CONTENT** privileged intent. Without it
   Discord delivers empty message text and Terry cannot read anything.
4. **OAuth2 → URL Generator** → scope `bot`, permissions **Send Messages**,
   **Read Message History**, **Add Reactions**. Invite it to your server.

Use a **separate** bot application from any other bot you run. Two clients on one
token fight over the presence indicator.

### Database

```sh
bun run migrate          # apply
bun run migrate:status   # what is applied
bun run migrate:down     # roll back the most recent
```

Migrations are versioned and reversible; a migration without a matching `.down`
file is rejected at load time rather than silently applied.

### Run

```sh
bun run start
```

## Commands

Address Terry with a direct mention. Everything below is handled by the service
itself, and **all of it works while asleep**.

| Command | Effect |
| --- | --- |
| `@Terry menu` | The command list |
| `@Terry wakeup` | Start or resume this room's conversation |
| `@Terry sleep` | Interrupt work, drop pending input, stop taking chat |
| `@Terry stop` | Interrupt the current task, stay awake |
| `@Terry status` | Readiness, conversation id, model, effort, queue depth |
| `@Terry ping` | Connection check |
| `@Terry list models` | Models the runtime advertises |
| `@Terry model <id>` | Choose a model |
| `@Terry effort` | Effort levels this runtime supports |
| `@Terry effort <level>` | Choose one |
| `@Terry instructions` | Which instructions this conversation is pinned to |
| `@Terry accept instructions` | Adopt the current versions from the registry |
| `@Terry new session` | Replace this room's conversation (asks first) |
| `@Terry new session confirm` | Confirm the replacement |
| `@Terry activity <text>` | Custom presence text |
| `@Terry activity auto` | Automatic presence text |

Anything else addressed to Terry while awake is a turn in the conversation.
While asleep, ordinary chat is ignored entirely — only the commands answer.

Model and effort changes apply to the **next** turn. Work already running is
never silently switched underneath you. Changing either restarts the runtime
process and resumes the same conversation by id, so no context is lost.

## Presence

| State | Shown as |
| --- | --- |
| asleep | idle |
| awake | online |
| working | do not disturb |
| disconnected | invisible |

One component owns presence. Updates are coalesced and rate-limited so a busy
room cannot flood the socket, and presence is re-asserted after every reconnect.

## Instructions (the registry)

Terry has no built-in personality or house rules. What it is like comes from a
database-backed registry, not from files in this repo.

Instructions are keyed and scoped, with precedence `global < guild < channel` —
the most specific row for a key wins. Rooms declare which keys they load, in
order. They are read **on every turn**, so an edit is visible on the next message
with no restart.

```sh
# Store an instruction
bun run src/admin.ts instruction set house-rules --body-file ./rules.md

# Scope one to a single channel
bun run src/admin.ts instruction set voice --scope channel --scope-id 123... \
    --body-file ./voice.md

# Tell a room which keys to load, in order
bun run src/admin.ts room use <guildId> <channelId> house-rules,voice

# Inspect
bun run src/admin.ts instructions list
bun run src/admin.ts room show <guildId> <channelId>
```

A key marked `--required` that resolves to nothing **stops the turn** with a
visible error naming the key. It does not quietly run without it.

The registry ships empty. Nothing is seeded.

### Pinned instructions and drift

Instructions resolve live on every turn, which is right when you are editing one
and wrong for a conversation already running under it: the edit rewrites that
conversation's rules mid-thread, and the conversation cannot tell you, because
from its side the rules were always these ones.

So a conversation is **pinned**. On its first turn Terry mints what it was told -
each resolved body and its sha256, frozen against that conversation's id. Every
later turn compares the registry against the pin, and a difference is **drift**:
reported, and adopted only when you say so.

```sh
INSTRUCTION_DRIFT_POLICY=hold   # default
```

| Policy | What a drifted instruction does |
| --- | --- |
| `hold` | Loads the version the conversation started with, and says which keys moved. The conversation does not shift underneath itself. |
| `live` | Loads the new version, and says that it did. |
| `off` | No pinning at all; resolves live every turn, as it worked before this existed. |

```
@Terry instructions          which keys this conversation is pinned to, and their hashes
@Terry accept instructions   adopt the current versions from the registry
```

Each distinct drift state is reported **once**. Repeating it every turn teaches
the reader to skip it, which is the same as not saying it — but editing the same
key a second time is a new state, and is reported again.

Some deliberate edges:

- A key **added** to the room after minting is loaded live, not called drift.
  There is no earlier version for it to have drifted from.
- A key **deleted** from the registry mid-conversation keeps its pinned copy
  under `hold`. Under `live` a required one becomes a missing-instruction error.
- `new session` mints a fresh set. The old pins stay attached to the retired
  conversation they describe, which is what makes them worth keeping.
- Accepting is a room control, not a registry edit: it authors nothing, it only
  chooses which version a running conversation is held to. Peers cannot run it.

## Ambient listening

Terry answers a message that addresses him directly. He will also listen to what
follows, so a conversation does not have to be punctuated with mentions.

Mention him once and an **attention window** opens. Inside it, un-mentioned
messages are handed to the runtime, which decides from conversational context
whether they were meant for him — and answers with **silence** when they were
not. Every reply he gives re-opens the window, so an exchange keeps running; it
closes when nobody has spoken to him for `ATTENTION_WINDOW_SECONDS` (default 90).

```sh
ATTENTION_WINDOW_SECONDS=90   # 0 disables it: mention him every time
```

`@Terry status` reports whether he is currently listening and how long is left.

Why 90 seconds rather than 20: a turn can take half a minute to come back, and
then somebody has to read it and type. A window measured from the mention would
shut before the reply it was opened for had arrived.

**What it costs.** A message outside an open window never reaches the runtime, so
idle chatter is free. A message inside one **does** cost a turn, because judging
it is the runtime's job. The window is the budget.

**What is never overheard:**

- **Peers.** A peer must always address him directly. Two agents reading each
  other's ambient chatter would have nothing but the turn budget between them
  and a conversation nobody asked for.
- **A sleeping room.** Ambient listening only applies while awake.
- **Anyone who is not an operator**, exactly as before.

An overheard message that arrives while he is working queues in **silence**.
Announcing it would be a reply to something nobody established was addressed to
him, which is the one thing ambient listening must not do.

## Talking to another agent

Terry can hold a conversation with another bot in the same channel — your mate's
agent, say. Name its **bot user id** in `PEER_AGENTS`:

```sh
PEER_AGENTS=000000000000000000   # your peer bot's user id
PEER_TURN_LIMIT=6
```

Two things have to be true for this to work at all, and both are deliberate.

**Terry must be able to address the peer back.** Every ordinary message Terry
sends suppresses mentions, so an answer cannot ping whoever the runtime happened
to name. A reply to a peer is the one exception: it is prefixed with a real
mention and permitted to ping. Without that, a mention-gated peer never learns it
was answered and the conversation ends after one turn.

**The exchange is budgeted.** Two agents that both answer when mentioned will
answer each other for as long as they are allowed to, and the cost lands on two
people who are asleep. `PEER_TURN_LIMIT` (default 6) caps how many turns in a row
a peer may take. On the last one Terry says so, once, addressed to nobody — a
mention there would restart the exchange it just stopped. **Any operator message
refills the budget**, so you restart the conversation simply by joining in.

What a peer cannot do:

- **Use the commands.** No `sleep`, `stop`, `model`, `effort` or `new session`.
  A peer holds a conversation; it does not hold the controls. Attempts are logged
  and not answered — replying to a bot to say no is one more message it may
  answer.
- **Wake a sleeping room.** A human opens the room before two agents can use it.
- **Speak through a webhook.** A webhook carries no identity worth allowlisting,
  so it is refused even wearing a peer's id.

Peers are not operators and the two lists are separate. Adding a peer does not
grant it anything an operator has.

## Security posture

Discord is a transport, not an authority. Three independent gates must all pass
before a message is acted on: the channel must be allowlisted, the author must
appear on an allowlist, and a webhook is never task input at all.

Two allowlists admit an author, and they grant different things. An **operator**
is a human in `OPERATORS` who may command the service. A **peer** is another bot
named in `PEER_AGENTS` which may hold a conversation but may not touch the
controls. Being a bot is not itself a credential in either direction: an unnamed
bot is refused, and with `PEER_AGENTS` empty — the default — every bot is
refused, which is the original behaviour.

- **The service refuses to start** with an empty channel or operator allowlist.
- **Discord input cannot widen the runtime's authority.** `PERMISSION_MODE` and
  `PERMISSION_PROMPTS` are read from the environment on the machine and are not
  settable from chat. The default (`plan` + `none`) can read and reason but
  cannot write, run or deploy; anything needing approval fails clearly rather
  than being granted.
- **Instructions live in the database**, not in chat. Terry cannot be
  redefined by talking to it.
- **The token never reaches a log line or an error message.** It is registered as
  a secret at startup and redacted from all structured output; API failures
  report status and path, never response bodies.
- **Replayed Gateway events are de-duplicated**, so a RESUME cannot run the same
  work twice.
- **Channel history is supplied as labelled background context**, explicitly not
  as instructions to replay. Attachments are described, never claimed as
  inspected — a URL is not proof an image was looked at.

## Resilience

- Heartbeat with acknowledgement tracking; a missed ack drops the zombie
  connection and resumes.
- RESUME on reconnect, with re-identify when the session cannot be resumed.
- Exponential backoff with jitter, capped at 30s.
- Authentication and intent failures (close codes 4004, 4010–4014) stop rather
  than retrying a request that can never succeed.
- Rate limits (429) are respected with the server's own `retry_after`; 5xx
  responses retry with backoff.
- A restart returns every room to **asleep** and says so in the log, keeping the
  conversation mapping and preferences. Waking a room resumes it by id, so
  nothing is lost — but a reboot never silently resumes work nobody asked for.
  Set `RESUME_AWAKE_ON_RESTART=true` if you would rather it came back awake.

## Tests

```sh
bun test
bun run typecheck
```

Covers the command parser, migrations up and down, room isolation, session
retirement, event de-duplication, instruction scope precedence, message chunking,
Gateway reconnection policy, configuration validation, the authorisation gates,
capability parsing, history rendering and secret redaction.

See `docs/acceptance.md` for the end-to-end checks to run in a test channel.

## Service installation

See `docs/service.md` for running Terry as a Windows service that restarts on
failure.
