# Helper functions for Holodeck Portal jobs. Dot-sourced by entry.ps1.

# Every command a job step may invoke. The portal builds steps from its own catalog;
# this list is the second line of defence.
$global:HP_AllowedCommands = @(
    # Holodeck configuration
    'Get-HoloDeckConfig', 'Import-HoloDeckConfig', 'New-HoloDeckConfig', 'Set-HoloDeckConfig',
    'Start-HoloDeckPrecheck', 'New-HoloDeckNetworkConfig',
    # Instance lifecycle
    'New-HoloDeckInstance', 'Remove-HoloDeckInstance', 'Start-HoloDeckInstance', 'Stop-HoloDeckInstance',
    'Sync-HoloDeckInstance', 'Update-HoloDeckInstance', 'Get-HoloDeckInstance',
    # Network / router information
    'Get-HoloDeckSubnet', 'Get-HoloDeckAppNetwork', 'Get-HoloDeckBGPConfig', 'Get-HoloDeckOverlaySubnet',
    'Get-HoloDeckAppIpPools', 'Get-HoloDeckServiceIPPools', 'Get-HolorouterServices',
    # Maintenance
    'Reset-HoloDeckState', 'Export-ErrorDiagnostics',
    # Portal helpers (below)
    'HP-ImportConfig', 'HP-UseTarget', 'HP-ListConfigs', 'HP-NewConfig', 'HP-ExportConfig', 'HP-Snapshot', 'HP-AssertDeployed',
    'HP-PowerState', 'HP-ForcePowerOff', 'HP-RemoveLeftoverVMs', 'HP-AssertRemoved', 'HP-ConfigSummary', 'HP-ClearInstanceBinding',
    'HP-RouterOnboard', 'HP-RouterOffboard', 'HP-RouterInspect', 'HP-SyncConfig', 'HP-VCenterInventory',
    'HP-DeployRouter', 'HP-FetchOva', 'HP-WaitRouterReady', 'HP-ConfirmRouterHostKey', 'HP-OnboardDeployedRouter', 'HP-RenewHostKey', 'HP-DeleteRouterVM', 'HP-StageFiles',
    'HP-StopExtraVMs', 'HP-StartExtraVMs', 'HP-SuspendLab'
)

function global:Read-Host {
    <#
      Replaces Read-Host for Holodeck code running in the job. Emits a marker the portal
      turns into an "input required" prompt in the browser, then reads the answer from the
      job's input file (HP-ReadAnswer), not from the console: .NET's console line editor
      queries the terminal (cursor position) and, with no terminal emulator behind the
      pseudo-terminal, mangled answers that arrived while it waited. Prompts matching a
      pre-seeded answer are answered automatically.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Position = 0, ValueFromRemainingArguments = $true)][object]$Prompt,
        [switch]$AsSecureString,
        [switch]$MaskInput
    )
    $text = ($Prompt -join ' ').Trim()
    foreach ($a in $global:HP_Answers) {
        if ($text -match $a.match) {
            Write-Host "$text`: (answered automatically by the portal)"
            if ($AsSecureString) { return (ConvertTo-SecureString -String ([string]$a.value) -AsPlainText -Force) }
            return [string]$a.value
        }
    }
    $marker = @{ prompt = $text; secure = [bool]($AsSecureString -or $MaskInput) } | ConvertTo-Json -Compress
    [Console]::Out.WriteLine("@@HOLOPORTAL_PROMPT@@$marker")
    [Console]::Out.Flush()
    if (-not $global:HP_JobDir) { return Microsoft.PowerShell.Utility\Read-Host @PSBoundParameters }
    [Console]::Out.Write("$text`: ")
    $answer = HP-ReadAnswer
    [Console]::Out.WriteLine('(answered in the portal)')
    if ($AsSecureString) { return (ConvertTo-SecureString -String $answer -AsPlainText -Force) }
    return $answer
}

$global:HP_InputOffset = 0L
function HP-ReadAnswer {
    # Waits for the next complete line the portal appends to <job dir>/input (prompt answers) and returns it.
    $file = Join-Path $global:HP_JobDir 'input'
    while ($true) {
        if ((Test-Path -LiteralPath $file) -and (Get-Item -LiteralPath $file).Length -gt $global:HP_InputOffset) {
            $fs = [IO.File]::Open($file, 'Open', 'Read', 'ReadWrite')
            try {
                $null = $fs.Seek($global:HP_InputOffset, 'Begin')
                $buf = [byte[]]::new($fs.Length - $global:HP_InputOffset)
                $n = $fs.Read($buf, 0, $buf.Length)
            } finally { $fs.Dispose() }
            $nl = [Array]::IndexOf($buf, [byte]10, 0, $n)
            if ($nl -ge 0) {
                $global:HP_InputOffset += $nl + 1
                return ([Text.Encoding]::UTF8.GetString($buf, 0, $nl)).TrimEnd("`r")
            }
        }
        Start-Sleep -Milliseconds 500
    }
}

function HP-Section([string]$Title) {
    Write-Host ''
    Write-Host "==> $Title" -ForegroundColor Cyan
}

function HP-ConvertParam($Value) {
    # JSON arrays arrive as object[]; Holodeck's [string[]] / [int[]] parameters bind fine from them.
    if ($Value -is [System.Collections.IList]) { return , @($Value) }
    return $Value
}

function HP-EchoCommand([string]$Command, [hashtable]$Params, $Redact) {
    $redactSet = @($Redact)
    $parts = foreach ($k in $Params.Keys) {
        $v = $Params[$k]
        if ($k -in $redactSet) { "-$k ********" }
        elseif ($v -is [bool]) { if ($v) { "-$k" } else { "-${k}:`$false" } }
        elseif ($v -is [System.Collections.IList]) {
            "-$k " + (($v | ForEach-Object {
                if ($_ -is [System.Collections.IDictionary]) { $d = $_; '@{' + (($d.Keys | ForEach-Object { "$_=$($d[$_])" }) -join '; ') + '}' } else { "$_" }
            }) -join ',')
        }
        elseif ($v -is [System.Collections.IDictionary]) { "-$k @{" + (($v.Keys | ForEach-Object { "$_=$($v[$_])" }) -join '; ') + '}' }
        elseif ("$v" -match '\s') { "-$k '" + ("$v" -replace "'", "''") + "'" }
        else { "-$k $v" }
    }
    Write-Host ("PS> $Command " + ($parts -join ' ')) -ForegroundColor DarkGray
}

function HP-WriteResult($Results) {
    $path = Join-Path $global:HP_JobDir 'result.json'
    $json = $Results | ConvertTo-Json -Depth 20
    Set-Content -LiteralPath $path -Value $json -Encoding utf8
    if ($IsLinux) { chmod 600 $path }
}

function HP-ImportConfig {
    param([Parameter(Mandatory)][string]$ConfigID, [string]$Site = 'a')
    Import-HoloDeckConfig -ConfigID $ConfigID -Site $Site | Out-Null
    if (-not $Global:config -or $Global:config.ConfigId -notin @($ConfigID, "$ConfigID-site-$Site")) {
        throw "Holodeck configuration '$ConfigID' (site $Site) could not be imported."
    }
    Write-Host "Imported Holodeck config $ConfigID for site $Site"
}

function HP-UseTarget {
    <#
      Portal-side jobs (no Holodeck installed): loads the portal's copy of a Holodeck configuration, handed over in
      the job environment, as $Global:config, so the helpers below find the target host and its credentials there.
    #>
    param([Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9]+$')][string]$ConfigID)
    $b64 = $env:HP_TARGET_CONFIG
    Remove-Item env:HP_TARGET_CONFIG -ErrorAction SilentlyContinue
    if (-not $b64) { throw "The portal did not pass Holodeck configuration '$ConfigID' to this job." }
    $Global:config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) | ConvertFrom-Json
    if (-not $Global:config.Target.hostname) { throw "Holodeck configuration '$ConfigID' has no target host." }
    Write-Host "Using Holodeck configuration $ConfigID (target $($Global:config.Target.hostname))"
}

function HP-ConnectTarget {
    <#
      Signs in to the configuration's target (vCenter or ESXi) with its credentials, as Holodeck's Connect-TargetHost
      does but without needing Holodeck. Certificate trust is checked separately where it matters (approved
      certificate, strict sign-in), so PowerCLI's own check is off for this session, as in Holodeck.
    #>
    if ($global:DefaultVIServer -and $global:DefaultVIServer.IsConnected) { return }
    $t = $Global:config.Target
    if (-not $t.hostname) { throw 'No target host: load a Holodeck configuration first.' }
    Set-PowerCLIConfiguration -Scope Session -InvalidCertificateAction Ignore -ParticipateInCEIP $false -Confirm:$false | Out-Null
    $cred = [System.Management.Automation.PSCredential]::new($t.username, (ConvertTo-SecureString -String $t.password -AsPlainText -Force))
    Connect-VIServer -Server $t.hostname -Credential $cred -ErrorAction Stop | Out-Null
    Write-Host "Signed in to $($t.hostname)"
}

function HP-ListConfigs {
    @(Get-HoloDeckConfig) | ForEach-Object {
        [ordered]@{
            ConfigID    = $_.ConfigID
            BaseID      = $_.ConfigID -replace '-site-[ab]$', ''
            Description = $_.Description
            ConfigPath  = $_.ConfigPath
            Site        = $_.Site
            Instance    = $_.Instance
            Created     = "$($_.Created)"
        }
    }
}

function HP-NewConfig {
    param(
        [Parameter(Mandatory)][string]$TargetHost,
        [Parameter(Mandatory)][string]$UserName,
        [Parameter(Mandatory)][string]$Password,
        [string]$Description,
        [switch]$Default
    )
    $before = @(Get-HoloDeckConfig | ForEach-Object ConfigID)
    $p = @{ TargetHost = $TargetHost; UserName = $UserName; Password = $Password }
    if ($Description) { $p.Description = $Description }
    if ($Default) { $p.Default = $true }
    New-HoloDeckConfig @p | Out-Host
    $created = @(Get-HoloDeckConfig | Where-Object { $_.ConfigID -notin $before } | ForEach-Object ConfigID |
            ForEach-Object { $_ -replace '-site-[ab]$', '' } | Select-Object -Unique)
    if ($created.Count -eq 0) { throw 'New-HoloDeckConfig did not create a configuration.' }
    Write-Host "Created Holodeck configuration: $($created -join ', ')" -ForegroundColor Green
    # The portal keeps the master copy of every configuration: hand the new files back.
    $files = @{}
    foreach ($id in $created) { $files[$id] = (HP-ExportConfig -ConfigID $id).files }
    return @{ configIds = $created; files = $files }
}

