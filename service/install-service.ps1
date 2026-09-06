<#
.SYNOPSIS
  Installs Terry as a Windows scheduled task that starts at boot and restarts on
  failure.

.DESCRIPTION
  Windows has no native supervisor for a plain executable, so this registers a
  scheduled task with restart-on-failure and start-at-boot behaviour. The task
  runs as the current user by default so the coding runtime keeps that user's
  credentials and configuration.

.PARAMETER ProjectDir
  Path to the Terry checkout. Defaults to the parent of this script.

.PARAMETER BunPath
  Path to bun.exe. Defaults to whatever is on PATH.

.PARAMETER TaskName
  Scheduled task name. Defaults to "Terry".

.EXAMPLE
  .\install-service.ps1
  .\install-service.ps1 -TaskName TerryStaging
#>
[CmdletBinding()]
param(
  [string]$ProjectDir,
  [string]$BunPath,
  [string]$TaskName = "Terry",
  # Skip the elevated at-boot attempt and register a logon task directly.
  [switch]$PerUser
)

$ErrorActionPreference = "Stop"

# $PSScriptRoot is not reliably populated in a param() default under Windows
# PowerShell, so the script's own location is resolved here instead.
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $scriptDir) { throw "Could not determine this script's directory" }
if (-not $ProjectDir) { $ProjectDir = Split-Path -Parent $scriptDir }

if (-not (Test-Path $ProjectDir)) { throw "Project directory not found: $ProjectDir" }
if (-not (Test-Path (Join-Path $ProjectDir "src\index.ts"))) {
  throw "$ProjectDir does not look like a Terry checkout (no src\index.ts)"
}
if (-not (Test-Path (Join-Path $ProjectDir ".env"))) {
  throw "No .env in $ProjectDir. Copy .env.example to .env and fill it in first."
}

if (-not $BunPath) {
  $found = Get-Command bun -ErrorAction SilentlyContinue
  if (-not $found) { throw "bun was not found on PATH. Pass -BunPath explicitly." }
  $BunPath = $found.Source
}

$logDir = Join-Path $ProjectDir "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

Write-Host "Project : $ProjectDir"
Write-Host "Bun     : $BunPath"
Write-Host "Task    : $TaskName"

# Run through run.ps1 rather than bun directly: Task Scheduler captures neither
# stdout nor stderr, and a service with nowhere to report is one you cannot
# diagnose. The wrapper sets the working directory, which is how bun finds .env,
# and appends everything to logs\terry-<date>.log.
$runner = Join-Path $scriptDir "run.ps1"
if (-not (Test-Path $runner)) { throw "run.ps1 was not found next to this script" }

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runner`"" `
  -WorkingDirectory $ProjectDir

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -RestartCount 999 `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -MultipleInstances IgnoreNew

$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Replacing the existing '$TaskName' task."
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# An at-boot trigger has to run before anyone logs in, so registering one needs
# administrator rights. Rather than failing, fall back to starting at logon,
# which a user can register for themselves - and say plainly what that costs.
$mode = $null
if (-not $PerUser) {
  try {
    Register-ScheduledTask -TaskName $TaskName `
      -Action $action `
      -Trigger (New-ScheduledTaskTrigger -AtStartup) `
      -Settings $settings `
      -Principal (New-ScheduledTaskPrincipal -UserId $userId -LogonType S4U -RunLevel Limited) `
      -Description "Terry - persistent Discord control room for a coding-agent session" | Out-Null
    $mode = "boot"
  } catch [Microsoft.Management.Infrastructure.CimException] {
    Write-Host ""
    Write-Host "Not elevated, so an at-boot task cannot be registered."
    Write-Host "Falling back to starting at logon instead."
    Write-Host ""
  }
}

if (-not $mode) {
  Register-ScheduledTask -TaskName $TaskName `
    -Action $action `
    -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $userId) `
    -Settings $settings `
    -Principal (New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited) `
    -Description "Terry - persistent Discord control room for a coding-agent session" | Out-Null
  $mode = "logon"
}

Write-Host ""
if ($mode -eq "boot") {
  Write-Host "Installed. Starts at boot, before login, and restarts on failure."
} else {
  Write-Host "Installed. Starts when $userId logs in, and restarts on failure."
  Write-Host "It will NOT run after a reboot until someone logs in. For a truly"
  Write-Host "unattended service, re-run this script from an elevated shell."
}
Write-Host ""
Write-Host "Useful commands:"
Write-Host "  Start-ScheduledTask   -TaskName $TaskName"
Write-Host "  Stop-ScheduledTask    -TaskName $TaskName"
Write-Host "  Get-ScheduledTaskInfo -TaskName $TaskName"
Write-Host "  Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
Write-Host ""
Write-Host "Start it now with Start-ScheduledTask if you do not want to wait."
Write-Host "Logs    : $(Join-Path $ProjectDir 'logs')"
