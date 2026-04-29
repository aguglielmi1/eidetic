# launch.ps1 - start eidetic, pulling updates and syncing deps only when needed
# Usage: right-click > Run with PowerShell, or: powershell -ExecutionPolicy Bypass -File launch.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step($msg) { Write-Host "`n>> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "   $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "   $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "   $msg" -ForegroundColor Red }

function Pause-Before-Exit {
    Write-Host ""
    Write-Host "Press Enter to close this window..." -ForegroundColor DarkGray
    try { [void](Read-Host) } catch {}
}

function Get-FileHashSafe($path) {
    if (Test-Path $path) { return (Get-FileHash $path -Algorithm SHA256).Hash }
    return ""
}

$script:launchFailed = $false
$pulled = $false
$changed = @{}

try {

Set-Location -Path $PSScriptRoot

Write-Host ""
Write-Host "  eidetic launcher" -ForegroundColor White
Write-Host "  ================" -ForegroundColor DarkGray
Write-Host "  (working in: $PSScriptRoot)" -ForegroundColor DarkGray
Write-Host ""

# --- 1. Check for repo updates ---------------------------------------

Write-Step "Checking for updates from GitHub"

try { git --version | Out-Null } catch {
    Write-Err "git not found. Install it from https://git-scm.com"
    throw "git missing"
}

# Files whose changes drive follow-up steps
$watched = @("package.json", "package-lock.json", "ingestion/requirements.txt")
$before = @{}
foreach ($f in $watched) { $before[$f] = Get-FileHashSafe $f }

$dirty = (git status --porcelain | Out-String).Trim()
if ($dirty) {
    Write-Warn "Working tree has uncommitted changes - skipping pull"
    Write-Host $dirty -ForegroundColor DarkGray
} else {
    git fetch --quiet
    if ($LASTEXITCODE -ne 0) { throw "git fetch failed" }

    $branch = (git rev-parse --abbrev-ref HEAD).Trim()
    $hasUpstream = $true
    try {
        git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { $hasUpstream = $false }
    } catch { $hasUpstream = $false }

    if (-not $hasUpstream) {
        Write-Warn "Branch '$branch' has no upstream configured - skipping pull"
    } else {
        $localHead  = (git rev-parse HEAD).Trim()
        $remoteHead = (git rev-parse '@{u}').Trim()

        if ($localHead -eq $remoteHead) {
            Write-Ok "Already up to date ($($localHead.Substring(0,7))) on $branch"
        } else {
            Write-Host "   Local:  $($localHead.Substring(0,7))" -ForegroundColor DarkGray
            Write-Host "   Remote: $($remoteHead.Substring(0,7))" -ForegroundColor DarkGray
            Write-Host "   Pulling latest changes..." -ForegroundColor White

            git pull --ff-only
            if ($LASTEXITCODE -ne 0) {
                Write-Err "git pull --ff-only failed. Resolve manually and re-run."
                throw "git pull failed"
            }

            $pulled = $true
            foreach ($f in $watched) {
                $after = Get-FileHashSafe $f
                if ($after -ne $before[$f]) { $changed[$f] = $true }
            }
            Write-Ok "Updated to $((git rev-parse HEAD).Trim().Substring(0,7))"
        }
    }
}

# --- 2. Node dependencies (install only if needed) -------------------

Write-Step "Checking Node dependencies"

$needsInstall = $false
$reason = ""
if (-not (Test-Path "node_modules")) {
    $needsInstall = $true
    $reason = "node_modules missing"
} elseif ($changed.ContainsKey("package.json") -or $changed.ContainsKey("package-lock.json")) {
    $needsInstall = $true
    $reason = "manifest changed"
}

if ($needsInstall) {
    Write-Host "   $reason - running npm install" -ForegroundColor White
    npm.cmd install
    if ($LASTEXITCODE -ne 0) { Write-Err "npm install failed"; throw "npm install failed" }
    Write-Ok "Dependencies installed"
} else {
    Write-Ok "node_modules in sync with lockfile"
}

# --- 3. Audit & fix vulnerabilities ----------------------------------

Write-Step "Auditing npm packages"

$total = -1
try {
    $auditJson = npm.cmd audit --json 2>$null | Out-String
    if ($auditJson.Trim()) {
        $audit = $auditJson | ConvertFrom-Json
        if ($audit.PSObject.Properties.Name -contains "metadata") {
            $total = [int]$audit.metadata.vulnerabilities.total
        }
    }
} catch {
    # parse failure - fall through to a plain run
}

if ($total -lt 0) {
    Write-Warn "Could not parse audit output; running npm audit fix anyway"
    npm.cmd audit fix
    if ($LASTEXITCODE -ne 0) { Write-Warn "npm audit fix exited non-zero; continuing" }
    else { Write-Ok "Audit fix run" }
} elseif ($total -eq 0) {
    Write-Ok "No vulnerabilities"
} else {
    Write-Warn "$total vulnerabilities found - running npm audit fix"
    npm.cmd audit fix
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "npm audit fix could not resolve everything; continuing"
    } else {
        Write-Ok "Audit fixes applied"
    }
}