function HP-ExportConfig {
    # Returns this router's copy of a Holodeck configuration (both sites, base64) for the portal's master copy.
    param([Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9]+$')][string]$ConfigID)
    $files = @{}
    foreach ($site in 'a', 'b') {
        $path = "/holodeck-runtime/config/$ConfigID-site-$site.json"
        if (Test-Path -LiteralPath $path) { $files[$site] = [Convert]::ToBase64String([IO.File]::ReadAllBytes($path)) }
    }
    if (-not $files.a) { throw "Holodeck configuration '$ConfigID' was not found on this router." }
    Write-Host "Read back Holodeck configuration $ConfigID"
    return @{ configId = $ConfigID; files = $files }
}

function HP-ConfigSummary {
    # Non-secret summary of the currently imported configuration.
    $c = $Global:config
    $siteKey = if ($c.ConfigPath -match '-site-b\.json$') { 'Site-B' } else { 'Site-A' }
    $s = $c.'holodeck-sddc'.$siteKey
    [ordered]@{
        ConfigId       = $c.ConfigId
        InstanceId     = $c.InstanceId
        Target         = [ordered]@{
            hostname = $c.Target.hostname; username = $c.Target.username; apiType = $c.Target.targetHostApiType
            datacenter = $c.Target.datacenter; cluster = $c.Target.cluster; resourcePool = $c.Target.resourcePool
            datastore = $c.Target.'datastore-a'; portGroup = $c.Target.'networkPortGroup-a'
        }
        Version        = $s.version
        Domain         = $s.domain
        vSANMode       = $c.vSANMode
        HoloRouter     = $c.holorouterStatus
        PrecheckSiteA  = $c.'isPreCheckCompleted-a'
    }
}

function HP-AssertDeployed {
    param([string]$Site = 'a')
    $statePath = $Global:config.state
    if (-not $statePath -or -not (Test-Path $statePath)) { throw 'Holodeck state file not found; deployment status unknown.' }
    $state = Get-Content -Raw $statePath | ConvertFrom-Json
    $status = $state.'New-HoloDeckInstance'.status
    Write-Host "Holodeck reports New-HoloDeckInstance status: $status"
    if ($status -ne 'Success') { throw "Deployment did not complete (Holodeck status: $status)." }
}

# Mirrors the NodeType enum in Holodeck's Model.psm1 (module-scoped, so not resolvable here).
$global:HP_NodeTypes = @('VCF_Automation', 'VCF_Ops_for_Networks', 'VCF_Ops_for_Collector', 'VCF_Operations_for_Logs',
    'VCF_Identity_Broker', 'VCF_Operations_Fleet_Management', 'VCF_Operations', 'VLR', 'NSX_Edge', 'NSX_Manager',
    'SDDC_Manager', 'vCenter_Server', 'ESX_Host', 'VCF_Installer', 'Cloud_Builder')

function HP-NodeType($Value) {
    if ($Value -is [string] -and $Value -notmatch '^\d+$') { return $Value }
    $i = [int]$Value
    if ($i -ge 0 -and $i -lt $HP_NodeTypes.Count) { return $HP_NodeTypes[$i] }
    return "$Value"
}

function HP-Snapshot {
    <# Captures everything the portal shows for a lab: nodes, subnets, endpoints and credentials. #>
    param([Parameter(Mandatory)][string]$InstanceID, [string]$Site = 'a')
    $siteKey = if ($Site -eq 'b') { 'Site-B' } else { 'Site-A' }
    $siteProp = if ($Site -eq 'b') { 'SiteB' } else { 'SiteA' }

    $nodes = @()
    $instanceFile = Join-Path $Global:config.rootFolderPath "output/$InstanceID.json"
    if (Test-Path $instanceFile) {
        $inst = Get-Content -Raw $instanceFile | ConvertFrom-Json
        $nodes = @($inst.$siteProp.Nodes | ForEach-Object {
                [ordered]@{ name = $_.Name; ip = $_.IPAddress; powerState = $_.PowerState; reachable = $_.IsReachable
                    type = HP-NodeType $_.Type; domain = $_.VIDomain }
            })
    }

    $subnets = @(Get-HoloDeckSubnet -Site $Site | ForEach-Object {
            [ordered]@{ name = $_.Name; vlan = "$($_.VLAN_ID)"; subnet = $_.Subnet; mask = $_.SubnetMask; gateway = $_.Gateway
                dhcp = $_.DHCP; dhcpStart = $_.DHCP_Range_Start; dhcpEnd = $_.DHCP_Range_End }
        })
    $endpoints = @(Get-HoloDeckAppNetwork -Site $Site | ForEach-Object {
            [ordered]@{ hostname = $_.Hostname; fqdn = $_.FQDN; ip = $_.IP }
        })
    $bgp = Get-HoloDeckBGPConfig -Site $Site

    # Lab credentials: every password under holodeck-sddc.<site>, with a sibling username if present.
    # The outer vCenter (Target) credentials are deliberately never collected.
    $creds = [System.Collections.Generic.List[object]]::new()
    function Walk($node, [string]$path) {
        if ($null -eq $node) { return }
        if ($node -is [System.Management.Automation.PSCustomObject]) {
            $props = $node.PSObject.Properties
            $user = ($props | Where-Object { $_.Name -match '^(user(name)?|adminUser(name)?)$' -and $_.Name -notmatch 'password' -and $_.Value -is [string] } | Select-Object -First 1).Value
            foreach ($p in $props) {
                if ($p.Value -is [string] -and $p.Name -match 'password' -and $p.Value) {
                    $creds.Add([ordered]@{ path = "$path.$($p.Name)".TrimStart('.'); username = $user; password = $p.Value })
                } elseif ($p.Value -isnot [string]) {
                    Walk $p.Value "$path.$($p.Name)"
                }
            }
        } elseif ($node -is [System.Collections.IEnumerable] -and $node -isnot [string]) {
            $i = 0
            foreach ($item in $node) { Walk $item "$path[$i]"; $i++ }
        }
    }
    Walk $Global:config.'holodeck-sddc'.$siteKey ''
    if ($bgp.BGP_Password) { $creds.Add([ordered]@{ path = 'bgp.password'; username = $null; password = $bgp.BGP_Password }) }

    return [ordered]@{
        instanceId = $InstanceID
        site       = $Site
        nodes      = $nodes
        subnets    = $subnets
        endpoints  = $endpoints
        bgp        = [ordered]@{ routerAs = $bgp.Router_AS; edgeMgmtAs = $bgp.Edge_Mgmt_AS; edgeWldAs = $bgp.Edge_Wld_AS }
        domain     = $Global:config.'holodeck-sddc'.$siteKey.domain
        credentials = $creds
    }
}

function HP-InstanceVMs([string]$InstanceID, [string]$Site) {
    Connect-TargetHost | Out-Null
    # ESX hosts end in the site letter (a1-esx-01a); Holodeck names the installer by FQDN
    # (a1-vcfinstaller-a.site-a.vcf.lab), so match both forms.
    @(Get-VM | Where-Object {
        $n = $_.Name
        $n -like "$InstanceID-esx-*$Site" -or
        $n -like "$InstanceID-vcfinstaller-*$Site" -or $n -like "$InstanceID-vcfinstaller-$Site.*" -or
        $n -like "$InstanceID-cloudbuilder-*$Site" -or $n -like "$InstanceID-cloudbuilder-$Site.*"
    })
}

function HP-PowerState {
    param([Parameter(Mandatory)][string]$InstanceID, [string]$Site = 'a')
    $vms = HP-InstanceVMs $InstanceID $Site
    $on = @($vms | Where-Object PowerState -eq 'PoweredOn').Count
    $suspended = @($vms | Where-Object PowerState -eq 'Suspended').Count
    $state = if ($vms.Count -eq 0) { 'absent' }
        elseif ($on -eq $vms.Count) { 'on' }
        elseif ($suspended -eq $vms.Count) { 'suspended' }
        elseif ($on -eq 0 -and $suspended -eq 0) { 'off' }
        else { 'partial' }
    Write-Host "Instance $InstanceID site ${Site}: $($vms.Count) VMs, $on powered on, $suspended suspended -> $state"
    return @{ state = $state; vms = @($vms | ForEach-Object { @{ name = $_.Name; powerState = "$($_.PowerState)" } }) }
}

function HP-ExtraVMs([string]$InstanceID, [string]$Site) {
    # The lab's VMs other than the nested ESX hosts: the VCF Installer / Cloud Builder. Holodeck's
    # Stop-/Start-HoloDeckInstance match "<id>-*<site>", which misses the FQDN-named installer.
    @(HP-InstanceVMs $InstanceID $Site | Where-Object { $_.Name -notlike "$InstanceID-esx-*" })
}

function HP-StopExtraVMs {
    <# Guest shutdown of the installer VM (hard power-off if VMware Tools isn't running or it doesn't stop in time). #>
    param([Parameter(Mandatory)][string]$InstanceID, [string]$Site = 'a', [int]$TimeoutSeconds = 300)
    $vms = @(HP-ExtraVMs $InstanceID $Site | Where-Object PowerState -eq 'PoweredOn')
    if (-not $vms) { Write-Host 'No other lab VMs are powered on.'; return }
    foreach ($vm in $vms) {
        if ($vm.ExtensionData.Guest.ToolsRunningStatus -eq 'guestToolsRunning') {
            Write-Host "Shutting down the guest OS of $($vm.Name)"
            $vm | Shutdown-VMGuest -Confirm:$false | Out-Null
        } else {
            Write-Host "VMware Tools is not running in $($vm.Name); powering it off"
            $vm | Stop-VM -Confirm:$false | Out-Null
        }
    }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        Start-Sleep -Seconds 10
        $still = @($vms | ForEach-Object { Get-VM -Id $_.Id } | Where-Object PowerState -eq 'PoweredOn')
    } while ($still -and (Get-Date) -lt $deadline)
    foreach ($vm in $still) {
        Write-Host "$($vm.Name) did not shut down within $TimeoutSeconds s; powering it off"
        $vm | Stop-VM -Confirm:$false | Out-Null
    }
}

