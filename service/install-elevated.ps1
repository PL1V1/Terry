<#
.SYNOPSIS
  Re-registers Terry as an at-boot task, from an elevated shell.

.DESCRIPTION
  Registering a task that starts before anyone logs in requires administrator
  rights. This launches the installer elevated (raising a UAC prompt), records
  everything it did to logs\install-elevated.log so the result can be read back,
  and restarts the service afterwards.

  Run it from an ordinary shell; it elevates itself.
#>
[CmdletBinding()]
param(
  [string]$TaskName = "Terry"
)

$ErrorActionPreference = "Stop"

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$projectDir = Split-Path -Parent $scriptDir
$logDir = Join-Path $projectDir "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logFile = Join-Path $logDir "install-elevated.log"

$isAdmin = ([System.Security.Principal.WindowsPrincipal]::new(
  [System.Security.Principal.WindowsIdentity]::GetCurrent())
).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)

if ($isAdmin) {
  # Already elevated: do the work.
  "=== elevated install $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Out-File $logFile -Encoding utf8

  try {
    # Stop the running instance first so the replacement cannot end up with two
    # clients on one token fighting over the bot's presence.
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
      "Stopping the existing task." | Out-File $logFile -Append -Encoding utf8
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 3
    }

    # Kill anything left over from an earlier run. A task under S4U lives in
    # session 0, where an ordinary interactive session can neither read its
    # command line nor terminate it - so orphans can only be cleared from here.
    $strays = Get-CimInstance Win32_Process -Filter "Name='bun.exe' OR Name='cmd.exe'" |
      Where-Object { $_.CommandLine -like '*src\index.ts*' -or $_.CommandLine -like '*src/index.ts*' }
    foreach ($stray in $strays) {
      "Killing stray $($stray.Name) pid $($stray.ProcessId)" | Out-File $logFile -Append -Encoding utf8
      Stop-Process -Id $stray.ProcessId -Force -ErrorAction SilentlyContinue
    }
    if ($strays) { Start-Sleep -Seconds 2 }

    # A lock file left behind by a killed process is stale by definition.
    Remove-Item (Join-Path $projectDir "logs\terry.lock") -Force -ErrorAction SilentlyContinue

    & (Join-Path $scriptDir "install-service.ps1") -TaskName $TaskName *>&1 |
      Out-File $logFile -Append -Encoding utf8

    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 6

    $task = Get-ScheduledTask -TaskName $TaskName
    $trigger = $task.Triggers[0].CimClass.CimClassName
    "TRIGGER=$trigger" | Out-File $logFile -Append -Encoding utf8
    "LOGON=$($task.Principal.LogonType)" | Out-File $logFile -Append -Encoding utf8
    "RESULT=$((Get-ScheduledTaskInfo -TaskName $TaskName).LastTaskResult)" |
      Out-File $logFile -Append -Encoding utf8
    "OK" | Out-File $logFile -Append -Encoding utf8
  } catch {
    "FAILED: $($_.Exception.Message)" | Out-File $logFile -Append -Encoding utf8
  }
  return
}

# Not elevated: relaunch this same script with a UAC prompt.
Write-Host "Requesting elevation. Approve the UAC prompt on your desktop."
$self = $MyInvocation.MyCommand.Path
Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList @(
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$self`"", "-TaskName", $TaskName
)
Write-Host "Launched. Results will be written to $logFile"