# --- 4. Python dependencies (only if requirements.txt changed) ------

if ($changed.ContainsKey("ingestion/requirements.txt")) {
    Write-Step "Updating Python dependencies"
    $python = $null
    foreach ($cmd in "python", "python3") {
        try { & $cmd --version 2>&1 | Out-Null; if ($LASTEXITCODE -eq 0) { $python = $cmd; break } } catch {}
    }
    if ($python) {
        & $python -m pip install -r ingestion/requirements.txt
        if ($LASTEXITCODE -ne 0) { Write-Warn "pip install failed; continuing" }
        else { Write-Ok "Python deps synced" }
    } else {
        Write-Warn "Python not found - skipped"
    }
}

# --- 5. Build (only if updates pulled or .next missing) --------------

if ($pulled -or -not (Test-Path ".next")) {
    Write-Step "Building eidetic (production)"
    $buildReason = if ($pulled) { "updates pulled" } else { ".next missing" }
    Write-Host "   $buildReason - rebuilding" -ForegroundColor White
    npm.cmd run build
    if ($LASTEXITCODE -ne 0) { Write-Err "Build failed"; throw "npm run build failed" }
    Write-Ok "Build complete"
} else {
    Write-Step "Build"
    Write-Ok ".next is current - skipping rebuild"
}

# --- 5b. Verify Stalwart (if configured) -----------------------------

Write-Step "Checking Stalwart"

$stalwartState = "unconfigured"  # unconfigured / running / stopped / missing
$envFile = Join-Path $PSScriptRoot ".env.local"
$stalwartConfigured = $false
if (Test-Path $envFile) {
    $envContent = Get-Content $envFile -Raw
    if ($envContent -match "(?m)^STALWART_JMAP_URL\s*=\s*\S") {
        $stalwartConfigured = $true
    }
}

if (-not $stalwartConfigured) {
    Write-Ok "Stalwart not configured - email/calendar features disabled"
} else {
    $stalwartService = Get-Service -Name "Stalwart*" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $stalwartService) {
        $stalwartState = "missing"
        Write-Warn "STALWART_JMAP_URL is set but no 'Stalwart' Windows service is installed."
        Write-Warn "Re-run install.ps1 to install it, or clear the STALWART_* lines in .env.local."
    } elseif ($stalwartService.Status -ne "Running") {
        $stalwartState = "stopped"
        Write-Warn "Stalwart service is $($stalwartService.Status) - email/calendar features will be inert"
        Write-Warn "Start it with: Start-Service $($stalwartService.Name)"
    } else {
        $stalwartState = "running"
        Write-Ok "Stalwart active ($($stalwartService.Name))"
    }
}

# --- 6. Verify Tailscale Funnel --------------------------------------

Write-Step "Checking Tailscale Funnel"

$publicUrl = $null
$funnelState = "unknown"   # "active", "inactive", "no-tailscale"

$tsExe = $null
try { $tsExe = (Get-Command tailscale -ErrorAction Stop).Source } catch {}
if (-not $tsExe) {
    $defaultPath = "C:\Program Files\Tailscale\tailscale.exe"
    if (Test-Path $defaultPath) { $tsExe = $defaultPath }
}

