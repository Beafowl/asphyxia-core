# Getting version
$VER_CODE = Select-String -Path ".\src\utils\Consts.ts" -Pattern "VERSION = '(.*)'"
$VERSION = $VER_CODE.Matches.Groups[1].Value;

Write-Output "Building Version $VERSION for Windows"

# Prepare directories
New-Item -Path "." -Name "build" -ItemType "directory" -Force | Out-Null

Write-Output "NPM Install"
npm ci

# Building
Write-Output "Building Typescripts"
npx tsc

# Packing index.js
Write-Output "Packing index.js"
npx ncc build .\dist\AsphyxiaCore.js -o .\build-env --external pug --external ts-node

Write-Output "Setting Up Build Environment"
Set-Location -Path ".\build-env"
npm ci
Copy-Item -Recurse -Path "typescript" -Destination "node_modules/"

Set-Location -Path ".."

# @yao-pkg/pkg fetches Node 22 base binaries from yao-pkg/pkg-fetch GitHub
# releases on first build, then caches them under ~/.pkg-cache. The bumped
# Node is required for node:sqlite (added in Node 22.5; pkg 5.x topped out
# at Node 18 and the bundled v16 had no SQLite at all).
#
# `experimental-sqlite` is baked into the snapshot via --options so that
# end users running the .exe don't need to know about a Node flag —
# stable in Node 24 (ignored), required + warning-suppressed by
# --no-warnings on Node 22.x.
#
# Windows x86 (ia32) is dropped: yao-pkg-fetch doesn't ship 32-bit
# Windows prebuilts past Node 18, and Node itself stopped publishing
# them. Anyone still on 32-bit Windows can run the dev path from source.

Write-Output "Packing binaries"

# Packing x64
npx @yao-pkg/pkg .\build-env -t "node22-win-x64" -o .\build\asphyxia-core-x64 --options "no-warnings,experimental-sqlite"

# Replace the bundled Node.exe's icon with our own. resedit-cli rewrites
# the PE resource section in place — drops every existing RT_ICON /
# RT_GROUP_ICON entry and injects icon.ico in their slot. --allow-shrink
# is required because our icon's resource section is typically smaller
# than Node's. Skip silently if icon.ico isn't present so the build
# still works on a fresh checkout that hasn't dropped one in yet.
if (Test-Path ".\icon.ico") {
    Write-Output "Stamping icon.ico onto x64 exe"
    npx resedit --in ".\build\asphyxia-core-x64.exe" --out ".\build\asphyxia-core-x64.iconed.exe" --delete-allicon --icon ".\icon.ico" --allow-shrink
    Move-Item -Force ".\build\asphyxia-core-x64.iconed.exe" ".\build\asphyxia-core-x64.exe"
} else {
    Write-Output "icon.ico not found at repo root; skipping icon injection"
}

Compress-Archive -Path ".\build\asphyxia-core-x64.exe", ".\plugins" -DestinationPath ".\build\asphyxia-core-win-x64.zip" -Force