function HP-StartExtraVMs {
    <# Powers on (or resumes) the installer VM after Holodeck has started the ESX hosts. #>
    param([Parameter(Mandatory)][string]$InstanceID, [string]$Site = 'a')
    $vms = @(HP-ExtraVMs $InstanceID $Site | Where-Object PowerState -ne 'PoweredOn')
    if (-not $vms) { Write-Host 'Other lab VMs are already powered on.'; return }
    foreach ($vm in $vms) {
        Write-Host "$(if ($vm.PowerState -eq 'Suspended') { 'Resuming' } else { 'Powering on' }) $($vm.Name)"
        $vm | Start-VM -Confirm:$false | Out-Null
    }
}

function HP-SuspendLab {
    <#
      Suspends every VM of the lab (nested ESX hosts and the installer) at once, so the nested
      environment freezes consistently. vSphere writes each VM's memory next to its .vmx, so the
      datastores must have room for it; resuming goes through the normal power-on.
    #>
    param([Parameter(Mandatory)][string]$InstanceID, [string]$Site = 'a')
    $vms = @(HP-InstanceVMs $InstanceID $Site | Where-Object PowerState -eq 'PoweredOn')
    if (-not $vms) { throw 'No powered-on VMs to suspend.' }
    $needGB = @{}
    foreach ($vm in $vms) {
        $ds = ([string]$vm.ExtensionData.Config.Files.VmPathName -replace '^\[([^\]]+)\].*$', '$1')
        $needGB[$ds] = ($needGB[$ds] ?? 0) + $vm.MemoryGB
    }
    foreach ($ds in $needGB.Keys) {
        $free = (Get-Datastore -Name $ds).FreeSpaceGB
        $need = [math]::Ceiling($needGB[$ds] * 1.05 + 10)
        Write-Host ("Datastore {0}: about {1} GB needed for memory files, {2:N0} GB free" -f $ds, $need, $free)
        if ($free -lt $need) { throw "Datastore $ds has $([math]::Floor($free)) GB free; suspending needs about $need GB. Shut the lab down instead." }
    }
    $tasks = foreach ($vm in $vms) {
        Write-Host "Suspending $($vm.Name) ($($vm.MemoryGB) GB memory)"
        Suspend-VM -VM $vm -Confirm:$false -RunAsync
    }
    $null = Wait-Task -Task $tasks
}

function HP-ForcePowerOff {
    <# Hard power-off of the lab's VMs on the target vCenter. Admin fallback when a graceful stop fails. #>
    param([Parameter(Mandatory)][string]$InstanceID, [string]$Site = 'a')
    # Suspended VMs are powered off too (their saved memory is discarded).
    foreach ($vm in (HP-InstanceVMs $InstanceID $Site | Where-Object PowerState -ne 'PoweredOff')) {
        Write-Host "Powering off $($vm.Name) ($($vm.PowerState))"
        $vm | Stop-VM -Confirm:$false | Out-Null
    }
    HP-PowerState -InstanceID $InstanceID -Site $Site
}

function HP-RemoveLeftoverVMs {
    <#
      Remove-HoloDeckInstance matches the installer as "<id>-vcfinstaller-*<site>", but Holodeck names
      that VM by FQDN (a1-vcfinstaller-a.site-a.vcf.lab), so it is left behind. Delete whatever VMs of
      this instance remain, matched strictly by instance ID and site (HP-InstanceVMs).
    #>
    param(
        [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9]{1,8}$')][string]$InstanceID,
        [ValidateSet('a', 'b')][string]$Site = 'a'
    )
    $left = HP-InstanceVMs $InstanceID $Site
    if ($left.Count -eq 0) { Write-Host "No leftover VMs for instance $InstanceID site $Site"; return }
    foreach ($vm in $left) {
        if ($vm.PowerState -eq 'PoweredOn') {
            Write-Host "Powering off $($vm.Name)"
            $vm = Stop-VM -VM $vm -Confirm:$false
        }
        Write-Host "Deleting $($vm.Name)"
        Remove-VM -VM $vm -DeletePermanently -Confirm:$false
    }
}

function HP-AssertRemoved {
    param([Parameter(Mandatory)][string]$InstanceID, [string]$Site = 'a')
    $left = HP-InstanceVMs $InstanceID $Site
    if ($left.Count -gt 0) { throw "Removal incomplete; VMs still present: $(($left.Name) -join ', ')" }
    Write-Host "No VMs remain for instance $InstanceID site $Site" -ForegroundColor Green
}

function HP-ClearInstanceBinding {
    <#
      Remove-HoloDeckInstance leaves the removed InstanceId in the config files; clear it so the
      configuration no longer appears bound. Written the same way Set-HoloDeckConfig writes files.
    #>
    param([Parameter(Mandatory)][string]$ConfigID, [Parameter(Mandatory)][string]$InstanceID)
    foreach ($site in 'a', 'b') {
        $path = Join-Path $Global:config.rootFolderPath "config/$ConfigID-site-$site.json"
        if (-not (Test-Path $path)) { continue }
        $c = Get-Content -Raw $path | ConvertFrom-Json
        if ($c.InstanceId -and $c.InstanceId -ieq $InstanceID) {
            $c.InstanceId = $null
            $c | ConvertTo-Json -Depth 100 | Set-Content $path
            Write-Host "Cleared instance $InstanceID from $(Split-Path -Leaf $path)"
        }
    }
    if ($Global:config.InstanceId -ieq $InstanceID) { $Global:config.InstanceId = $null }
}

# ---------------------------------------------------------------------------
# Holorouters
# ---------------------------------------------------------------------------

$global:HP_SshDir = if ($env:HP_SSH_DIR) { $env:HP_SSH_DIR } else { '/var/lib/holodeck-portal/ssh' }

function HP-Ssh {
    # Runs a command on a managed Holorouter with the portal's key. Returns stdout lines; throws on failure.
    param([Parameter(Mandatory)][string]$Address, [Parameter(Mandatory)][string]$Command)
    # Host keys are pinned by HP-PinHostKey before the first connection; nothing is accepted on the fly.
    $hostKey = 'yes'
    # stdout is the result; stderr only explains failures (OVA routers run OpenSSH 9.1, so the newer client's
    # post-quantum warning is switched off rather than mixed into the output).
    # -n: never read the job's terminal (a later prompt must get the administrator's answer, nothing else).
    $all = & ssh -n -i "$HP_SshDir/id_ed25519" -o "UserKnownHostsFile=$HP_SshDir/known_hosts" -o "StrictHostKeyChecking=$hostKey" `
        -o BatchMode=yes -o IgnoreUnknown=WarnWeakCrypto -o WarnWeakCrypto=no -o ConnectTimeout=15 "root@$Address" $Command 2>&1
    $out = @($all | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] })
    $err = @($all | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object { "$_" })
    if ($LASTEXITCODE -ne 0) { throw "ssh $Address failed ($LASTEXITCODE): $((@($err) + @($out)) -join ' ')" }
    $out
}

function HP-PinHostKey {
    <#
      Reads the router's SSH host keys and pins one in the portal's known_hosts, replacing any old entry.
      With -Fingerprint (an administrator compared it with the router's console) only that key is accepted
      and anything else fails before a password is sent. Without it (a router the portal has just deployed)
      the router's ed25519 key is trusted on first use and its fingerprint is logged and returned.
    #>
    param([Parameter(Mandatory)][string]$Address, [string]$Fingerprint)
    $known = "$HP_SshDir/known_hosts"
    $lines = @(& ssh-keyscan -T 15 -t ed25519,ecdsa,rsa $Address 2>$null | Where-Object { $_ -and $_ -notmatch '^#' })
    if (-not $lines) { throw "Could not read the SSH host key of $Address." }
    $tmp = [IO.Path]::GetTempFileName()
    try {
        $lines | Set-Content $tmp
        $fps = @(& ssh-keygen -E sha256 -lf $tmp)
    } finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
    $keys = for ($k = 0; $k -lt $lines.Count; $k++) {
        $f = ($fps[$k] -split ' ')[1]
        [pscustomobject]@{ line = $lines[$k]; type = ($lines[$k] -split ' ')[1]; fingerprint = $f }
    }
    if ($Fingerprint) {
        $key = $keys | Where-Object { $_.fingerprint -ceq $Fingerprint.Trim() } | Select-Object -First 1
        if (-not $key) {
            throw "The SSH host key of $Address does not match the approved fingerprint $Fingerprint (it offers $(@($keys.fingerprint) -join ', ')). Nothing was sent to it."
        }
        Write-Host "Host key of $Address matches the approved fingerprint $($key.fingerprint)" -ForegroundColor Green
    } else {
        $key = ($keys | Where-Object { $_.type -eq 'ssh-ed25519' } | Select-Object -First 1) ?? $keys[0]
        Write-Host "Trusting the host key of the newly deployed $Address on first use: $($key.type) $($key.fingerprint)"
    }
    & ssh-keygen -R $Address -f $known 2>&1 | Out-Null
    Add-Content -Path $known -Value $key.line
    return "$($key.type) $($key.fingerprint)"
}

function HP-RouterOnboard {
    <#
      Installs the portal's public key on a Holorouter using its root password (from the job
      environment, never a parameter). The host key is pinned first (HP-PinHostKey) and every
      connection, the password one included, is checked against it.
    #>
    param([Parameter(Mandatory)][string]$Address, [Parameter(Mandatory)][string]$PublicKey, [string]$HostKeyFingerprint)
    $password = $env:HP_ROUTER_PASSWORD
    Remove-Item env:HP_ROUTER_PASSWORD -ErrorAction SilentlyContinue
    if (-not $password) { throw 'No root password was provided for the Holorouter.' }
    if ($PublicKey -notmatch '^ssh-ed25519 [A-Za-z0-9+/=]+ [\w.@-]+$') { throw 'Unexpected public key format.' }
    # Imports pass the fingerprint the admin confirmed; deployments get it from HP-ConfirmRouterHostKey (earlier
    # step of the same job). The password is never sent to a key nobody confirmed.
    if (-not $HostKeyFingerprint) { $HostKeyFingerprint = $global:HP_ConfirmedHostKey }
    if (-not $HostKeyFingerprint) { throw "The SSH host key of $Address has not been confirmed; the root password was not sent." }
    $hostKey = HP-PinHostKey -Address $Address -Fingerprint $HostKeyFingerprint

    # OpenSSH asks this helper for the password; it reads it from the environment of this one ssh process.
    $askpass = [IO.Path]::Combine([IO.Path]::GetTempPath(), "hp-askpass-$([guid]::NewGuid().ToString('N')).sh")
    Set-Content -Path $askpass -Value "#!/bin/sh`nprintf '%s\n' `"`$HP_ASKPASS_SECRET`"`n"
    & chmod 700 $askpass
    $env:SSH_ASKPASS = $askpass
    $env:SSH_ASKPASS_REQUIRE = 'force'
    $env:HP_ASKPASS_SECRET = $password
    try {
        Write-Host "Connecting to $Address as root"
        $cmd = "umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; grep -qxF '$PublicKey' ~/.ssh/authorized_keys || echo '$PublicKey' >> ~/.ssh/authorized_keys"
        $out = & ssh -n -o "UserKnownHostsFile=$HP_SshDir/known_hosts" -o StrictHostKeyChecking=yes -o PubkeyAuthentication=no `
            -o PreferredAuthentications=password,keyboard-interactive -o NumberOfPasswordPrompts=1 -o IgnoreUnknown=WarnWeakCrypto -o WarnWeakCrypto=no `
            -o ConnectTimeout=30 "root@$Address" $cmd 2>&1
        if ($LASTEXITCODE -ne 0) { throw "Could not install the portal key on $Address ($LASTEXITCODE): $((@($out) | ForEach-Object { "$_" }) -join ' ')" }
    } finally {
        Remove-Item env:HP_ASKPASS_SECRET, env:SSH_ASKPASS, env:SSH_ASKPASS_REQUIRE -ErrorAction SilentlyContinue
        Remove-Item $askpass -ErrorAction SilentlyContinue
    }
    $hostname = (HP-Ssh -Address $Address -Command 'hostname' | Select-Object -Last 1)
    Write-Host "Portal key installed; key login to $hostname works" -ForegroundColor Green
    return @{ hostname = "$hostname".Trim(); hostKey = $hostKey }
}

