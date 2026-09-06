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
  [string]$ProjectDir = (Split-Path -Parent $PSScriptRoot),
  [string]$BunPath,
  [string]$TaskName = "Terry"
)

$ErrorActionPreference = "Stop"

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

# Bun loads .env from the working directory, so the working directory is the
# whole configuration story. Keep it pointed at the checkout.
$action = New-ScheduledTaskAction -Execute $BunPath `
  -Argument "run src\index.ts" `
  -WorkingDirectory $ProjectDir

$trigger = New-ScheduledTaskTrigger -AtStartup

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -RestartCount 999 `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal `
  -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
  -LogonType S4U `
  -RunLevel Limited

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Replacing the existing '$TaskName' task."
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName `
  -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description "Terry - persistent Discord control room for a coding-agent session" | Out-Null

Write-Host ""
Write-Host "Installed. Useful commands:"
Write-Host "  Start-ScheduledTask   -TaskName $TaskName"
Write-Host "  Stop-ScheduledTask    -TaskName $TaskName"
Write-Host "  Get-ScheduledTaskInfo -TaskName $TaskName"
Write-Host "  Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
Write-Host ""
Write-Host "It starts at boot. Start it now with Start-ScheduledTask if you want."
