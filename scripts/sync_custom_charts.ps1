# =============================================================================
# Asphyxia Custom Charts Sync Script
# Place this script next to your game executable (or anywhere you like).
# Edit the settings below, then run this instead of launching the game directly.
#
# This version does a differential sync:
#   - Downloads only charts that are missing or have been re-converted.
#   - Deletes local charts that the server has removed.
#   - Refreshes music_db.merged.xml on every sync.
# Per-chart zips live on Google Drive (configured in the plugin settings),
# so downloads come straight from Google's CDN rather than the Asphyxia server.
# =============================================================================

# --- SETTINGS (edit these) ---------------------------------------------------
$ServerUrl    = "http://localhost:8083"   # Asphyxia server URL
$GameRoot     = ""                        # Leave empty to auto-detect from script location
$GameExe      = "spice64.exe"             # Game launcher executable name
$GameArgs     = ""                        # Arguments to pass to the game
# -----------------------------------------------------------------------------

if (-not $GameRoot) {
    $GameRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
}

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Asphyxia Custom Charts Sync" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Server:    $ServerUrl"
Write-Host "Game Root: $GameRoot"
Write-Host ""

function Start-Game {
    $exePath = Join-Path $GameRoot $GameExe
    if (Test-Path $exePath) {
        Write-Host ""
        Write-Host "Starting game..." -ForegroundColor Cyan
        if ($GameArgs) { Start-Process -FilePath $exePath -ArgumentList $GameArgs -WorkingDirectory $GameRoot }
        else { Start-Process -FilePath $exePath -WorkingDirectory $GameRoot }
    } else {
        Write-Host "Game executable not found: $exePath" -ForegroundColor Red
        Write-Host "Edit the `$GameExe variable in this script to match your launcher."
    }
}

# Step 1: Fetch manifest from server
Write-Host "Fetching chart manifest..." -NoNewline
try {
    $manifest = Invoke-RestMethod -Uri "$ServerUrl/api/nautica/manifest" -TimeoutSec 10
} catch {
    Write-Host " FAILED (server unreachable)" -ForegroundColor Yellow
    Write-Host "Starting game without sync..."
    Start-Game
    exit
}
Write-Host " OK" -ForegroundColor Green

$mixName = if ($manifest.mixName) { $manifest.mixName } else { "asphyxia_custom" }
$serverCharts = @($manifest.charts)

$customDir = Join-Path $GameRoot "data_mods\$mixName"
$musicDir  = Join-Path $customDir "music"
$thumbDir  = Join-Path $customDir "graphics\s_jacket00_ifs"
$xmlDir    = Join-Path $customDir "others"
$stateFile = Join-Path $customDir ".asphyxia_sync_state.json"

