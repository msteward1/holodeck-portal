<#
  Holodeck disconnects before it connects (e.g. `Disconnect-VIServer -Server *` at the start of
  Stop-HoloDeckInstance). With no session that raises a statement-terminating error: at an interactive
  shell it is printed and the command carries on, but inside the runner's try block it ends the job.
  This global wrapper (functions win over cmdlets, and Holodeck's module resolves through the global
  scope) ignores only that "nothing to disconnect" error; every other error passes through unchanged.
#>
function global:Disconnect-VIServer {
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
    param(
        [Parameter(Position = 0, ValueFromPipeline)][object[]]$Server,
        [switch]$Force
    )
    process {
        try {
            VMware.VimAutomation.Core\Disconnect-VIServer @PSBoundParameters
        } catch {
            if ($_.Exception.Message -notmatch 'Could not find any of the servers specified') { throw }
            Write-Host "(no vCenter/ESX session to disconnect)" -ForegroundColor DarkGray
        }
    }
}