function HP-RouterOffboard {
    # Removes the portal's key from a Holorouter. -IgnoreErrors for routers that are already gone.
    param([Parameter(Mandatory)][string]$Address, [Parameter(Mandatory)][string]$PublicKey, [switch]$IgnoreErrors)
    $body = ($PublicKey -split ' ')[1]
    if (-not $body) { throw 'Unexpected public key format.' }
    try {
        HP-Ssh -Address $Address -Command "sed -i '\#$body#d' ~/.ssh/authorized_keys" | Out-Null
        Write-Host "Removed the portal key from $Address"
    } catch {
        if (-not $IgnoreErrors) { throw }
        Write-Host "Could not reach $Address to remove the portal key: $($_.Exception.Message)" -ForegroundColor Yellow
    }
    & ssh-keygen -R $Address -f "$HP_SshDir/known_hosts" 2>&1 | Out-Null
}

function HP-RouterInspect {
    <#
      Runs ON a Holorouter: health and cleanliness facts the portal uses to accept a router and to
      show its state. Read-only.
    #>
    param([string]$VCenter)
    $root = '/holodeck-runtime'
    $facts = [ordered]@{ hostname = (hostname).Trim(); checkedAt = (Get-Date).ToUniversalTime().ToString('o') }
    $mod = Get-Module -ListAvailable HoloDeck | Sort-Object Version -Descending | Select-Object -First 1
    $facts.holodeckVersion = if ($mod) { "$($mod.Version)" } else { $null }
    $facts.cpus = [Environment]::ProcessorCount
    $facts.memoryGB = [math]::Round(((Get-Content /proc/meminfo | Select-String '^MemTotal:\s+(\d+)').Matches[0].Groups[1].Value / 1MB), 1)
    $df = (& df -BG --output=avail $root 2>$null | Select-Object -Last 1)
    $facts.diskFreeGB = [int]("$df" -replace '[^0-9]', '')
    $facts.nics = @(foreach ($n in 'eth0', 'eth1', 'eth2') {
        $state = (Get-Content "/sys/class/net/$n/operstate" -ErrorAction SilentlyContinue)
        $ip = (& ip -4 -o addr show dev $n 2>$null | ForEach-Object { ($_ -split '\s+')[3] } | Select-Object -First 1)
        [ordered]@{ name = $n; present = [bool]$state; state = "$state"; ip = "$ip" }
    })
    $facts.configs = @(Get-ChildItem "$root/config/*-site-?.json" -ErrorAction SilentlyContinue | ForEach-Object {
        $c = Get-Content -Raw $_.FullName | ConvertFrom-Json
        [ordered]@{ file = $_.Name; instanceId = $c.InstanceId; holorouterStatus = $c.holorouterStatus }
    })
    $facts.instances = @(Get-ChildItem "$root/output/*.json" -ErrorAction SilentlyContinue | ForEach-Object { $_.BaseName })
    # A fresh Holorouter ships a stub startup_script.sh (shebang and comments only); Holodeck appends
    # `ip ...` commands when it configures the lab networks, so only those count.
    $facts.startupScript = (Test-Path "$root/startup_script.sh") -and [bool](Select-String -Path "$root/startup_script.sh" -Pattern '^\s*ip\s' -Quiet -ErrorAction SilentlyContinue)
    $facts.vlanInterfaces = @(Get-ChildItem /sys/class/net -Name | Where-Object { $_ -match '^eth[12]\.\d+$' }).Count
    $pods = $null
    try { $pods = (& kubectl get pods -A -o json 2>$null | ConvertFrom-Json).items } catch { }
    $facts.kubernetes = [ordered]@{
        reachable = $null -ne $pods
        pods      = @($pods).Count
        notReady  = @($pods | Where-Object { $_.status.phase -notin 'Running', 'Succeeded' } | ForEach-Object { "$($_.metadata.namespace)/$($_.metadata.name)" })
    }
    $code = (& curl -s -o /dev/null -m 10 -w '%{http_code}' http://127.0.0.1:30000/ 2>$null)
    $facts.webtop = [ordered]@{ httpStatus = "$code"; ok = "$code" -in '200', '401' }
    if ($VCenter) {
        $facts.vcenterReachable = [bool](Test-Connection -TargetName $VCenter -TcpPort 443 -Quiet -TimeoutSeconds 5 -ErrorAction SilentlyContinue)
    }
    $facts | ConvertTo-Json -Depth 6 | Write-Host
    return $facts
}

function HP-SyncConfig {
    <#
      Runs ON a secondary Holorouter before a deployment: writes the portal's copy of a Holodeck
      configuration (from the primary). Router-specific fields are kept from the router's own files:
      instance binding, precheck flags, and holorouterStatus, which reflects whether Holodeck has
      already configured this router's network (always for this router's own slot).
    #>
    param([Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9]+$')][string]$ConfigID, [Parameter(Mandatory)][hashtable]$Files)
    # HP_HOLODECK_RUNTIME only for tests; Holodeck's runtime folder otherwise.
    $runtime = if ($env:HP_HOLODECK_RUNTIME) { $env:HP_HOLODECK_RUNTIME } else { '/holodeck-runtime' }
    $dir = "$runtime/config"
    $configured = @(Get-ChildItem "$dir/*-site-?.json" -ErrorAction SilentlyContinue | Where-Object {
        (Get-Content -Raw $_.FullName | ConvertFrom-Json).holorouterStatus -eq 'Configured'
    }).Count -gt 0
    foreach ($site in $Files.Keys) {
        if ($site -notin 'a', 'b') { throw "Invalid site '$site'" }
        $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Files[$site]))
        $c = $json | ConvertFrom-Json
        $path = "$dir/$ConfigID-site-$site.json"
        $existing = if (Test-Path $path) { Get-Content -Raw $path | ConvertFrom-Json } else { $null }
        # The portal's copy has no router fields (configstore.ts strips them): add them, don't assume they exist.
        $c | Add-Member -NotePropertyName InstanceId -NotePropertyValue $existing.InstanceId -Force
        # Holodeck's template has these too (default null) and Holodeck assigns them directly (Start-HoloDeckPrecheck
        # sets isPreCheckCompleted-<site>): always present, the router's own value or null (= run the precheck).
        foreach ($k in 'isPreCheckCompleted-a', 'isPreCheckCompleted-b') {
            $own = if ($existing -and $existing.PSObject.Properties[$k]) { $existing.$k } else { $null }
            $c | Add-Member -NotePropertyName $k -NotePropertyValue $own -Force
        }
        $c | Add-Member -NotePropertyName holorouterStatus -NotePropertyValue $(if ($configured) { 'Configured' } else { 'NotConfigured' }) -Force
        # The state and log files are per host: the primary's paths don't exist here. Keep this router's
        # own files, or start new ones named as Holodeck names them (New-HoloDeckState creates an empty
        # state file, which makes Holodeck run its prechecks from the start).
        $stamp = Get-Date -Format 'ddMMMyyyy_hh_mm'
        $fresh = @{
            state     = "$runtime/state/holodeck-runtime-state-site-${site}_$(Get-Date -Format 'ddMMMyyyy_hh_mm_ss').json"
            logs      = "$runtime/logs/holodeck-runtime-log-site-${site}_$stamp.log"
            errorLogs = "$runtime/logs/holodeck-runtime-errors-site-${site}_$stamp.log"
        }
        foreach ($k in 'state', 'logs', 'errorLogs') {
            $own = $existing.$k
            $value = if ($own -and (Test-Path -LiteralPath $own)) { $own } else { $fresh[$k] }
            if ($k -eq 'state' -and -not (Test-Path -LiteralPath $value)) {
                New-Item -ItemType Directory -Force -Path (Split-Path -Parent $value) | Out-Null
                New-Item -ItemType File -Path $value | Out-Null
            }
            $c | Add-Member -NotePropertyName $k -NotePropertyValue $value -Force
        }
        $c | ConvertTo-Json -Depth 100 | Set-Content $path
        if ($IsLinux) { chmod 640 $path }
        Write-Host "Wrote $ConfigID-site-$site.json (Holorouter $($c.holorouterStatus))"
    }
}

