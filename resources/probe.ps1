<#
.SYNOPSIS
  AgentCraft Launcher status probe. Reports what AgentCraft is actually running.

.DESCRIPTION
  Deliberately reuses AgentCraft's own helpers instead of re-implementing them: it
  dot-sources tools\lib\procs.ps1 and uses the same Read-JsonFile / Test-SameProc /
  Test-PortOpen / Get-LiveForeman / Find-GameJvm rules that tools\launch.ps1 and
  tools\stop.ps1 use, so the launcher reports the same view of the checkout.

  The result is written as UTF-8 JSON to -Out (not stdout) so the parent process never
  has to guess PowerShell's console code page.

.EXAMPLE
  powershell -NoProfile -File probe.ps1 -Root C:\code\agentcraft -Out %TEMP%\status.json
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$Profile = '',
    [string]$AgentHomePath = ''
)

$ErrorActionPreference = 'Stop'
$Result = [ordered]@{
    ok       = $false
    error    = $null
    root     = $Root
    logsDir  = $null
    runDir   = $null
    foremen  = @()
    game     = $null
    strayGame = $null
    liveProfile = $null
}

try {
    $Full = [System.IO.Path]::GetFullPath($Root)
    $Procs = Join-Path $Full 'tools\lib\procs.ps1'
    if (-not (Test-Path $Procs)) { throw "missing $Procs" }
    . $Procs

    $L = Get-AcLayout $Full
    $Result.root = $Full
    $Result.logsDir = $L.Logs
    $Result.runDir = $L.Run

    # --- Foreman run files written by launch.ps1 (spec/status files are not run files) ---
    $files = @(Get-ChildItem -Path $L.Run -Filter 'foreman-*.json' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notmatch '\.(spec|status)\.json$' })
    foreach ($file in $files) {
        $f = Read-JsonFile $file.FullName
        if (-not $f -or -not $f.pid) { continue }
        $pid0 = [int]$f.pid
        $alive = Test-SameProc $pid0 $f.startTime
        $port = $null
        $portOpen = $false
        if ($f.port) {
            $port = [int]$f.port
            $portOpen = Test-PortOpen $port
        }
        $entry = [ordered]@{
            profile   = [string]$f.profile
            pid       = $pid0
            port      = $port
            backend   = [string]$f.backend
            home      = [string]$f.home
            startTime = [string]$f.startTime
            alive     = [bool]$alive
            portOpen  = [bool]$portOpen
            owned     = [bool]$alive
        }
        $Result.foremen += $entry
    }

    # --- Minecraft run file ---
    $game = Read-JsonFile (Get-GameRunFile $L)
    if ($game) {
        $wrapperAlive = $false
        if ($game.wrapperPid) { $wrapperAlive = Test-SameProc ([int]$game.wrapperPid) $game.wrapperStart }
        $gamePid = 0
        if ($game.gamePid) { $gamePid = [int]$game.gamePid }
        $gameAlive = $false
        if ($gamePid) { $gameAlive = Test-SameProc $gamePid $game.gameStart }
        if (-not $gameAlive -and -not $wrapperAlive) {
            # stale run file: the same rule stop.ps1 applies before removing it
            $stray = Find-GameJvm $L
            if ($stray) {
                $Result.strayGame = [int]$stray.ProcessId
            }
            $game = $null
        }
    }
    if ($game) {
        $Result.game = [ordered]@{
            running     = $true
            gamePid     = $(if ($game.gamePid) { [int]$game.gamePid } else { $null })
            gradlePid   = $(if ($game.gradlePid) { [int]$game.gradlePid } else { $null })
            wrapperPid  = $(if ($game.wrapperPid) { [int]$game.wrapperPid } else { $null })
            devPort     = $(if ($game.devPort) { [int]$game.devPort } else { $null })
            foremanPort = $(if ($game.foremanPort) { [int]$game.foremanPort } else { $null })
            ready       = [bool]$game.ready
        }
    } else {
        $stray = Find-GameJvm $L
        if ($stray) { $Result.strayGame = [int]$stray.ProcessId }
    }

    # --- a live Foreman for the selected profile, even if this checkout never started it ---
    if ($Profile) {
        $agentHome = $AgentHomePath
        if (-not $agentHome) {
            if ($env:USERPROFILE) { $agentHome = Join-Path $env:USERPROFILE '.agentcraft' }
            else { $agentHome = Join-Path $Full '.agentcraft-home' }
        }
        $agentHome = Resolve-FullPath $agentHome
        $live = Get-LiveForeman $agentHome $Profile
        if ($live) {
            $already = $false
            foreach ($e in $Result.foremen) {
                if ($e.pid -eq [int]$live.pid) { $already = $true }
            }
            if (-not $already) {
                $Result.foremen += [ordered]@{
                    profile   = $Profile
                    pid       = [int]$live.pid
                    port      = $(if ($live.port) { [int]$live.port } else { $null })
                    backend   = $(if ($live.backend) { [string]$live.backend } else { $null })
                    home      = $agentHome
                    startTime = ''
                    alive     = $true
                    portOpen  = $true
                    owned     = $false
                }
            }
            $Result.liveProfile = [ordered]@{
                profile = $Profile
                pid     = [int]$live.pid
                port    = $(if ($live.port) { [int]$live.port } else { $null })
                backend = $(if ($live.backend) { [string]$live.backend } else { $null })
                home    = $agentHome
            }
        }
    }

    $Result.ok = $true
} catch {
    $Result.ok = $false
    $Result.error = $_.Exception.Message
}

$json = $Result | ConvertTo-Json -Depth 8 -Compress
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($Out, $json, $utf8)
exit $(if ($Result.ok) { 0 } else { 1 })