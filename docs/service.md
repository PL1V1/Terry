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
| Trigger | At startup | Comes back after a reboot without anyone logging in |
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

Terry writes structured JSON lines to stdout, and warnings and errors to stderr.
Task Scheduler does not capture either, so redirect them if you want history.
Point the task at a wrapper:

```powershell
# service\run.ps1
Set-Location $PSScriptRoot\..
$stamp = Get-Date -Format "yyyy-MM-dd"
& bun run src\index.ts *>> "logs\terry-$stamp.log"
```

Then install with `-BunPath (Get-Command powershell).Source` and adjust the
action arguments, or simply run `run.ps1` from the task action.

### Elevation

The install script does not require an administrator prompt for a task that runs
as the current user. If you change `-RunLevel` or install for a different
account, you will need an elevated shell.

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