function HP-InventoryPath($View) {
    # vCenter inventory path below the root folder, e.g. "DC/host/Cluster" or "DC/vm/Labs".
    $parts = @()
    $v = $View
    while ($v -and $v.Parent) {
        $parts = , $v.Name + $parts
        $v = Get-View $v.Parent -Property Name, Parent
    }
    $parts -join '/'
}

function HP-VCenterInventory {
    # Placement choices for Capacity Profiles: clusters with their resource pools, datastores and networks; VM folders.
    HP-ConnectTarget
    $result = @(foreach ($dc in Get-Datacenter) {
        $vmFolder = Get-View $dc.ExtensionData.VmFolder -Property Name
        [ordered]@{
            name     = $dc.Name
            folders  = @(Get-Folder -Type VM -Location $dc | Where-Object { $_.Id -ne $vmFolder.MoRef.ToString() } | ForEach-Object {
                ((HP-InventoryPath (Get-View $_.Id -Property Name, Parent)) -split '/', 3)[2]
            } | Where-Object { $_ } | Sort-Object -Unique)
            clusters = @(foreach ($cl in Get-Cluster -Location $dc) {
                $ds = Get-View $cl.ExtensionData.Datastore -Property Name, Summary
                $nets = Get-View $cl.ExtensionData.Network -Property Name
                [ordered]@{
                    name          = $cl.Name
                    resourcePools = @(Get-ResourcePool -Location $cl | Where-Object Name -ne 'Resources' | ForEach-Object Name | Sort-Object)
                    datastores    = @($ds | Sort-Object Name | ForEach-Object {
                        [ordered]@{ name = $_.Name; type = $_.Summary.Type; capacityGB = [math]::Round($_.Summary.Capacity / 1GB); freeGB = [math]::Round($_.Summary.FreeSpace / 1GB) }
                    })
                    networks      = @($nets | Sort-Object Name | ForEach-Object {
                        [ordered]@{ name = $_.Name; type = if ($_.MoRef.Type -eq 'DistributedVirtualPortgroup') { 'distributed' } else { 'standard' } }
                    })
                }
            })
        }
    })
    $apiType = "$((Get-View ServiceInstance).Content.About.ApiType)"
    if ($apiType -eq 'HostAgent') {
        # A standalone ESXi host has no cluster: its compute resource stands in for one (placement = the host).
        $result = @(foreach ($dc in Get-Datacenter) {
            [ordered]@{
                name     = $dc.Name
                folders  = @()
                clusters = @(foreach ($cr in Get-View -ViewType ComputeResource -Property Name, Datastore, Network, ResourcePool, Host) {
                    $ds = Get-View $cr.Datastore -Property Name, Summary
                    $nets = Get-View $cr.Network -Property Name
                    $rootPool = Get-View $cr.ResourcePool -Property Name, ResourcePool
                    [ordered]@{
                        name          = $cr.Name
                        kind          = 'host'
                        resourcePools = @(Get-ResourcePool | Where-Object Name -ne 'Resources' | ForEach-Object Name | Sort-Object)
                        datastores    = @($ds | Sort-Object Name | ForEach-Object {
                            [ordered]@{ name = $_.Name; type = $_.Summary.Type; capacityGB = [math]::Round($_.Summary.Capacity / 1GB); freeGB = [math]::Round($_.Summary.FreeSpace / 1GB) }
                        })
                        networks      = @($nets | Sort-Object Name | ForEach-Object { [ordered]@{ name = $_.Name; type = 'standard' } })
                    }
                })
            }
        })
    }
    Write-Host "Found $($result.Count) datacenter(s), $(@($result.clusters).Count) $(if ($apiType -eq 'HostAgent') { 'standalone host(s)' } else { 'cluster(s)' })"
    return @{ datacenters = $result; apiType = $apiType; license = (HP-TargetLicense) }
}

function HP-TargetLicense {
    <#
      Whether the target accepts API writes (router deployment needs them). vCenter: always. A standalone ESXi host
      on evaluation mode does; the free ESXi licence and an expired evaluation are read-only.
    #>
    $about = (Get-View ServiceInstance).Content.About
    if ("$($about.ApiType)" -ne 'HostAgent') { return [ordered]@{ edition = 'vCenter'; evaluation = $false; hoursLeft = $null; writable = $true } }
    $lm = Get-View (Get-View ServiceInstance).Content.LicenseManager
    $lic = @($lm.Licenses) | Select-Object -First 1
    $edition = "$($lic.EditionKey)"
    $isEval = $edition -match 'eval' -or "$($lic.LicenseKey)" -eq '00000-00000-00000-00000-00000'
    $hours = $null
    if ($isEval) { $hours = [int](@($lm.Evaluation.Properties) | Where-Object Key -eq 'expirationHours' | Select-Object -First 1).Value }
    $free = $edition -match 'basic|free|hypervisor'
    $writable = if ($isEval) { $hours -gt 0 } else { -not $free }
    return [ordered]@{ edition = $edition; name = "$($lic.Name)"; evaluation = $isEval; hoursLeft = $hours; writable = $writable }
}

