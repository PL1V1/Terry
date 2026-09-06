# Acceptance checks

The ten checks from the brief, and where each one currently stands.

Status key:

- **harnessed** — demonstrated by `bun test` against the real controller, the
  real database and a stub runtime that speaks the same protocol as the CLI
- **proven** — demonstrated against the real coding runtime
- **needs channel** — genuinely about Discord, so it needs a bot token and a
  live test channel

The harness (`test/acceptance.test.ts`, `test/acceptance-turns.test.ts`) drives
the shipping `RoomController` with a stand-in for Discord's socket. Only the
transport and, where noted, the runtime are substituted; the state machine, the
command layer, the registry and the persistence are the real code.

Run everything in a **test channel** before pointing Terry at a real control
room. Set Developer Mode on in Discord (Settings → Advanced) to copy ids.

---

## 1. A human wake-up causes a real runtime reply

**Status: PASSED live**

Demonstrated in a test channel on 2026-09-06. `wakeup` woke the room, a
following message ran a turn, and the runtime's reply was delivered back to
Discord. Service log:

    gateway ready          botId=1546074708749979718
    starting coding runtime  --permission-mode plan --permission-prompts none

Also harnessed, and proven separately against the real CLI: the adapter starts a
streaming session and returns its result.

To reproduce:

```
@Terry wakeup
@Terry what files are in the working directory?
```

## 2. An authorised harmless tool operation runs and reports observed results

**Status: PASSED live — including the refusal**

Demonstrated 2026-09-06. Asked to create a file, the runtime produced a plan and
**did not write**. Verified afterwards: no `scratch.txt` in the workspace and
`git status` clean. The request to widen its own permissions arrived back up the
chat pipe and was refused there too — authority lives in `.env`, not in a
message.

Known nuance, recorded so nobody over-claims: plan mode is not a hermetic
read-only jail. It wrote its plan to the runtime's own config directory
(`~/.claude/plans/`), outside `WORKSPACE_DIR`. It cannot touch the codebase; it
does keep notes of its own.

```
@Terry list the files in the working directory and tell me how many there are
```

To reproduce. Expect a count that matches reality, then check the boundary:

```
@Terry create a file called scratch.txt
```

With the default `PERMISSION_MODE=plan` expect a refusal or failure and **no
file created**. That is the permission boundary doing its job.

## 3. Sleep ignores ordinary chat; menu and status still work

**Status: PASSED live**

Demonstrated 2026-09-06:

    09:37:15  sleep          -> "Asleep. I will ignore ordinary chat..."
    09:37:26  "you there?"   -> no reply at all
    09:37:35  menu           -> full command list

Service log for the middle message: `ignoring chat while asleep`. The silence was
a decision, not a failure.

Harnessed: a fresh room starts asleep; ordinary chat while asleep produces
**no messages at all**; `menu`, `status` and `ping` still answer; chat is ignored
again after sleeping.

```
@Terry sleep
@Terry are you there?          -> silence
@Terry menu                    -> the command list
@Terry status                  -> room asleep
```

In the channel, also confirm presence goes idle.

## 4. Stop interrupts a real task and pending input is handled predictably

**Status: PASSED live — and it found a bug**

Demonstrated 2026-09-06:

    09:38:26  a long task started
    09:38:31  second message -> "Queued — I am working. 1 message(s) waiting."
    09:38:47  stop           -> "Task interrupted. Still awake... Cleared 1 queued"

**The bug.** One second after reporting the interruption, the killed task's
partial answer was delivered anyway. The outcome branches tested `text` before
`interrupted`, so a task that had already started speaking still got its
half-finished output posted — directly contradicting the message the operator had
just read.

The harness had missed it because the stub runtime slept before producing any
output, so there was never a partial answer to leak. The stub now has a
`__PARTIAL__` mode that speaks and then hangs. Both new tests were confirmed to
fail against the old branch order and pass against the new one.

Harnessed against a running task:

- a message arriving mid-task is **queued**, not run concurrently, and says how
  many are waiting
- `stop` interrupts the task, reports how many queued messages it cleared, and
  leaves the room **awake**
- `stop` with nothing running says so plainly
- `sleep` during work interrupts it and drops the queue
- a runtime that dies mid-turn is reported, and the conversation is kept

## 5. Model and effort come from real capabilities, reject invalid values, affect later turns and survive restart

**Status: PASSED live** (rejection path)

Demonstrated 2026-09-06 in the test channel:

    @Terry effort banana
    -> "banana is not a supported effort level. The runtime accepts:
        low, medium, high, xhigh, max."

The list came from the installed runtime's own help, not from anything typed
into this repo.

Harnessed: effort lists exactly what the runtime documents; `effort banana` is
rejected with the real list and stores nothing; a valid value is stored and
announced as applying to the next turn; an unrecognised model is stored but
flagged honestly; `list models` says plainly that it is not a complete
catalogue.

Also harnessed at the process level: a chosen effort is **observed arriving at
the runtime process** on the next turn, not merely written to the database.

```
@Terry effort           -> low, medium, high, xhigh, max
@Terry effort banana    -> rejected, with the real list
@Terry effort high      -> accepted, "applies to the next turn"
```

## 6. A restart preserves the mapping and settings; two channels stay isolated

**Status: PASSED live, twice** (isolation still harnessed only)

