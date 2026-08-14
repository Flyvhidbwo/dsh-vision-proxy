<#
.SYNOPSIS
    Release dsh-vision-proxy: bump version, git tag, push to GitHub, publish to npm.

.DESCRIPTION
    One-command release flow:
      1. guards: clean working tree, syntax check, npm auth (unless -SkipPublish)
      2. npm version <bump>  -> edits package.json, creates commit + tag vX.Y.Z
      3. git push origin main --tags  (on failure: rolls the bump back and aborts)
      4. npm publish         -> uses $env:NPM_TOKEN if set, otherwise your npm login

    Run from anywhere; the script anchors itself to the repo root.

.PARAMETER Version
    Semver bump: patch (default), minor, major, or an explicit version like 0.2.0.

.PARAMETER SkipPush
    Skip the GitHub push (bump + tag stay local).

.PARAMETER SkipPublish
    Skip the npm publish (bump + push only).

.EXAMPLE
    ./scripts/release.ps1              # patch release (0.1.3 -> 0.1.4)
    ./scripts/release.ps1 minor        # minor release (0.2.0)
    ./scripts/release.ps1 0.2.0        # explicit version
    ./scripts/release.ps1 -SkipPublish # bump + push, no npm publish
#>
param(
    [string]$Version = "patch",
    [switch]$SkipPush,
    [switch]$SkipPublish
)

$ErrorActionPreference = "Stop"

# Anchor to repo root (this file lives in <root>/scripts).
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Fail([string]$message) {
    Write-Error $message
    exit 1
}

Write-Host "==> dsh-vision-proxy release ($Version)" -ForegroundColor Cyan

# --- guards ----------------------------------------------------------------
if (git status --porcelain) { Fail "working tree is not clean - commit or stash first" }
node --check lib/index.js
if ($LASTEXITCODE -ne 0) { Fail "syntax check failed (lib/index.js)" }
node scripts/check-no-bom.js
if ($LASTEXITCODE -ne 0) { Fail "package.json has a UTF-8 BOM - rewrite it without BOM ([IO.File]::WriteAllText with UTF8Encoding(false))" }

if (-not $SkipPublish) {
    if (-not $env:NPM_TOKEN) {
        npm whoami *> $null
        if ($LASTEXITCODE -ne 0) {
            Fail "npm not authenticated - run 'npm login' or set NPM_TOKEN"
        }
    }
}

# --- bump ------------------------------------------------------------------
Write-Host "==> bumping version ($Version)" -ForegroundColor Cyan
npm version $Version
if ($LASTEXITCODE -ne 0) { Fail "npm version failed" }
$newVersion = (Get-Content package.json -Raw | ConvertFrom-Json).version
Write-Host "    new version: $newVersion" -ForegroundColor Green

# --- push ------------------------------------------------------------------
if (-not $SkipPush) {
    Write-Host "==> pushing to GitHub" -ForegroundColor Cyan
    git push origin main
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "push failed - rolling back the version bump"
        git reset --hard HEAD~1
        git tag -d "v$newVersion"
        Fail "push failed - bump rolled back (v$newVersion); fix connectivity and re-run"
    }
    # Push only the new tag: a bare `git push --tags` would also try to push
    # stale local tags and get rejected.
    git push origin "refs/tags/v$newVersion"
    if ($LASTEXITCODE -ne 0) { Fail "tag push failed - run 'git push origin refs/tags/v$newVersion' manually" }
}

# --- publish ---------------------------------------------------------------
if (-not $SkipPublish) {
    Write-Host "==> publishing to npm" -ForegroundColor Cyan
    $userConfig = $null
    try {
        if ($env:NPM_TOKEN) {
            $userConfig = Join-Path $env:TEMP "dsh-npmrc-$PID"
            Set-Content -Path $userConfig -Value '//registry.npmjs.org/:_authToken=${NPM_TOKEN}' -Encoding Ascii
            npm publish --userconfig $userConfig
        } else {
            npm publish
        }
        if ($LASTEXITCODE -ne 0) { Fail "npm publish failed" }
    } finally {
        if ($userConfig) { Remove-Item $userConfig -ErrorAction SilentlyContinue }
    }
}

Write-Host ""
Write-Host "==> done: dsh-vision-proxy@$newVersion" -ForegroundColor Green
if (-not $SkipPublish) {
    Write-Host "    npm:   https://www.npmjs.com/package/dsh-vision-proxy"
}
Write-Host "    github: https://github.com/Flyvhidbwo/dsh-vision-proxy/releases/tag/v$newVersion"