function HP-DeployRouter {
    <#
      Deploys a Holorouter OVA into vCenter or onto a standalone ESXi host with PowerCLI's Import-VApp (no ovftool,
      which can't be redistributed). The root password comes from the job environment. Holodeck is not involved.
    #>
    param(
        [Parameter(Mandatory)][string]$OvaUrl,
        [Parameter(Mandatory)][string]$VMName,
        [Parameter(Mandatory)][string]$Datacenter,
        [Parameter(Mandatory)][string]$Cluster,
        [string]$ResourcePool,
        [string]$Folder,
        [Parameter(Mandatory)][string]$Datastore,
        [Parameter(Mandatory)][string]$MgmtNetwork,
        [Parameter(Mandatory)][string]$TrunkA,
        [Parameter(Mandatory)][string]$TrunkB,
        [Parameter(Mandatory)][hashtable]$Properties,
        # SHA-256 of the OVA an administrator approved; the cached download is checked against it again.
        [string]$OvaSha256,
        # vCenter certificate an administrator approved for the capacity profile (SHA-256 and SHA-1, AA:BB:… form).
        [string]$VCenterSha256,
        [string]$VCenterSha1,
        # Sign in to vCenter with strict certificate checking (the job's SSL_CERT_FILE holds vCenter's CA).
        [switch]$StrictTrust,
        # Why strict checking isn't used although enabled: 'reapprove' (approval predates it) or 'name'.
        [string]$StrictTrustNote,
        # Validate the OVA against the target (auth, placement, networks) without deploying.
        [switch]$VerifyOnly
    )
    $password = $env:HP_ROUTER_PASSWORD
    if (-not $password) { throw 'No root password was provided for the Holorouter.' }
    $source = HP-OvaCachePath -Url $OvaUrl
    if (-not (Test-Path $source)) { throw "The OVA has not been downloaded ($source missing); the download step must run first." }
    if ($OvaSha256) { HP-AssertSha256 -Path $source -Expected $OvaSha256 }
    elseif ($OvaUrl -notlike 'https://*') { throw 'An OVA from a plain HTTP URL is only deployed with an approved SHA-256.' }
    if (-not $VCenterSha256 -or -not $VCenterSha1) {
        throw 'No vCenter certificate is approved for this capacity profile, so the connection to vCenter could not be verified. Approve it in Holorouters -> Capacity profiles. Nothing was deployed.'
    }
    $vcHost = "$($Global:config.Target.hostname)"
    if ($VCenterSha256) {
        if (-not $vcHost) { throw 'The configuration has no vCenter hostname to check the certificate of.' }
        $live = HP-TlsThumbprint -HostName $vcHost
        if ($live.sha256 -ne $VCenterSha256.ToUpper()) {
            throw "The certificate of $vcHost has changed (now SHA-256 $($live.sha256); approved $VCenterSha256). Nothing was deployed. If the change is expected, approve the new certificate in the capacity profile."
        }
        Write-Host "vCenter $vcHost presents the approved certificate (SHA-256 $($live.sha256))" -ForegroundColor Green
    }
    if ($StrictTrust) {
        HP-ConnectTargetStrict
    } else {
        if ($StrictTrustNote -eq 'reapprove') { Write-Host "Note: approve the vCenter certificate again (Capacity profiles) to have this sign-in verified strictly; this approval predates it." -ForegroundColor Yellow }
        if ($StrictTrustNote -eq 'name') { Write-Host "Note: the vCenter certificate isn't issued for the name in the Holodeck configuration, so this sign-in isn't verified strictly." -ForegroundColor Yellow }
        HP-ConnectTarget
    }
    $vc = $global:DefaultVIServer
    $license = HP-TargetLicense
    if (-not $license.writable) {
        throw "This ESXi host doesn't accept deployments through its API ($(if ($license.evaluation) { 'evaluation period ended' } else { "licence $($license.edition)" })). Deploy the Holorouter OVA on the host yourself, then use Import existing. Nothing was deployed."
    }
    $standalone = "$((Get-View ServiceInstance).Content.About.ApiType)" -eq 'HostAgent'
    if (Get-VM -Name $VMName -ErrorAction SilentlyContinue) { throw "A VM named '$VMName' already exists." }
    $dc = Get-Datacenter -Name $Datacenter -ErrorAction Stop
    foreach ($k in $Properties.Keys) { if ($k -notmatch '^(network|extra)\.\w+$') { throw "Invalid OVA property '$k'" } }
    # Placement: a cluster (vCenter) or the standalone host's own compute resource; optional resource pool; VM folder.
    if ($standalone) {
        $cr = Get-View -ViewType ComputeResource -Property Name | Where-Object Name -eq $Cluster | Select-Object -First 1
        if (-not $cr) { throw "The ESXi host '$Cluster' in the capacity profile was not found on $($vc.Name)." }
        $vmhost = Get-VMHost | Select-Object -First 1
        $location = $vmhost
        $Folder = $null
    } else {
        $cl = Get-Cluster -Name $Cluster -Location $dc -ErrorAction Stop
        $location = $cl
        $vmhost = Get-VMHost -Location $cl | Where-Object { $_.ConnectionState -eq 'Connected' -and -not $_.ExtensionData.Runtime.InMaintenanceMode } |
            Where-Object { (Get-Datastore -RelatedObject $_ | ForEach-Object Name) -contains $Datastore } | Get-Random
        if (-not $vmhost) { throw "No connected host in cluster '$Cluster' sees datastore '$Datastore'." }
    }
    if ($ResourcePool) { $location = Get-ResourcePool -Name $ResourcePool -Location $location -ErrorAction Stop | Select-Object -First 1 }
    $ds = Get-Datastore -Name $Datastore -RelatedObject $vmhost -ErrorAction Stop | Select-Object -First 1
    $folderObj = if ($Folder) { Get-Folder -Type VM -Location $dc | Where-Object { (((HP-InventoryPath (Get-View $_.Id -Property Name, Parent)) -split '/', 3)[2]) -eq $Folder } | Select-Object -First 1 } else { $null }
    if ($Folder -and -not $folderObj) { throw "VM folder '$Folder' was not found." }
    # Port groups: standard or distributed, by name.
    $pg = {
        param($name)
        $p = if ($standalone) { Get-VirtualPortGroup -VMHost $vmhost -Name $name -ErrorAction SilentlyContinue } else { Get-VDPortgroup -Name $name -ErrorAction SilentlyContinue }
        if (-not $p) { $p = Get-VirtualPortGroup -VMHost $vmhost -Name $name -ErrorAction SilentlyContinue }
        if (-not $p) { throw "Port group '$name' was not found for host $($vmhost.Name)." }
        $p | Select-Object -First 1
    }
    $nets = [ordered]@{ 'VM Management Network' = (& $pg $MgmtNetwork); 'Trunk Portgroup for Site A' = (& $pg $TrunkA); 'Trunk Portgroup for Site B' = (& $pg $TrunkB) }
    $shown = @($Properties.Keys | Sort-Object | ForEach-Object { "$_=$($Properties[$_])" })
    Write-Host "Deploying $OvaUrl (cached as $source) as $VMName on $($vmhost.Name), datastore $Datastore$(if ($ResourcePool) { ", resource pool $ResourcePool" })$(if ($Folder) { ", folder $Folder" })"
    Write-Host ("Properties: " + ($shown -join ', ') + ', network.password=********')
    $import = @{ Source = $source; VMHost = $vmhost; Location = $location; Datastore = $ds; Name = $VMName; DiskStorageFormat = 'Thin'; Force = $true; ErrorAction = 'Stop' }
    if ($folderObj) { $import.InventoryLocation = $folderObj }
    if (-not $standalone) {
        # vCenter hands the properties to the VM as its vApp (OVF) environment.
        $ovf = Get-OvfConfiguration -Ovf $source
        foreach ($k in $Properties.Keys) { $grp, $name = $k -split '\.', 2; $ovf.$grp.$name.Value = "$($Properties[$k])" }
        $ovf.network.password.Value = $password
        # PowerCLI exposes OVF network names with spaces replaced by underscores.
        foreach ($n in $nets.Keys) { $ovf.NetworkMapping.($n -replace '\W', '_').Value = $nets[$n] }
        # Import-VApp takes the configuration as a hashtable (the object itself doesn't bind).
        $import.OvfConfiguration = $ovf.ToHashTable()
    }
    if ($VerifyOnly) {
        Write-Host 'Placement, port groups and OVA settings resolved; nothing deployed (verify only)' -ForegroundColor Green
        return @{ verified = $true }
    }
    try {
        $vm = Import-VApp @import
    } catch {
        throw ("Import-VApp failed: " + ("$($_.Exception.Message)" -replace [regex]::Escape($password), '********'))
    }
    $vm = Get-VM -Name $VMName -ErrorAction Stop | Select-Object -First 1
    if ($standalone) {
        # A standalone host has no vApp environment and no network mapping: set the NICs (in the OVA's order) and
        # write the OVF environment into guestinfo.ovfEnv, which the Holorouter's first boot reads.
        $adapters = @(Get-NetworkAdapter -VM $vm | Sort-Object Name)
        $i = 0
        foreach ($n in $nets.Keys) {
            if ($i -lt $adapters.Count) {
                # -Portgroup and -StartConnected are separate parameter sets.
                $a = Set-NetworkAdapter -NetworkAdapter $adapters[$i] -Portgroup $nets[$n] -Confirm:$false
                Set-NetworkAdapter -NetworkAdapter $a -StartConnected:$true -Confirm:$false | Out-Null
            }
            $i++
        }
        $all = [ordered]@{}
        foreach ($k in ($Properties.Keys | Sort-Object)) { $all[$k] = "$($Properties[$k])" }
        $all['network.password'] = $password
        New-AdvancedSetting -Entity $vm -Name 'guestinfo.ovfEnv' -Value (HP-OvfEnvironment $all) -Force -Confirm:$false | Out-Null
        Write-Host 'Wrote the router settings into the VM (guestinfo.ovfEnv)'
    }
    $vm = Start-VM -VM $vm -Confirm:$false -ErrorAction Stop
    Write-Host "Deployed $VMName ($($vm.PowerState))" -ForegroundColor Green
    return @{ vmName = $VMName; moref = $vm.Id }
}

$global:HP_OvaDir = if ($env:HP_OVA_DIR) { $env:HP_OVA_DIR } else { '/var/lib/holodeck-portal/ova' }

function HP-OvfEnvironment([System.Collections.IDictionary]$Values) {
    # The OVF environment document vCenter would hand the VM, for standalone ESXi targets.
    $esc = { param($v) [Security.SecurityElement]::Escape("$v") }
    $props = foreach ($k in $Values.Keys) { "         <Property oe:key=`"$(& $esc $k)`" oe:value=`"$(& $esc $Values[$k])`"/>" }
    @(
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Environment'
        '     xmlns="http://schemas.dmtf.org/ovf/environment/1"'
        '     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
        '     xmlns:oe="http://schemas.dmtf.org/ovf/environment/1"'
        '     xmlns:ve="http://www.vmware.com/schema/ovfenv"'
        '     oe:id="">'
        '   <PropertySection>'
        $props
        '   </PropertySection>'
        '</Environment>'
    ) -join "`n"
}

function HP-ClearOvfEnvironment([string]$VMName) {
    # After onboarding: the OVF environment written for a standalone ESXi host holds the root password; remove it.
    try {
        if ("$((Get-View ServiceInstance).Content.About.ApiType)" -ne 'HostAgent') { return }
        $vm = Get-VM -Name $VMName -ErrorAction Stop | Select-Object -First 1
        $setting = Get-AdvancedSetting -Entity $vm -Name 'guestinfo.ovfEnv' -ErrorAction SilentlyContinue
        if ($setting) { $setting | Set-AdvancedSetting -Value '' -Confirm:$false | Out-Null; Write-Host 'Cleared the router settings (with its root password) from the VM configuration' }
    } catch {
        Write-Host "WARNING: could not clear guestinfo.ovfEnv on $VMName ($($_.Exception.Message)); remove it in the ESXi Host Client." -ForegroundColor Yellow
    }
}

function HP-OvaCachePath {
    # One cached file per source URL.
    param([Parameter(Mandatory)][string]$Url)
    $h = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Url))).Substring(0, 16).ToLower()
    $name = [IO.Path]::GetFileName(([uri]$Url).AbsolutePath) -replace '[^\w.-]', '_'
    Join-Path $HP_OvaDir "$h-$name"
}

function HP-AssertSha256 {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Expected)
    Write-Host "Checking the SHA-256 of $(Split-Path -Leaf $Path)"
    $actual = (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLower()
    if ($actual -ne $Expected.Trim().ToLower()) {
        throw "The OVA's SHA-256 is $actual, not the approved $($Expected.Trim().ToLower()). It was not deployed."
    }
    Write-Host "SHA-256 matches the approved digest" -ForegroundColor Green
}

function HP-TlsThumbprint {
    # The certificate a TLS server presents, without trusting it: used to compare with an approved one.
    param([Parameter(Mandatory)][string]$HostName, [int]$Port = 443)
    $tcp = [Net.Sockets.TcpClient]::new()
    try {
        $tcp.ConnectAsync($HostName, $Port).Wait(15000) | Out-Null
        if (-not $tcp.Connected) { throw "Could not connect to ${HostName}:$Port" }
        $ssl = [Net.Security.SslStream]::new($tcp.GetStream(), $false, { $true })
        $ssl.AuthenticateAsClient($HostName)
        $cert = [Security.Cryptography.X509Certificates.X509Certificate2]::new($ssl.RemoteCertificate)
        $pairs = { param($hex) ($hex -split '(..)' | Where-Object { $_ }) -join ':' }
        return @{
            sha256 = & $pairs $cert.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256)
            sha1   = & $pairs $cert.GetCertHashString()
        }
    } finally { $tcp.Dispose() }
}

