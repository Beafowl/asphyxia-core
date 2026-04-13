# =============================================================================
# Asphyxia Custom Charts Sync Script
# Place this script next to your game executable (or anywhere you like).
# Edit the settings below, then run this instead of launching the game directly.
# =============================================================================

# --- SETTINGS (edit these) ---------------------------------------------------
$ServerUrl    = "http://localhost:8083"   # Asphyxia server URL
$GameRoot     = ""                        # Leave empty to auto-detect from script location
$GameExe      = "spice64.exe"             # Game launcher executable name
$GameArgs     = ""                        # Arguments to pass to the game
# -----------------------------------------------------------------------------

# Auto-detect game root from script location if not set
if (-not $GameRoot) {
    $GameRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$VersionFile = Join-Path $GameRoot ".asphyxia_custom_version"

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Asphyxia Custom Charts Sync" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Server:    $ServerUrl"
Write-Host "Game Root: $GameRoot"
Write-Host ""

# Step 1: Check server version
Write-Host "Checking for chart updates..." -NoNewline
try {
    $response = Invoke-RestMethod -Uri "$ServerUrl/api/nautica/version" -TimeoutSec 5
    $remoteVersion = $response.version
    $mixName = $response.mixName
} catch {
    Write-Host " SKIPPED (server unreachable)" -ForegroundColor Yellow
    Write-Host "Starting game without sync...`n"
    if (Test-Path (Join-Path $GameRoot $GameExe)) {
        Start-Process -FilePath (Join-Path $GameRoot $GameExe) -ArgumentList $GameArgs -WorkingDirectory $GameRoot
    }
    exit
}

if (-not $remoteVersion) {
    Write-Host " SKIPPED (no custom charts on server)" -ForegroundColor Yellow
    Write-Host "Starting game...`n"
    if (Test-Path (Join-Path $GameRoot $GameExe)) {
        Start-Process -FilePath (Join-Path $GameRoot $GameExe) -ArgumentList $GameArgs -WorkingDirectory $GameRoot
    }
    exit
}

# Step 2: Compare with local version
$localVersion = ""
if (Test-Path $VersionFile) {
    $localVersion = Get-Content $VersionFile -Raw
    $localVersion = $localVersion.Trim()
}

if ($localVersion -eq $remoteVersion) {
    Write-Host " UP TO DATE" -ForegroundColor Green
} else {
    if ($localVersion) {
        Write-Host " UPDATE AVAILABLE" -ForegroundColor Yellow
    } else {
        Write-Host " FIRST SYNC" -ForegroundColor Yellow
    }

    # Step 3: Download the custom charts ZIP
    $zipPath = Join-Path $env:TEMP "asphyxia_custom_charts.zip"
    Write-Host "Downloading custom charts..."

    try {
        Invoke-WebRequest -Uri "$ServerUrl/api/nautica/download-all" -OutFile $zipPath -TimeoutSec 120
    } catch {
        Write-Host "  Download failed: $_" -ForegroundColor Red
        Write-Host "Starting game without sync...`n"
        if (Test-Path (Join-Path $GameRoot $GameExe)) {
            Start-Process -FilePath (Join-Path $GameRoot $GameExe) -ArgumentList $GameArgs -WorkingDirectory $GameRoot
        }
        exit
    }

    # Step 4: Remove old custom charts folder and extract new one
    if (-not $mixName) { $mixName = "asphyxia_custom" }
    $customDir = Join-Path $GameRoot "data_mods\$mixName"

    if (Test-Path $customDir) {
        Write-Host "Removing old custom charts folder..."
        Remove-Item -Path $customDir -Recurse -Force
    }

    Write-Host "Extracting new charts..."
    Expand-Archive -Path $zipPath -DestinationPath $GameRoot -Force

    # Clean up zip
    Remove-Item -Path $zipPath -Force -ErrorAction SilentlyContinue

    # Save version
    Set-Content -Path $VersionFile -Value $remoteVersion

    # Count songs
    $musicDir = Join-Path $customDir "music"
    if (Test-Path $musicDir) {
        $songCount = (Get-ChildItem -Path $musicDir -Directory).Count
        Write-Host "  Synced $songCount custom chart(s)" -ForegroundColor Green
    } else {
        Write-Host "  Sync complete" -ForegroundColor Green
    }
}

# Step 5: Launch the game
Write-Host ""
$exePath = Join-Path $GameRoot $GameExe
if (Test-Path $exePath) {
    Write-Host "Starting game..." -ForegroundColor Cyan
    Start-Process -FilePath $exePath -ArgumentList $GameArgs -WorkingDirectory $GameRoot
} else {
    Write-Host "Game executable not found: $exePath" -ForegroundColor Red
    Write-Host "Edit the `$GameExe variable in this script to match your launcher."
}