# Ensure dirs exist (so a clean machine still works)
foreach ($d in @($customDir, $musicDir, $thumbDir, $xmlDir)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

# Step 2: Scan local installed charts
$installedMids = @{}
if (Test-Path $musicDir) {
    Get-ChildItem -Path $musicDir -Directory | ForEach-Object {
        if ($_.Name -match '^(\d+)_') {
            $installedMids[[int]$matches[1]] = $_.Name
        }
    }
}

# Step 3: Load sync state (convertedAt per mid); initialize on first run
$localState = @{}
if (Test-Path $stateFile) {
    try {
        $raw = Get-Content $stateFile -Raw | ConvertFrom-Json
        foreach ($prop in $raw.PSObject.Properties) {
            $localState[[int]$prop.Name] = [long]$prop.Value
        }
    } catch {
        Write-Host "  (state file corrupt, rebuilding)" -ForegroundColor Yellow
    }
}

# For any installed chart missing from state, mark it as up-to-date at the server's current convertedAt
# so we don't force-redownload on first run after migrating from the old sync script.
foreach ($mid in $installedMids.Keys) {
    if (-not $localState.ContainsKey([int]$mid)) {
        $serverEntry = $serverCharts | Where-Object { [int]$_.mid -eq [int]$mid } | Select-Object -First 1
        if ($serverEntry) {
            $localState[[int]$mid] = [long]$serverEntry.convertedAt
        } else {
            $localState[[int]$mid] = 0
        }
    }
}

# Step 4: Diff
$serverMidSet = @{}
foreach ($c in $serverCharts) { $serverMidSet[[int]$c.mid] = $true }

$toDownload = @()
foreach ($c in $serverCharts) {
    $mid = [int]$c.mid
    $serverConv = [long]$c.convertedAt
    $localConv  = if ($localState.ContainsKey($mid)) { [long]$localState[$mid] } else { 0 }
    $needsFetch = (-not $installedMids.ContainsKey($mid)) -or ($serverConv -gt $localConv)
    if ($needsFetch) {
        if ($c.downloadUrl) {
            $toDownload += $c
        } else {
            Write-Host ("  Skipping {0} (ID {1}) \u2014 server has not uploaded it to Drive yet" -f $c.title, $mid) -ForegroundColor DarkYellow
        }
    }
}

$toDelete = @()
foreach ($mid in $installedMids.Keys) {
    if (-not $serverMidSet.ContainsKey([int]$mid)) {
        $toDelete += [int]$mid
    }
}

if ($toDownload.Count -eq 0 -and $toDelete.Count -eq 0) {
    Write-Host "Already up to date." -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host ("Plan: {0} new/updated, {1} to delete" -f $toDownload.Count, $toDelete.Count) -ForegroundColor Cyan

    # Step 5: Delete removed charts
    foreach ($mid in $toDelete) {
        $idStr = "{0:D4}" -f $mid
        Write-Host ("  Deleting {0}..." -f $installedMids[$mid])
        $songFolder = Join-Path $musicDir $installedMids[$mid]
        if (Test-Path $songFolder) { Remove-Item -Path $songFolder -Recurse -Force }
        if (Test-Path $thumbDir) {
            Get-ChildItem -Path $thumbDir -Filter ("jk_{0}_*" -f $idStr) | ForEach-Object {
                Remove-Item -Path $_.FullName -Force -ErrorAction SilentlyContinue
            }
        }
        $localState.Remove([int]$mid) | Out-Null
    }

    # Step 6: Download new/updated charts
    $ProgressPreference = 'SilentlyContinue'
    $ok = 0
    $failed = 0
    foreach ($c in $toDownload) {
        $mid = [int]$c.mid
        $idStr = "{0:D4}" -f $mid
        Write-Host ("  Downloading [{0}] {1}..." -f $idStr, $c.title) -NoNewline

        # If an older version is installed, drop its folder first so we don't keep stale files
        if ($installedMids.ContainsKey($mid)) {
            $oldFolder = Join-Path $musicDir $installedMids[$mid]
            if (Test-Path $oldFolder) { Remove-Item -Path $oldFolder -Recurse -Force }
            if (Test-Path $thumbDir) {
                Get-ChildItem -Path $thumbDir -Filter ("jk_{0}_*" -f $idStr) | ForEach-Object {
                    Remove-Item -Path $_.FullName -Force -ErrorAction SilentlyContinue
                }
            }
        }

        $zipPath = Join-Path $env:TEMP ("asphyxia_chart_{0}.zip" -f $idStr)
        $url = $c.downloadUrl
        if ($url -like "https://drive.google.com/*" -and $url -notmatch "confirm=") {
            $url += "&confirm=t"
        }

        try {
            Invoke-WebRequest -Uri $url -OutFile $zipPath -TimeoutSec 180 -UseBasicParsing
            # Sanity check — Drive sometimes returns HTML when the quota is exhausted
            $bytes = [System.IO.File]::ReadAllBytes($zipPath) | Select-Object -First 2
            if ($bytes.Count -lt 2 -or $bytes[0] -ne 0x50 -or $bytes[1] -ne 0x4B) {
                throw "Downloaded file is not a zip (Drive may have returned an HTML interstitial)."
            }
            Expand-Archive -Path $zipPath -DestinationPath $customDir -Force
            Remove-Item -Path $zipPath -Force -ErrorAction SilentlyContinue
            $localState[$mid] = [long]$c.convertedAt
            $ok++
            Write-Host " OK" -ForegroundColor Green
        } catch {
            $failed++
            Write-Host (" FAILED: {0}" -f $_.Exception.Message) -ForegroundColor Red
            if (Test-Path $zipPath) { Remove-Item -Path $zipPath -Force -ErrorAction SilentlyContinue }
        }
    }
    $ProgressPreference = 'Continue'

    # Step 7: Refresh merged XML (reflects the current server-side set of charts)
    try {
        $xmlUrl = "$ServerUrl/api/nautica/music-db-xml"
        $xmlPath = Join-Path $xmlDir "music_db.merged.xml"
        Invoke-WebRequest -Uri $xmlUrl -OutFile $xmlPath -TimeoutSec 30 -UseBasicParsing
        Write-Host "  Refreshed music_db.merged.xml" -ForegroundColor Green
    } catch {
        Write-Host "  Could not refresh music_db.merged.xml (game may still work if the existing one is close enough)" -ForegroundColor Yellow
    }

    # Step 8: Persist state
    $stateObj = @{}
    foreach ($k in $localState.Keys) { $stateObj["$k"] = $localState[$k] }
    $stateObj | ConvertTo-Json -Depth 2 | Set-Content -Path $stateFile -Encoding UTF8

    Write-Host ""
    Write-Host ("Sync done: {0} downloaded, {1} deleted, {2} failed" -f $ok, $toDelete.Count, $failed) -ForegroundColor Cyan
}

Start-Game