function HP-FetchOva {
    <#
      Downloads the Holorouter OVA to the primary's cache (one file per URL, kept for later deploys) so that
      it can be checked before anything is deployed. TLS is verified against the system trust store, or the
      depot CA an administrator supplied. With an approved SHA-256 the file must match it (and then a depot
      certificate that can't be verified is tolerated, because the digest is what proves the file). The
      cache keeps only the newest OVA.
    #>
    param([Parameter(Mandatory)][string]$Url, [string]$Sha256, [string]$CaPem)
    if ($Url -notmatch '^https?://') { throw "The OVA URL must start with http:// or https:// ($Url)." }
    New-Item -ItemType Directory -Force -Path $HP_OvaDir | Out-Null
    & chmod 700 $HP_OvaDir
    $dest = HP-OvaCachePath -Url $Url
    # Without an approved digest only verified HTTPS can authenticate the file, so plain HTTP is refused and
    # redirects may not leave HTTPS. With a digest the bytes prove themselves; redirects still stay on http(s).
    if ($Url -like 'http://*' -and -not $Sha256) {
        throw "$Url is plain HTTP and no SHA-256 is approved, so the OVA can't be authenticated. Set the OVA SHA-256 (from the Broadcom download page) in Settings -> Holorouters, or use an https:// URL. Nothing was downloaded."
    }
    $proto = if ($Sha256) { '=http,https' } else { '=https' }
    $curl = @('-fsSL', '--retry', '3', '--connect-timeout', '20', '--proto', $proto, '--proto-redir', $proto)
    $caFile = $null
    if ($Url -like 'https://*') {
        if ($CaPem) {
            $caFile = [IO.Path]::GetTempFileName()
            Set-Content -Path $caFile -Value $CaPem
            $curl += @('--cacert', $caFile)
        } elseif ($Sha256) {
            $curl += '--insecure'
            Write-Host 'The depot certificate is not checked; the approved SHA-256 authenticates the file.'
        }
    }
    try {
        if ((Test-Path $dest) -and $Sha256) {
            $have = (Get-FileHash -Algorithm SHA256 -Path $dest).Hash.ToLower()
            if ($have -eq $Sha256.Trim().ToLower()) { Write-Host "Using the cached OVA (SHA-256 matches)" -ForegroundColor Green; return @{ path = $dest; cached = $true } }
            Write-Host 'The cached OVA does not match the approved SHA-256; downloading it again.'
        } elseif ((Test-Path $dest) -and -not $Sha256) {
            Remove-Item $dest -Force
        }
        $size = 0L
        $head = & curl @curl -I $Url 2>&1
        if ($LASTEXITCODE -ne 0) { throw "Could not reach $Url (curl $LASTEXITCODE): $(@($head) -join ' ')" }
        $len = @($head) -match '^content-length:' | Select-Object -Last 1
        if ($len) { $size = [long](($len -split ':', 2)[1].Trim()) }
        $free = [long]((& df -B1 --output=avail $HP_OvaDir | Select-Object -Last 1).Trim())
        if ($size -gt 0 -and $free -lt $size + 2GB) {
            throw "Not enough disk space for the OVA: it is $([math]::Round($size / 1GB, 1)) GB and $([math]::Round($free / 1GB, 1)) GB is free in $HP_OvaDir."
        }
        Write-Host "Downloading $Url$(if ($size) { " ($([math]::Round($size / 1GB, 1)) GB)" })"
        $part = "$dest.part"
        $out = & curl @curl -o $part $Url 2>&1
        if ($LASTEXITCODE -ne 0) { Remove-Item $part -ErrorAction SilentlyContinue; throw "Download failed (curl $LASTEXITCODE): $(@($out) -join ' ')" }
        if ($Sha256) {
            try { HP-AssertSha256 -Path $part -Expected $Sha256 } catch { Remove-Item $part -ErrorAction SilentlyContinue; throw }
        } else {
            Write-Host "SHA-256 of the download: $((Get-FileHash -Algorithm SHA256 -Path $part).Hash.ToLower())"
        }
        Move-Item -Force $part $dest
        Get-ChildItem $HP_OvaDir -File | Where-Object { $_.FullName -ne $dest } | Remove-Item -Force -ErrorAction SilentlyContinue
        Write-Host "OVA ready at $dest" -ForegroundColor Green
        return @{ path = $dest; cached = $false }
    } finally {
        if ($caFile) { Remove-Item $caFile -ErrorAction SilentlyContinue }
    }
}

function HP-WaitRouterReady {
    # Waits for a newly deployed Holorouter's first boot: SSH first, then its webtop (port 30000) answering.
    param([Parameter(Mandatory)][string]$Address, [int]$TimeoutMinutes = 45)
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    $phase = 'SSH'
    while ((Get-Date) -lt $deadline) {
        if ($phase -eq 'SSH') {
            if (Test-Connection -TargetName $Address -TcpPort 22 -Quiet -TimeoutSeconds 5 -ErrorAction SilentlyContinue) {
                Write-Host "SSH is up on $Address; waiting for first-boot setup (Kubernetes, webtop)"
                $phase = 'webtop'
                continue
            }
        } else {
            $code = (& curl -s -o /dev/null -m 10 -w '%{http_code}' "http://${Address}:30000/" 2>$null)
            if ("$code" -in '200', '401') { Write-Host "Webtop is answering on ${Address}:30000" -ForegroundColor Green; return }
        }
        Write-Host "Waiting for $phase on $Address ..."
        Start-Sleep -Seconds 30
    }
    throw "Timed out after $TimeoutMinutes minutes waiting for $phase on $Address."
}

# Every Holorouter OVA ships the same SSH host keys, so a pinned key can't tell routers apart (anyone with the
# OVA holds the private key). Onboarding gives each router its own keys. New keys are made in a temporary folder,
# swapped in, checked with `sshd -t` (the old keys come back if that fails) and loaded with a reload, which keeps
# existing sessions. Prints the new ed25519 fingerprint. DSA isn't offered by this OpenSSH and is left alone.
$global:HP_RekeyScript = @'
set -e
umask 077
new=$(mktemp -d); old=$(mktemp -d)
trap 'rm -rf "$new" "$old"' EXIT
for t in ed25519 ecdsa rsa; do ssh-keygen -q -t "$t" -N '' -C "root@$(hostname)" -f "$new/ssh_host_${t}_key"; done
for t in ed25519 ecdsa rsa; do cp -p "/etc/ssh/ssh_host_${t}_key" "/etc/ssh/ssh_host_${t}_key.pub" "$old/" 2>/dev/null || true; done
for t in ed25519 ecdsa rsa; do
  install -m 600 "$new/ssh_host_${t}_key" /etc/ssh/
  install -m 644 "$new/ssh_host_${t}_key.pub" /etc/ssh/
done
if ! sshd -t; then cp -p "$old"/* /etc/ssh/; echo "sshd rejected the new host keys; the old ones are back" >&2; exit 1; fi
ssh-keygen -E sha256 -lf /etc/ssh/ssh_host_ed25519_key.pub
systemctl reload sshd || systemctl restart sshd
'@

function HP-FingerprintIn([string]$Text) {
    [regex]::Match("$Text", 'SHA256:[A-Za-z0-9+/]{43}').Value
}

function HP-RenewHostKey {
    <#
      Gives a router its own SSH host keys over the portal's key-authenticated connection, then pins the new
      ed25519 key (read inside that same session) and proves a fresh strict connection works.
    #>
    param([Parameter(Mandatory)][string]$Address)
    Write-Host "Generating new SSH host keys on $Address (the OVA's shipped keys are the same on every router)"
    $out = HP-Ssh -Address $Address -Command $HP_RekeyScript
    $fp = HP-FingerprintIn ($out -join "`n")
    if (-not $fp) { throw "The router did not report its new host key: $($out -join ' ')" }
    Start-Sleep -Seconds 2
    $key = HP-PinHostKey -Address $Address -Fingerprint $fp
    HP-Ssh -Address $Address -Command 'true' | Out-Null
    Write-Host "New host key of $Address pinned: $key" -ForegroundColor Green
    return $key
}

function HP-ConnectTargetStrict {
    <#
      signs in to the configuration's vCenter like Holodeck's Connect-TargetHost, but without -Force
      and with PowerCLI refusing untrusted certificates for this session, so the credentials only go to a server
      whose certificate chains to the approved vCenter's CA (in the job's SSL_CERT_FILE) and names the host.
      Holodeck's own PowerCLI setting (user scope) is not changed.
    #>
    $t = $Global:config.Target
    if ("$($t.targetHostApiType)" -ne 'VirtualCenter') { throw 'Strict vCenter verification applies to vCenter targets only.' }
    Set-PowerCLIConfiguration -Scope Session -InvalidCertificateAction Fail -Confirm:$false | Out-Null
    try {
        $cred = [System.Management.Automation.PSCredential]::new($t.username, (ConvertTo-SecureString -String $t.password -AsPlainText -Force))
        try {
            Connect-VIServer -Server $t.hostname -Credential $cred -ErrorAction Stop | Out-Null
        } catch {
            throw "vCenter $($t.hostname) failed strict certificate verification, so its credentials were not sent ($($_.Exception.Message)). If vCenter's certificate authority changed, approve the certificate again in the capacity profile; an administrator can also turn off 'Verify the vCenter sign-in strictly' in Settings -> Holorouters."
        }
    } finally {
        # Later connections in this job (ESXi guest file transfers) keep Holodeck's behaviour.
        Set-PowerCLIConfiguration -Scope Session -InvalidCertificateAction Ignore -Confirm:$false | Out-Null
    }
    Write-Host "Signed in to vCenter $($t.hostname) with strict certificate verification" -ForegroundColor Green
}

function HP-ConnectVCenterPinned([string]$VCenterSha256) {
    # Reuses the job's vCenter session, or connects after checking the approved certificate.
    if ($global:DefaultVIServer -and $global:DefaultVIServer.IsConnected) { return }
    if ($VCenterSha256) {
        $vcHost = "$($Global:config.Target.hostname)"
        $live = HP-TlsThumbprint -HostName $vcHost
        if ($live.sha256 -ne $VCenterSha256.ToUpper()) { throw "the certificate of $vcHost is not the approved one" }
    }
    HP-ConnectTarget
}

function HP-OnboardDeployedRouter {
    <#
      Onboards a router the portal has just deployed. Preferred: entirely through vCenter (pinned certificate,
      VMware Tools inside the VM found by its inventory object): install the portal's key and give the router its
      own host keys, so the root password never travels over SSH. Without guest-operations rights it falls back to
      the administrator confirming the key on the console, the password onboarding, and a key renewal over SSH.
    #>
    param([Parameter(Mandatory)][string]$Address, [Parameter(Mandatory)][string]$VMName, [Parameter(Mandatory)][string]$PublicKey, [string]$VCenterSha256)
    if ($PublicKey -notmatch '^ssh-ed25519 [A-Za-z0-9+/=]+ [\w.@-]+$') { throw 'Unexpected public key format.' }
    $password = $env:HP_ROUTER_PASSWORD
    if (-not $password) { throw 'No root password was provided for the Holorouter.' }
    $fp = $null
    try {
        HP-ConnectVCenterPinned $VCenterSha256
        $vm = Get-VM -Name $VMName -ErrorAction Stop | Select-Object -First 1
        Write-Host "Onboarding $VMName through vCenter (VMware Tools): portal key and new SSH host keys"
        $script = "mkdir -p /root/.ssh && chmod 700 /root/.ssh && touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && " +
            "(grep -qxF '$PublicKey' /root/.ssh/authorized_keys || echo '$PublicKey' >> /root/.ssh/authorized_keys)`n" + $HP_RekeyScript
        $res = Invoke-VMScript -VM $vm -ScriptText $script -ScriptType Bash -GuestUser root -GuestPassword $password -ErrorAction Stop -WarningAction SilentlyContinue
        $fp = HP-FingerprintIn $res.ScriptOutput
        if ("$($res.ExitCode)" -ne '0' -or -not $fp) { throw "the guest script failed (exit $($res.ExitCode)): $("$($res.ScriptOutput)".Trim())" }
        Write-Host "vCenter reports the router's new ed25519 host key as $fp" -ForegroundColor Green
    } catch {
        $fp = $null
        $why = ("$($_.Exception.Message)" -replace [regex]::Escape($password), '********')
        Write-Host "Could not onboard through vCenter ($why); using the SSH onboarding with your confirmation instead." -ForegroundColor Yellow
    }
    if ($fp) {
        # The key is in place and the host key known from the authenticated channel: from here on SSH only has to work.
        # Never fall back to sending the password; retry briefly, then explain.
        $lastError = $null
        for ($try = 1; $try -le 6; $try++) {
            try {
                Start-Sleep -Seconds $(if ($try -eq 1) { 2 } else { 10 })
                $key = HP-PinHostKey -Address $Address -Fingerprint $fp
                $hostname = (HP-Ssh -Address $Address -Command 'hostname' | Select-Object -Last 1)
                Remove-Item env:HP_ROUTER_PASSWORD -ErrorAction SilentlyContinue
                HP-ClearOvfEnvironment $VMName
                Write-Host "Portal key installed and host key pinned; key login to $hostname works. The root password was not sent over SSH." -ForegroundColor Green
                return @{ hostname = "$hostname".Trim(); hostKey = $key; method = 'vcenter' }
            } catch {
                $lastError = $_.Exception.Message
                Write-Host "SSH to $Address not working yet (attempt $try of 6): $lastError"
            }
        }
        throw "The router was set up through vCenter (portal key installed, host key $fp), but SSH to $Address doesn't work: $lastError. " +
            'Small packets get through but larger ones may not: check the MTU on every hop (the Holorouter uses MTU 8000 on eth0; a nested ESXi vSwitch at 1500 drops larger frames). The root password was not sent over SSH.'
    }
    HP-ConfirmRouterHostKey -Address $Address -VMName $VMName -SkipVCenter | Out-Null
    $r = HP-RouterOnboard -Address $Address -PublicKey $PublicKey
    $key = HP-RenewHostKey -Address $Address
    if ($global:DefaultVIServer -and $global:DefaultVIServer.IsConnected) { HP-ClearOvfEnvironment $VMName }
    return @{ hostname = $r.hostname; hostKey = $key; method = 'administrator' }
}

function HP-ConfirmRouterHostKey {
    <#
      Establishes the SSH host key of a Holorouter the portal has just deployed before any password goes to it.
      First choice: ask vCenter (connection pinned to the approved certificate) to run ssh-keygen inside
      the VM through VMware Tools; that identifies the VM by its inventory object, not by whoever answers on the
      IP. This needs the vCenter account's guest-operations privileges. If that isn't possible, the job asks the
      administrator to compare the scanned fingerprint with the VM console, as an import does. Never trusts silently.
    #>
    param([Parameter(Mandatory)][string]$Address, [Parameter(Mandatory)][string]$VMName, [string]$VCenterSha256, [switch]$SkipVCenter)
    $global:HP_ConfirmedHostKey = $null
    $password = $env:HP_ROUTER_PASSWORD
    if (-not $password) { throw 'No root password was provided for the Holorouter.' }
    $why = 'skipped'
    try {
        if ($SkipVCenter) { throw 'guest operations already failed' }
        if (-not ($global:DefaultVIServer -and $global:DefaultVIServer.IsConnected)) {
            if ($VCenterSha256) {
                $vcHost = "$($Global:config.Target.hostname)"
                $live = HP-TlsThumbprint -HostName $vcHost
                if ($live.sha256 -ne $VCenterSha256.ToUpper()) { throw "the certificate of $vcHost is not the approved one" }
            }
            HP-ConnectTarget
        }
        $vm = Get-VM -Name $VMName -ErrorAction Stop | Select-Object -First 1
        Write-Host "Asking vCenter to read the SSH host key inside $VMName (VMware Tools)"
        $script = 'ssh-keygen -E sha256 -lf /etc/ssh/ssh_host_ed25519_key.pub'
        $res = Invoke-VMScript -VM $vm -ScriptText $script -ScriptType Bash -GuestUser root -GuestPassword $password -ErrorAction Stop -WarningAction SilentlyContinue
        $fp = [regex]::Match("$($res.ScriptOutput)", 'SHA256:[A-Za-z0-9+/]{43}').Value
        if (-not $fp) { throw "unexpected output from the guest: $("$($res.ScriptOutput)".Trim())" }
        Write-Host "vCenter reports the router's ed25519 host key as $fp" -ForegroundColor Green
        $global:HP_ConfirmedHostKey = $fp
        return @{ fingerprint = $fp; method = 'vcenter' }
    } catch {
        $why = ("$($_.Exception.Message)" -replace [regex]::Escape($password), '********')
    }

    # Fallback: the administrator compares the key with the VM console.
    Write-Host "Could not read the host key through vCenter ($why)." -ForegroundColor Yellow
    $lines = @(& ssh-keyscan -T 15 -t ed25519 $Address 2>$null | Where-Object { $_ -and $_ -notmatch '^#' })
    if (-not $lines) { throw "Could not read the SSH host key of $Address." }
    $tmp = [IO.Path]::GetTempFileName()
    try { $lines | Set-Content $tmp; $fp = ((& ssh-keygen -E sha256 -lf $tmp | Select-Object -First 1) -split ' ')[1] } finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
    Write-Host "$Address offers the ed25519 host key $fp."
    Write-Host "On the VM console of $VMName, sign in as root and run: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub"
    $answer = Read-Host "Does the router's console show $fp ? Type yes to trust it; anything else stops the deployment"
    if ("$answer".Trim() -notmatch '^(y|yes)$') { throw "The host key of $Address was not confirmed; the root password was not sent. The VM is left in place." }
    Write-Host "Host key $fp confirmed by the administrator" -ForegroundColor Green
    $global:HP_ConfirmedHostKey = $fp
    return @{ fingerprint = $fp; method = 'administrator' }
}

function HP-DeleteRouterVM {
    # Deletes a secondary Holorouter VM, found by name or (for imported routers) by its management IP.
    param([string]$VMName, [string]$IPAddress)
    HP-ConnectTarget
    $vms = if ($VMName) { @(Get-VM -Name $VMName -ErrorAction SilentlyContinue) }
           else { @(Get-VM | Where-Object { $_.Guest.IPAddress -contains $IPAddress }) }
    if ($vms.Count -eq 0) { Write-Host "No VM found for $VMName$IPAddress; nothing to delete" -ForegroundColor Yellow; return }
    if ($vms.Count -gt 1) { throw "More than one VM matches $VMName${IPAddress}: $(($vms.Name) -join ', ')" }
    $vm = $vms[0]
    if ($vm.PowerState -eq 'PoweredOn') { Write-Host "Powering off $($vm.Name)"; $vm = Stop-VM -VM $vm -Confirm:$false }
    Write-Host "Deleting $($vm.Name)"
    Remove-VM -VM $vm -DeletePermanently -Confirm:$false
}

function HP-StageFiles {
    <#
      Copies installation files from a source Holorouter that has them to another Holorouter with stage-file.sh
      (streamed through the portal, resumable, SHA-256 verified on both routers).
      Files: @(@{ version = '9.1.0.0'; name = '...' }).
    #>
    param([Parameter(Mandatory)][string]$Address, [Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][object[]]$Files)
    $bin = '/holodeck-runtime/bin'
    foreach ($f in $Files) {
        if ($f.version -notmatch '^[0-9]+(\.[0-9]+)*$' -or $f.name -notmatch '^[A-Za-z0-9._-]+$') { throw "Invalid staging entry $($f.version)/$($f.name)" }
    }
    $paths = @($Files | ForEach-Object { "'$bin/$($_.version)/$($_.name)'" }) -join ' '
    $statAll = "for f in $paths; do stat -c %s `"`$f`" 2>/dev/null || echo -1; done"
    $srcSizes = @(HP-Ssh -Address $Source -Command $statAll)
    $plan = for ($i = 0; $i -lt @($Files).Count; $i++) {
        $f = @($Files)[$i]
        $size = [long]$srcSizes[$i]
        if ($size -lt 0) { throw "$bin/$($f.version)/$($f.name) is not on the source router $Source." }
        [pscustomobject]@{ version = $f.version; name = $f.name; src = "$bin/$($f.version)/$($f.name)"; size = $size }
    }
    # Room for what isn't there yet (a matching file of the same size only needs verifying).
    $dstSizes = @(HP-Ssh -Address $Address -Command $statAll)
    $needed = 0
    for ($i = 0; $i -lt @($plan).Count; $i++) { if ([long]$dstSizes[$i] -ne @($plan)[$i].size) { $needed += @($plan)[$i].size } }
    $free = [long](HP-Ssh -Address $Address -Command 'df -B1 --output=avail /holodeck-runtime | tail -1')
    $margin = 5GB
    Write-Host ("Source {0}. {1:N1} GB to copy, {2:N1} GB free on {3}" -f $Source, ($needed / 1GB), ($free / 1GB), $Address)
    if ($needed + $margin -gt $free) { throw ("{0} needs {1:N1} GB free (with a 5 GB margin) but has {2:N1} GB." -f $Address, (($needed + $margin) / 1GB), ($free / 1GB)) }
    foreach ($p in $plan) {
        Write-Host ''
        & bash "$PSScriptRoot/stage-file.sh" $Address $Source $p.src "$bin/$($p.version)"
        if ($LASTEXITCODE -ne 0) { throw "Staging $($p.name) failed." }
    }
}
