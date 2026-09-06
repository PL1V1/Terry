# Running Terry as a service

Terry is a long-running process. It needs a supervisor that starts it at boot and
restarts it if it dies.

## Windows (Task Scheduler)

Windows has no native supervisor for a plain executable, so the scheduled task
does the job. `service/install-service.ps1` registers one with start-at-boot and
restart-on-failure.

```powershell
cd C:\Users\Paul\terry\service
.\install-service.ps1
```

It refuses to install if `.env` is missing, so the service cannot be registered
in a state where it would only fail at boot.

What the task does:

| Setting | Value | Why |
| --- | --- | --- |
| Trigger | At startup, or at logon | See "Elevation" below |
| Restart interval | 1 minute | Retries a crash without hammering |
| Restart count | 999 | A transient outage must not permanently stop it |
| Execution time limit | none | It is meant to run forever |
| Multiple instances | Ignore new | Two clients would fight over presence |
| Logon type | S4U | Runs without a stored password |
| Run level | Limited | No elevation. It does not need it |

Managing it:

```powershell
Start-ScheduledTask   -TaskName Terry
Stop-ScheduledTask    -TaskName Terry
Get-ScheduledTaskInfo -TaskName Terry     # last result, last/next run time
Unregister-ScheduledTask -TaskName Terry -Confirm:$false
```

`Get-ScheduledTaskInfo` gives you `LastTaskResult` (0 is clean) and
`NumberOfMissedRuns`.

### Logs

Task Scheduler captures neither stdout nor stderr, so the task runs
`service/run.ps1` rather than bun directly. That wrapper:

- sets the working directory, which is how bun finds `.env`
- appends stdout and stderr, in order, to `logs/terry-<date>.log`
- prunes logs older than 14 days (`-KeepDays` to change)

The log is UTF-8. This matters more than it sounds: PowerShell's own redirection
operators write UTF-16 in Windows PowerShell, which turns a file full of JSON
into something `grep`, `tail` and `Select-String` cannot read. The wrapper
redirects through `cmd` so the service's bytes reach the file untouched.

```powershell
Get-Content -Wait -Tail 20 .logs	erry-2026-09-06.log
Select-String -Path .logs*.log -Pattern '"level":"(warn|error)"'
```

### Elevation

An at-boot trigger has to run before anyone logs in, so registering one requires
administrator rights. The installer tries that first and falls back rather than
failing:

| Shell | Trigger | Consequence |
| --- | --- | --- |
| Elevated | At startup | Runs after a reboot with nobody logged in |
| Not elevated | At logon | **Does not run after a reboot until someone logs in** |

The script says which mode it used. For a genuinely unattended service, re-run it
from an elevated shell; `-PerUser` skips the elevated attempt entirely.

## Behaviour across restarts

A restart is not a fresh start:

- Each room's conversation mapping, model, effort and activity text are read back
  from the database.
- Every room comes back **asleep** by default, and the log names which rooms were
  put back to sleep. Waking one resumes its conversation by id.
- Set `RESUME_AWAKE_ON_RESTART=true` to have awake rooms stay awake instead.
  That is a deliberate choice: without it, an unattended reboot cannot resume
  work on its own.
- Retired conversations stay in `session_history` and remain resumable by id.

If a mapped conversation cannot be resumed, the room reports the failure in the
channel rather than silently starting a blank one and discarding context.

## Health

- Presence is the quickest signal: idle means asleep, online means awake, do not
  disturb means working, invisible means the Gateway is down.
- `@Terry ping` confirms the service is processing messages and reports the
  runtime version.
- `@Terry status` shows the conversation id, model, effort, permission mode and
  queue depth for that room.

## Linux (systemd)

Not the target platform here, but the shape is the same:

```ini
[Unit]
Description=Terry
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/terry
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Keep `.env` at `/opt/terry/.env` with `chmod 600`.
