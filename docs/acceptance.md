# Acceptance checks

Run every one of these in a **test channel** before pointing Terry at a real
control room.

Status key:

- **automated** — covered by `bun test`, no channel needed
- **proven** — demonstrated end to end against the real runtime
- **needs channel** — requires a bot token and a live test channel

Set Developer Mode on in Discord (Settings → Advanced) to copy channel and user
ids.

---

## 1. A human wake-up causes a real runtime reply

**Status: needs channel** (the runtime half is **proven** — see below)

```
@Terry wakeup
@Terry what files are in the working directory?
```

Expect: an acknowledgement of waking, presence goes online, then dnd while it
works, then a real answer describing the actual directory.

The runtime round trip itself is already demonstrated: the adapter starts a
streaming session, submits a turn and receives a result. What this check adds is
the Discord leg either side of it.

## 2. An authorised harmless tool operation runs and reports observed results

**Status: needs channel**

```
@Terry list the files in the working directory and tell me how many there are
```

Expect: a count that matches reality. With the default `PERMISSION_MODE=plan`
reading is permitted and writing is not — so also try:

```
@Terry create a file called scratch.txt
```

Expect: a clear refusal or failure, **not** a created file. That is the
permission boundary working.

## 3. Sleep ignores ordinary chat; menu and status still work

**Status: needs channel**

```
@Terry sleep
@Terry are you there?          -> no response at all
@Terry menu                    -> the command list
@Terry status                  -> room asleep
@Terry ping                    -> pong
```

Expect: presence idle. The middle message must produce **silence**, not a "I am
asleep" reply — the brief asks for ordinary chat to be ignored.

## 4. Stop interrupts a real task and pending input is handled predictably

**Status: needs channel**

```
@Terry wakeup
@Terry count slowly from 1 to 200, one line each
@Terry another message while that runs     -> "Queued — I am working. 1 waiting."
@Terry stop
```

Expect: the task stops, the room stays **awake**, and the reply states how many
queued messages were cleared. Then confirm the conversation survived:

```
@Terry what was I just asking you to count?
```

## 5. Model and effort come from real capabilities, reject invalid values, affect later turns and survive restart

**Status: partly automated, rest needs channel**

```
@Terry list models      -> what the runtime advertises, or an honest "cannot list"
@Terry effort           -> low, medium, high, xhigh, max
@Terry effort banana    -> rejected, with the real list
@Terry effort high      -> accepted, "applies to the next turn"
@Terry status           -> effort high
```

Restart the service, then `@Terry status` again — effort must still be high.

Automated: capability parsing, the honest-null path when a runtime documents
nothing, effort validation, and preference persistence.

## 6. A restart preserves the mapping and settings; two channels stay isolated

**Status: partly proven, rest needs channel**

**Proven:** a conversation was given a codeword, the runtime process was killed
outright, and a fresh process resuming the same session id recalled it.

**Automated:** two channels in one guild keep separate sessions, models and
states; the same channel id under a different guild is a different room.

**Needs channel:** wake two channels, set a different model in each, restart the
service, and check `@Terry status` in both.

## 7. Instruction updates are visible on the next turn, with no copied file catalogue

**Status: partly automated, rest needs channel**

```sh
bun run src/admin.ts instruction set house-rules --body-file ./rules.md
bun run src/admin.ts room use <guildId> <channelId> house-rules
```

Then in the channel, without restarting anything, ask something the rule
affects. Edit `rules.md`, re-run `instruction set`, ask again — the behaviour
must change on the next turn.

Also check the failure path:

```sh
bun run src/admin.ts instruction set must-have --body-file ./x.md --required
bun run src/admin.ts instruction rm must-have --scope global
bun run src/admin.ts room use <guildId> <channelId> must-have
```

Expect the next turn to be **refused**, naming the missing key.

Automated: scope precedence (`global < guild < channel`), per-channel isolation
of overrides, ordering, and the required flag.

## 8. Presence tracks state without excessive updates or competing writers

**Status: needs channel**

Watch the member list through: asleep (idle) → wakeup (online) → working (dnd) →
finished (online) → sleep (idle). Then:

```
@Terry activity on the tools
```

Expect the custom text, and `activity auto` to restore automatic text.

Updates are coalesced on a trailing 5s timer and identical states are dropped, so
a busy room should produce a handful of changes, not one per event. Only the
service writes presence.

## 9. Fresh-session confirmation creates a separate conversation without deleting the old one

**Status: partly automated, rest needs channel**

```
@Terry new session          -> warns, names the current conversation, asks
@Terry status               -> unchanged; nothing has happened yet
@Terry new session confirm  -> new id, states the old one is preserved
```

Then confirm the old conversation still exists:

```sh
bun run src/admin.ts room history <guildId> <channelId>
```

Also check that a bare `new session confirm` with no preceding ask is refused,
and that any other command cancels a pending confirmation.

Automated: retirement files the old id and clears the mapping; retiring with no
session is a no-op.

## 10. Network errors, duplicate events and delivery failures recover clearly

**Status: partly automated, rest needs channel**

**Automated:** de-duplication rejects a replayed message id and accepts a new
one; pruning removes only old keys; fatal close codes (4004, 4010–4014) are
distinguished from transient ones; non-resumable codes force a re-identify;
backoff grows and stays capped at 30s.

**Needs channel:**

- Disconnect the network for a minute. Expect presence invisible, backoff
  reconnect attempts in the log, then RESUME and presence restored — without
  duplicated replies.
- Kill the runtime process mid-task (`taskkill /IM claude.exe`). Expect a clear
  message that it exited, the conversation kept, and the next message resuming.
- Revoke the bot token. Expect close code 4004, a single fatal log line, and
  **no** reconnect loop.

---

## Before a real control room

- [ ] All ten checks pass in a test channel
- [ ] `ALLOWED_CHANNELS` and `OPERATORS` contain only intended ids
- [ ] `PERMISSION_MODE` is what you actually intend to grant
- [ ] `.env` is not committed (`git status` is clean)
- [ ] The token is not in any chat log; reset it if it ever was
- [ ] The service starts at boot and restarts on failure (`docs/service.md`)
- [ ] The instruction registry contains your instructions, not placeholders