Confirmed again from the user's side after three service restarts: `wakeup`
replied "Resuming this room's conversation 4aa58348-…" — the same id the room was
given before any of them.

Demonstrated 2026-09-06 against the running service. The room was awake with a
mapped conversation; the service was stopped and restarted:

    rooms returned to asleep after restart  count=1
    DB state : asleep      presence: asleep      mapping: preserved

This check found a real defect. The service originally left rooms awake across a
restart while presence reported asleep, so the member list and the database
disagreed. The brief settles it — a restart returns to asleep unless another
policy is deliberately chosen — so startup now sleeps every awake room, keeps the
mapping and preferences, and names the rooms it slept in the log.
`RESUME_AWAKE_ON_RESTART=true` opts back in.

Proven: a conversation was given a codeword, the runtime process was killed
outright, and a fresh process resuming the same session id recalled it.

Harnessed:

- consecutive turns **share one runtime process** (asserted by process identity)
- changing a setting spawns a new process and **resumes** into the same
  conversation rather than starting a blank one
- rebuilding the controller from the same database keeps the conversation id and
  the settings
- two channels in one guild keep separate sessions, models and states; the same
  channel id under a different guild is a different room

## 7. Instruction updates are visible on the next turn, with no copied file catalogue

**Status: harnessed**

Harnessed: scope precedence (`global < guild < channel`); a narrower override
does not leak into another channel; ordering is preserved; a **missing required
key refuses the turn and names it**; a missing optional key does not block;
registry edits take effect with no restart.

```sh
bun run src/admin.ts instruction set house-rules --body-file ./rules.md
bun run src/admin.ts room use <guildId> <channelId> house-rules
```

Then ask something the rule affects, edit `rules.md`, re-run `instruction set`,
and ask again — the behaviour must change on the next turn.

## 8. Presence tracks state without excessive updates or competing writers

**Status: partly proven live, visual check still needs eyes**

Observed live: presence writes are coalesced. Consecutive updates during startup
landed 5.0s apart (09:12:10.627 connecting, 09:12:15.629 asleep), which is the
trailing interval, not one write per event. One component owns presence, and it
now agrees with the database rather than contradicting it.

Harnessed: waking and sleeping move the reported state; custom activity text is
applied and `activity auto` resets it.

Needs channel: watch the member list through asleep (idle) → awake (online) →
working (dnd) → asleep (idle). Updates are coalesced on a trailing 5s timer and
identical states dropped, so expect a handful of changes, not one per event.

## 9. Fresh-session confirmation creates a separate conversation without deleting the old one

**Status: PASSED live, in full**

Demonstrated 2026-09-06:

    new session confirm  (unprompted) -> "Nothing to confirm. Run new session first."
    new session                       -> warned, named 4aa58348-…, changed nothing
    new session confirm               -> "New conversation d1f6ae91-…"
    status                            -> reports the new conversation

The old conversation is in `session_history`, retired at 09:36:42 with reason
"new session requested", and remains resumable by id.

Harnessed: the ask warns, names the current conversation and **changes nothing**;
confirming replaces it and files the old id in history; the new conversation
starts genuinely fresh rather than resuming; confirming without asking first is
refused; any other command cancels a pending confirmation.

```sh
bun run src/admin.ts room history <guildId> <channelId>   # the old one is still there
```

## 10. Network errors, duplicate events and delivery failures recover clearly

**Status: partly harnessed, failure injection needs channel**

Harnessed: replayed message ids are rejected and new ones accepted; pruning
removes only old keys; fatal close codes (4004, 4010–4014) are distinguished
from transient ones; non-resumable codes force a re-identify; backoff grows and
stays capped at 30s; a delivery failure is logged rather than crashing the room.

Needs channel:

- Disconnect the network for a minute. Expect presence invisible, backoff
  attempts in the log, then RESUME and presence restored — with no duplicated
  replies.
- Kill the runtime mid-task (`taskkill /IM claude.exe`). Expect a clear message
  that it exited, the conversation kept, and the next message resuming.
- Revoke the bot token. Expect close code 4004, one fatal log line, and **no**
  reconnect loop.

---

## Summary

| # | Check | Status |
| --- | --- | --- |
| 1 | Wake-up produces a real reply | **PASSED live** |
| 2 | Authorised tool operation | **PASSED live**, refusal included |
| 3 | Sleep ignores chat | **PASSED live** |
| 4 | Stop interrupts, queue predictable | **PASSED live**; found a bug |
| 5 | Model and effort from real capabilities | **PASSED live** (rejection) |
| 6 | Restart preserves; channels isolated | **PASSED live** x2; isolation harnessed |
| 7 | Instructions live, required enforced | harnessed |
| 8 | Presence tracks state | coalescing proven live; visual pending |
| 9 | New session confirmed and preserved | **PASSED live**, in full |
| 10 | Errors and duplicates recover | partly harnessed |

## Before a real control room

- [ ] The remaining channel checks pass in a test server
- [ ] `ALLOWED_CHANNELS` and `OPERATORS` contain only intended ids
- [ ] `PERMISSION_MODE` is what you actually intend to grant
- [ ] `.env` is not committed (`git status` is clean)
- [ ] The token is not in any chat log; reset it if it ever was
- [ ] The service starts at boot and restarts on failure (`docs/service.md`)
- [ ] The instruction registry contains your instructions, not placeholders