if (-not $tsExe) {
    $funnelState = "no-tailscale"
    Write-Warn "Tailscale not installed - app will only be reachable on your LAN"
} else {
    # Resolve this device's public DNS name via `tailscale status --json`
    $dnsName = $null
    try {
        $statusJson = & $tsExe status --json 2>$null | Out-String
        if ($statusJson.Trim()) {
            $parsed = $statusJson | ConvertFrom-Json
            if ($parsed.Self -and $parsed.Self.DNSName) {
                $dnsName = $parsed.Self.DNSName.TrimEnd(".")
            }
        }
    } catch {}

    # `tailscale funnel status` prints the active serve config if any
    $funnelStatus = & $tsExe funnel status 2>$null | Out-String
    $funnelOnPort3000 = $funnelStatus -match "3000"

    if ($funnelOnPort3000 -and $dnsName) {
        $publicUrl = "https://$dnsName"
        $funnelState = "active"
        Write-Ok "Funnel active on port 3000"
        # Refresh cached URL for next time
        Set-Content -Path (Join-Path $PSScriptRoot "public-url.txt") -Value $publicUrl -Encoding UTF8

        # Phase 16: if the serve config carries a /dav mapping, verify it's
        # actually reachable. Helps catch a half-configured state where the
        # mapping exists locally but Funnel propagation broke.
        if ($funnelStatus -match "/dav" -and $stalwartConfigured) {
            try {
                $davResp = Invoke-WebRequest -Uri "$publicUrl/dav/.well-known/caldav" `
                    -Method GET -UseBasicParsing -MaximumRedirection 0 `
                    -TimeoutSec 15 -ErrorAction SilentlyContinue
                if ($davResp -and ($davResp.StatusCode -in 200, 301, 302, 401)) {
                    Write-Ok "CalDAV reachable from internet at $publicUrl/dav"
                } else {
                    Write-Warn "CalDAV /dav mapping exists but didn't respond as expected"
                }
            } catch {
                $exResp = $null
                try { $exResp = $_.Exception.Response } catch {}
                if ($exResp -and ([int]$exResp.StatusCode -in 301, 302, 401)) {
                    Write-Ok "CalDAV reachable from internet at $publicUrl/dav"
                } else {
                    Write-Warn "CalDAV /dav check failed - iPhone sync may not work"
                }
            }
        }
    } else {
        $funnelState = "inactive"
        Write-Warn "Funnel is not active on port 3000"
        Write-Warn "To re-enable: tailscale funnel --bg 3000  (or re-run install.ps1)"
    }
}

# --- 7. Start --------------------------------------------------------

Write-Host ""
Write-Host "  ==============================================" -ForegroundColor DarkGray
Write-Host "  Starting eidetic" -ForegroundColor Green
Write-Host ""
Write-Host "  Local URL:  http://localhost:3000" -ForegroundColor White

if ($publicUrl) {
    Write-Host "  Public URL: $publicUrl" -ForegroundColor Green
} elseif (Test-Path "public-url.txt") {
    $cachedUrl = (Get-Content "public-url.txt" -Raw).Trim()
    if ($cachedUrl) {
        if ($funnelState -eq "inactive") {
            Write-Host "  Public URL: $cachedUrl (funnel currently OFF)" -ForegroundColor Yellow
        } else {
            Write-Host "  Public URL: $cachedUrl" -ForegroundColor White
        }
    }
}

switch ($stalwartState) {
    "running"      { Write-Host "  Stalwart:   active" -ForegroundColor Green }
    "stopped"      { Write-Host "  Stalwart:   stopped (email/calendar inert)" -ForegroundColor Yellow }
    "missing"      { Write-Host "  Stalwart:   configured but not installed" -ForegroundColor Yellow }
    default        { }
}

Write-Host ""
Write-Host "  Press Ctrl+C to stop" -ForegroundColor DarkGray
Write-Host "  ==============================================" -ForegroundColor DarkGray
Write-Host ""

npm.cmd start

} catch {
    Write-Host ""
    Write-Host "  ==============================================" -ForegroundColor DarkGray
    Write-Host "  Launch failed" -ForegroundColor Red
    Write-Host ""
    Write-Host "  Reason: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.InvocationInfo -and $_.InvocationInfo.PositionMessage) {
        Write-Host ""
        Write-Host $_.InvocationInfo.PositionMessage -ForegroundColor DarkGray
    }
    Write-Host "  ==============================================" -ForegroundColor DarkGray
    $script:launchFailed = $true
} finally {
    Pause-Before-Exit
    if ($script:launchFailed) { exit 1 }
}
