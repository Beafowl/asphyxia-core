# Build and deploy x64 binary to remote server

# Run the build
Write-Output "Running build..."
& "$PSScriptRoot\build-win.ps1"
if ($LASTEXITCODE -ne 0) {
    Write-Error "Build failed!"
    exit 1
}

# Deploy via SCP
$exe = "$PSScriptRoot\build\asphyxia-core-x64.exe"
if (-Not (Test-Path $exe)) {
    Write-Error "Build output not found: $exe"
    exit 1
}

$remote = "remote@26.30.13.75"
$remotePath = "C:\Users\Berk-WindowsVM\Desktop"

Write-Output "Deploying exe to remote server..."
scp "$exe" "${remote}:${remotePath}\"
if ($LASTEXITCODE -ne 0) {
    Write-Error "SCP exe failed!"
    exit 1
}

Write-Output "Deploying plugins to remote server..."
scp -r "$PSScriptRoot\plugins" "${remote}:${remotePath}\"
if ($LASTEXITCODE -ne 0) {
    Write-Error "SCP plugins failed!"
    exit 1
}

Write-Output "Deployed successfully."
