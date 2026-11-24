<#
  Holodeck Portal job entry point.

  Runs inside a pseudo-terminal (script(1)) so Holodeck's console-based interactions
  ([console]::KeyAvailable, colours, widths) behave as they would at the Holorouter shell.
  Prompt answers are read from the job's input file by the Read-Host override (lib.ps1).

  The job file is written by the portal (mode 600) and deleted as soon as it is read,
  because it can contain depot tokens and credentials.
#>
param(
    [Parameter(Mandatory)][string]$JobFile
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$InformationPreference = 'Continue'

$job = Get-Content -Raw -LiteralPath $JobFile | ConvertFrom-Json -AsHashtable
Remove-Item -LiteralPath $JobFile -Force
$global:HP_JobDir = Split-Path -Parent $JobFile

. (Join-Path $PSScriptRoot 'lib.ps1')

if ($job.env) {
    foreach ($k in $job.env.Keys) { Set-Item -Path "env:$k" -Value ([string]$job.env[$k]) }
}
$global:HP_Answers = @($job.answers | Where-Object { $_ })

HP-Section "Holodeck Portal job $($job.id) ($($job.type))"
# Holorouters have Holodeck; the portal's own (control) jobs run without it.
if (Get-Module -ListAvailable -Name HoloDeck) { Import-Module HoloDeck -WarningAction SilentlyContinue -DisableNameChecking }
. (Join-Path $PSScriptRoot 'vi-compat.ps1')

$results = [ordered]@{}
$exitCode = 0
try {
    foreach ($step in $job.steps) {
        $command = [string]$step.command
        if ($command -notin $HP_AllowedCommands) {
            throw "Command '$command' is not allowed by the portal runner."
        }
        HP-Section ($step.title ?? $command)
        $params = @{}
        if ($step.params) { foreach ($k in $step.params.Keys) { $params[$k] = HP-ConvertParam $step.params[$k] } }
        # -ResetHoloRouter wipes GitLab, Authentik, Vault, DNS and Kubernetes on the Holorouter and reboots it.
        if ($params.Keys | Where-Object { $_ -match '^ResetHoloRouter$' }) {
            throw "The portal never runs $command with -ResetHoloRouter."
        }
        HP-EchoCommand $command $params $step.redact

        $output = & $command @params
        if ($step.capture) {
            $results[$step.capture] = $output
        } elseif ($null -ne $output) {
            $output | Out-Host
        }
    }
    HP-Section 'Job completed'
} catch {
    $exitCode = 1
    Write-Host ''
    Write-Host "Job failed: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.InvocationInfo) { Write-Host $_.InvocationInfo.PositionMessage -ForegroundColor DarkGray }
    $results['error'] = $_.Exception.Message
} finally {
    HP-WriteResult $results
}
exit $exitCode
