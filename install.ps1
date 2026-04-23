# install.ps1 - one-shot setup for eidetic on Windows
# Usage: right-click > Run with PowerShell, or: powershell -ExecutionPolicy Bypass -File install.ps1

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

function Update-SessionPath {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machinePath;$userPath"
}

$script:installFailed = $false

try {

Set-Location -Path $PSScriptRoot

Write-Host ""
Write-Host "  eidetic installer" -ForegroundColor White
Write-Host "  =================" -ForegroundColor DarkGray
Write-Host "  (script in: $PSScriptRoot)" -ForegroundColor DarkGray
Write-Host ""

# -- 0. Locate the eidetic repo --------------------------------------
# If install.ps1 was run standalone (e.g. from a Downloads folder) there's
# no package.json next to it. Install git if missing, clone the repo into
# a subfolder, and continue from there.

$repoRoot = $PSScriptRoot

if (-not (Test-Path (Join-Path $repoRoot "package.json"))) {
    Write-Step "Locating eidetic repo"

    $repoUrl = "https://github.com/aguglielmi1/eidetic.git"
    $cloneTarget = Join-Path $PSScriptRoot "eidetic"

    if (Test-Path (Join-Path $cloneTarget "package.json")) {
        Write-Ok "Using existing clone at $cloneTarget"
        $repoRoot = $cloneTarget
    } elseif (Test-Path $cloneTarget) {
        Write-Err "Directory '$cloneTarget' exists but isn't a valid eidetic checkout."
        Write-Err "Remove or rename it, then re-run this script."
        throw "Clone target occupied"
    } else {
        $gitOk = $false
        try { $null = git --version 2>&1; $gitOk = $true } catch {}

        if (-not $gitOk) {
            Write-Host "   Git not found - installing via winget..." -ForegroundColor White
            winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements
            if ($LASTEXITCODE -ne 0) {
                Write-Err "winget install failed. Install Git manually from https://git-scm.com and re-run this script."
                throw "Git install failed"
            }
            Update-SessionPath
            try { $null = git --version 2>&1 } catch {
                Write-Err "Git installed but 'git' is not on PATH in this session."
                Write-Err "Close this window, open a new PowerShell, and re-run install.ps1."
                throw "Git post-install missing"
            }
        }

        Write-Host "   Cloning $repoUrl" -ForegroundColor White
        Write-Host "   into $cloneTarget ..." -ForegroundColor White
        git clone $repoUrl $cloneTarget
        if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
        Write-Ok "Cloned"
        $repoRoot = $cloneTarget
    }

    Set-Location -Path $repoRoot
    Write-Ok "Working in: $repoRoot"
}

# -- 1. Check prerequisites ------------------------------------------

Write-Step "Checking prerequisites"

# Node.js (must be installed by the user - we don't auto-install this one)
try {
    $nodeVersion = (node --version 2>&1).ToString().Trim()
    Write-Ok "Node.js $nodeVersion"
} catch {
    Write-Err "Node.js not found. Install it from https://nodejs.org and re-run this script."
    throw "Node.js missing"
}

function Find-Python {
    foreach ($cmd in "python", "python3") {
        try {
            $pyVer = (& $cmd --version 2>&1).ToString().Trim()
            if ($pyVer -match "Python\s+\d") {
                return [pscustomobject]@{ Cmd = $cmd; Version = $pyVer }
            }
        } catch {}
    }
    return $null
}

# Python
$py = Find-Python
if ($py) {
    Write-Ok "$($py.Version) ($($py.Cmd))"
    $python = $py.Cmd
} else {
    Write-Host "   Python not found - installing via winget..." -ForegroundColor White
    winget install --id Python.Python.3.12 -e --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        Write-Err "winget install failed. Install Python manually from https://python.org and re-run this script."
        throw "Python install failed"
    }

    Update-SessionPath
    $py = Find-Python
    if ($py) {
        Write-Ok "$($py.Version) ($($py.Cmd))"
        $python = $py.Cmd
    } else {
        Write-Err "Python installed but not on PATH in this session."
        Write-Err "Close this window, open a new PowerShell, and re-run install.ps1."
        throw "Python post-install missing"
    }
}

# Ollama
$ollamaOk = $false
try {
    $null = ollama --version 2>&1
    Write-Ok "Ollama found"
    $ollamaOk = $true
} catch {}

if (-not $ollamaOk) {
    Write-Host "   Ollama not found - installing via winget..." -ForegroundColor White
    winget install --id Ollama.Ollama -e --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        Write-Err "winget install failed. Install Ollama manually from https://ollama.com and re-run this script."
        throw "Ollama install failed"
    }

    Update-SessionPath
    # Ollama installs a background service - give it a moment to start
    Start-Sleep -Seconds 3

    try {
        $null = ollama --version 2>&1
        Write-Ok "Ollama found"
    } catch {
        Write-Err "Ollama installed but 'ollama' is not on PATH in this session."
        Write-Err "Close this window, open a new PowerShell, and re-run install.ps1."
        throw "Ollama post-install missing"
    }
}

# -- 2. Install Node dependencies ------------------------------------

Write-Step "Installing Node dependencies"
npm.cmd install
if ($LASTEXITCODE -ne 0) { Write-Err "npm install failed"; throw "npm install failed" }
Write-Ok "Done"

# -- 3. Install Python dependencies ----------------------------------

Write-Step "Installing Python dependencies"
& $python -m pip install -r ingestion/requirements.txt
if ($LASTEXITCODE -ne 0) { Write-Err "pip install failed"; throw "pip install failed" }
Write-Ok "Done"

# -- 4. Choose Ollama model based on VRAM ----------------------------

Write-Step "Choosing LLM model"
Write-Host ""
Write-Host "   How much GPU VRAM do you have?" -ForegroundColor White
Write-Host ""
Write-Host "   [1] 8 GB or less    (laptop / budget GPU)      -> gemma4:e4b" -ForegroundColor DarkGray
Write-Host "   [2] 12-16 GB        (RTX 4070, 5060 Ti, etc.)  -> gemma4:26b" -ForegroundColor DarkGray
Write-Host "   [3] 24-32 GB        (RTX 4090, 5090, etc.)     -> gemma4:31b" -ForegroundColor DarkGray
Write-Host ""

do {
    $choice = Read-Host "   Enter 1, 2, or 3"
} while ($choice -notin "1", "2", "3")

switch ($choice) {
    "1" { $model = "gemma4:e4b"; $label = "gemma4:e4b (edge 4B)" }
    "2" { $model = "gemma4:26b"; $label = "gemma4:26b (26B MoE)" }
    "3" { $model = "gemma4:31b"; $label = "gemma4:31b (31B dense)" }
}

Write-Ok "Selected: $label"

# -- 5. Pull models --------------------------------------------------

Write-Step "Pulling $model (this may take a while)"
ollama pull $model
if ($LASTEXITCODE -ne 0) { Write-Err "Failed to pull $model"; throw "ollama pull $model failed" }
Write-Ok "$model ready"

Write-Step "Pulling embedding model (nomic-embed-text)"
ollama pull nomic-embed-text
if ($LASTEXITCODE -ne 0) { Write-Err "Failed to pull nomic-embed-text"; throw "ollama pull nomic-embed-text failed" }
Write-Ok "nomic-embed-text ready"

# -- 6. Generate secrets & write .env.local --------------------------

Write-Step "Generating configuration"

$envFile = Join-Path $repoRoot ".env.local"

# Generate a random 32-byte hex secret
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$authSecret = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""

$envContent = @"
# Generated by install.ps1
AUTH_SECRET=$authSecret
OLLAMA_MODEL=$model
"@

Set-Content -Path $envFile -Value $envContent -Encoding UTF8
Write-Ok ".env.local written"

# -- 7. Build --------------------------------------------------------

Write-Step "Building eidetic (production)"
npm.cmd run build
if ($LASTEXITCODE -ne 0) { Write-Err "Build failed"; throw "npm run build failed" }
Write-Ok "Build complete"

# -- 7b. Stalwart (optional: email + calendar backbone) --------------

Write-Step "Setting up Stalwart (email + calendar backbone)"

Write-Host ""
Write-Host "   Stalwart is a local mail + CalDAV server that pulls your Outlook" -ForegroundColor White
Write-Host "   mail on a schedule and hosts a calendar iPhone / Thunderbird can" -ForegroundColor White
Write-Host "   sync with. Eidetic then indexes both for RAG + LLM tool calls." -ForegroundColor White
Write-Host ""
Write-Host "   Cost: a Windows service (~200 MB RAM) + storage/stalwart/ folder." -ForegroundColor White
Write-Host "   You can skip this and still use all document-ingestion features." -ForegroundColor White
Write-Host ""

$wantsStalwart = Read-Host "   Set up Stalwart for email + calendar? [y/N]"

if ($wantsStalwart -notmatch "^[Yy]") {
    Write-Warn "Skipped Stalwart - email/calendar features will be inert"
} else {
    try {
        # Check if the service already exists
        $stalwartService = Get-Service -Name "Stalwart*" -ErrorAction SilentlyContinue | Select-Object -First 1

        if ($stalwartService) {
            Write-Ok "Stalwart service already installed ($($stalwartService.Name): $($stalwartService.Status))"
            if ($stalwartService.Status -ne "Running") {
                Write-Host "   Starting Stalwart service..." -ForegroundColor White
                Start-Service -Name $stalwartService.Name
                Start-Sleep -Seconds 2
            }
        } else {
            Write-Host "   Installing Stalwart via winget..." -ForegroundColor White
            winget install --id Stalwart.Mail -e --accept-package-agreements --accept-source-agreements
            if ($LASTEXITCODE -ne 0) {
                Write-Err "winget install failed. Winget may not have a manifest for Stalwart yet."
                Write-Err "Install manually from https://stalw.art/download and re-run this script."
                throw "Stalwart install failed"
            }
            Update-SessionPath
            # Give the service a moment to register and start
            Start-Sleep -Seconds 5
            $stalwartService = Get-Service -Name "Stalwart*" -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $stalwartService) {
                Write-Err "Stalwart installed but the Windows service wasn't registered."
                Write-Err "Reboot and re-run this script, or check the installer log."
                throw "Stalwart service missing"
            }
            if ($stalwartService.Status -ne "Running") { Start-Service -Name $stalwartService.Name }
            Write-Ok "Stalwart service installed ($($stalwartService.Name))"
        }

        # Poll admin port (default 8080) — wait up to 60s
        Write-Host "   Waiting for Stalwart admin on http://localhost:8080 ..." -ForegroundColor White
        $adminUp = $false
        for ($i = 0; $i -lt 30; $i++) {
            try {
                $r = Invoke-WebRequest -Uri "http://localhost:8080" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
                if ($r.StatusCode -lt 500) { $adminUp = $true; break }
            } catch {
                # Stalwart may answer 401/403 before we have credentials — that still counts as up
                $msg = $_.Exception.Message
                if ($msg -match "401|403|Unauthorized|Forbidden") { $adminUp = $true; break }
            }
            Start-Sleep -Seconds 2
        }

        if (-not $adminUp) {
            Write-Err "Stalwart admin port 8080 isn't responding after 60s."
            Write-Err "Check 'Get-Service $($stalwartService.Name)' and the Stalwart logs."
            throw "Stalwart admin unreachable"
        }
        Write-Ok "Admin port responsive"

        Write-Host ""
        Write-Host "   Stalwart's first-run wizard needs a browser interaction to create" -ForegroundColor White
        Write-Host "   the admin principal and the single mailbox. Opening it now..." -ForegroundColor White
        Write-Host ""
        Write-Host "   In the browser:" -ForegroundColor White
        Write-Host "     1. Create the admin account (pick a strong password - you'll paste it here)" -ForegroundColor White
        Write-Host "     2. Create ONE user mailbox - any username is fine; the password you set" -ForegroundColor White
        Write-Host "        for this user is what Eidetic will use." -ForegroundColor White
        Write-Host "     3. Under 'Fetched accounts' (or IMAP import), add your Outlook IMAP" -ForegroundColor White
        Write-Host "        credentials (outlook.office365.com:993, app password, poll every" -ForegroundColor White
        Write-Host "        5 minutes)." -ForegroundColor White
        Write-Host ""
        try { Start-Process "http://localhost:8080" } catch {}

        $stalwartUser = Read-Host "   Stalwart mailbox username"
        $stalwartPassRaw = Read-Host "   Stalwart mailbox password" -AsSecureString
        $stalwartPass = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($stalwartPassRaw)
        )

        if (-not $stalwartUser -or -not $stalwartPass) {
            Write-Err "Username and password are required to wire Stalwart into Eidetic."
            throw "Stalwart credentials missing"
        }

        # Append Stalwart env vars to .env.local (.env.local exists from step 6)
        $jmapUrl   = "http://localhost:8080/jmap"
        $caldavUrl = "http://localhost:8080/dav"
        Add-Content -Path $envFile -Value "" -Encoding UTF8
        Add-Content -Path $envFile -Value "# Stalwart (email + calendar)" -Encoding UTF8
        Add-Content -Path $envFile -Value "STALWART_JMAP_URL=$jmapUrl" -Encoding UTF8
        Add-Content -Path $envFile -Value "STALWART_CALDAV_URL=$caldavUrl" -Encoding UTF8
        Add-Content -Path $envFile -Value "STALWART_USERNAME=$stalwartUser" -Encoding UTF8
        Add-Content -Path $envFile -Value "STALWART_PASSWORD=$stalwartPass" -Encoding UTF8
        Write-Ok "Wrote STALWART_* to .env.local"

        # Generate VAPID keypair for Web Push (Step 53) — node script ships with web-push
        Write-Host "   Generating VAPID keys for Web Push..." -ForegroundColor White
        $vapidOutput = & node -e "const w=require('web-push');const k=w.generateVAPIDKeys();console.log(k.publicKey);console.log(k.privateKey);" 2>&1 | Out-String
        $vapidLines = $vapidOutput.Trim().Split("`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ }
        if ($vapidLines.Count -ge 2) {
            Add-Content -Path $envFile -Value "" -Encoding UTF8
            Add-Content -Path $envFile -Value "# Web Push (Phase 14 notifications)" -Encoding UTF8
            Add-Content -Path $envFile -Value "VAPID_PUBLIC_KEY=$($vapidLines[0])" -Encoding UTF8
            Add-Content -Path $envFile -Value "VAPID_PRIVATE_KEY=$($vapidLines[1])" -Encoding UTF8
            Add-Content -Path $envFile -Value "VAPID_SUBJECT=mailto:admin@eidetic.local" -Encoding UTF8
            Write-Ok "VAPID keys generated"
        } else {
            Write-Warn "Could not generate VAPID keys automatically - Web Push will be disabled"
            Write-Warn "Run: node -e `"console.log(require('web-push').generateVAPIDKeys())`""
        }

    } catch {
        Write-Err "Stalwart setup failed: $($_.Exception.Message)"
        Write-Err "Email/calendar features will stay inert until you re-run this script."
        Write-Warn "Continuing without Stalwart - other features will still work"
    }
}

# -- 8. Tailscale Funnel (remote HTTPS access) -----------------------

Write-Step "Setting up Tailscale Funnel (remote HTTPS access)"

Write-Host ""
Write-Host "   Funnel exposes this machine at https://<host>.<tailnet>.ts.net" -ForegroundColor White
Write-Host "   so anyone with the URL can reach it - no Tailscale needed on the" -ForegroundColor White
Write-Host "   client. Before continuing, make sure your tailnet is set up for it:" -ForegroundColor White
Write-Host ""
Write-Host "   1. HTTPS Certificates: must be ENABLED" -ForegroundColor White
Write-Host "      https://login.tailscale.com/admin/dns" -ForegroundColor DarkGray
Write-Host ""
Write-Host "   2. Funnel ACL grant: add this to your tailnet policy file" -ForegroundColor White
Write-Host "      https://login.tailscale.com/admin/acls" -ForegroundColor DarkGray
Write-Host ""
Write-Host "        `"nodeAttrs`": [" -ForegroundColor DarkGray
Write-Host "          { `"target`": [`"*`"], `"attr`": [`"funnel`"] }" -ForegroundColor DarkGray
Write-Host "        ]" -ForegroundColor DarkGray
Write-Host ""
Write-Host "   Without these, the funnel step will fail (cleanly - we'll tell" -ForegroundColor White
Write-Host "   you exactly what's wrong and you can re-run this script)." -ForegroundColor White
Write-Host ""

$publicUrl = $null
$wantsFunnel = Read-Host "   Enable remote HTTPS access via Tailscale Funnel? [Y/n]"

if ($wantsFunnel -ne "" -and $wantsFunnel -notmatch "^[Yy]") {
    Write-Warn "Skipped Tailscale setup - app will only be reachable on your LAN"
} else {
    # Locate tailscale.exe (install if missing)
    $tsExe = $null
    try { $tsExe = (Get-Command tailscale -ErrorAction Stop).Source } catch {}
    if (-not $tsExe) {
        $defaultPath = "C:\Program Files\Tailscale\tailscale.exe"
        if (Test-Path $defaultPath) { $tsExe = $defaultPath }
    }

    if (-not $tsExe) {
        Write-Host "   Tailscale not found - installing via winget..." -ForegroundColor White
        winget install --id Tailscale.Tailscale -e --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -ne 0) {
            Write-Err "winget install failed. Install manually from https://tailscale.com/download/windows and re-run this script."
            throw "Tailscale install failed"
        }
        $defaultPath = "C:\Program Files\Tailscale\tailscale.exe"
        if (Test-Path $defaultPath) {
            $tsExe = $defaultPath
        } else {
            Write-Err "Tailscale installed but tailscale.exe not found at the default path."
            throw "Tailscale post-install missing"
        }
        # Give the Tailscale service a moment to start up
        Start-Sleep -Seconds 3
    }

    Write-Ok "Tailscale CLI: $tsExe"

    # Check whether Tailscale is already logged in
    $backendState = "Unknown"
    try {
        $statusJson = & $tsExe status --json 2>$null | Out-String
        if ($statusJson) {
            $parsed = $statusJson | ConvertFrom-Json
            $backendState = $parsed.BackendState
        }
    } catch {}

    if ($backendState -ne "Running") {
        Write-Host ""
        Write-Host "   Logging in to Tailscale - a browser window will open." -ForegroundColor White
        Write-Host "   Complete the login, then return here." -ForegroundColor White
        Write-Host ""
        & $tsExe up
        if ($LASTEXITCODE -ne 0) { throw "tailscale up failed" }
    } else {
        Write-Ok "Already logged in to Tailscale"
    }

    # Fetch the device DNS name (e.g. aguglielmi.tail671088.ts.net)
    $statusJson = & $tsExe status --json | Out-String
    $parsed = $statusJson | ConvertFrom-Json
    $dnsName = $parsed.Self.DNSName.TrimEnd(".")
    $publicUrl = "https://$dnsName"

    # Enable Funnel for port 3000 (persists across reboots)
    Write-Host ""
    Write-Host "   Enabling Funnel on port 3000..." -ForegroundColor White
    $funnelOutput = & $tsExe funnel --bg 3000 2>&1 | Out-String
    $funnelExit = $LASTEXITCODE
    if ($funnelOutput.Trim()) { Write-Host $funnelOutput.Trim() -ForegroundColor DarkGray }

    if ($funnelExit -ne 0) {
        Write-Host ""
        $lower = $funnelOutput.ToLower()
        if ($lower -match "https" -and ($lower -match "disabled" -or $lower -match "not enabled" -or $lower -match "must be enabled")) {
            Write-Err "Funnel failed: HTTPS Certificates are not enabled on your tailnet."
            Write-Err "Fix: enable HTTPS at https://login.tailscale.com/admin/dns then re-run."
        } elseif ($lower -match "funnel" -and ($lower -match "not available" -or $lower -match "not permitted" -or $lower -match "nodeattr" -or $lower -match "acl" -or $lower -match "access denied")) {
            Write-Err "Funnel failed: this device isn't granted the 'funnel' attribute in your tailnet ACLs."
            Write-Err "Fix: add the nodeAttrs rule shown above at"
            Write-Err "  https://login.tailscale.com/admin/acls"
            Write-Err "then re-run this script."
        } else {
            Write-Err "Funnel failed. See the output above for details."
            Write-Err "Common causes:"
            Write-Err "  - HTTPS Certificates not enabled on tailnet"
            Write-Err "  - 'funnel' nodeAttr not granted in ACLs"
            Write-Err "  - Tailscale service not fully started yet (try re-running)"
        }
        throw "tailscale funnel failed"
    }
    Write-Ok "Funnel active"

    # Save the URL so it's easy to find later
    Set-Content -Path (Join-Path $repoRoot "public-url.txt") -Value $publicUrl -Encoding UTF8
    Write-Ok "Saved public URL to public-url.txt"
}

# -- Done ------------------------------------------------------------

Write-Host ""
Write-Host "  ==============================================" -ForegroundColor DarkGray
Write-Host "  Setup complete!" -ForegroundColor Green
Write-Host ""
if ($publicUrl) {
    Write-Host "  Public URL (accessible from any device, no Tailscale" -ForegroundColor White
    Write-Host "  required on the client):" -ForegroundColor White
    Write-Host ""
    Write-Host "    $publicUrl" -ForegroundColor Green
    Write-Host ""
    Write-Host "  (also saved to public-url.txt in the repo folder)" -ForegroundColor DarkGray
    Write-Host ""
}
Write-Host "  Local URL: http://localhost:3000" -ForegroundColor White
Write-Host "  You'll be asked to set a password on first visit." -ForegroundColor White
Write-Host ""
Write-Host "  Repo folder: $repoRoot" -ForegroundColor White
Write-Host "  To start eidetic later, run this from the repo folder:" -ForegroundColor White
Write-Host "    npm.cmd start" -ForegroundColor Yellow
Write-Host "  (use npm.cmd, not npm - PowerShell's execution policy" -ForegroundColor DarkGray
Write-Host "   blocks the npm.ps1 wrapper by default)" -ForegroundColor DarkGray
Write-Host "  ==============================================" -ForegroundColor DarkGray
Write-Host ""

$startNow = Read-Host "Start eidetic now? [Y/n]"
if ($startNow -eq "" -or $startNow -match "^[Yy]") {
    Write-Host ""
    Write-Host ">> Starting eidetic (press Ctrl+C to stop)" -ForegroundColor Cyan
    Write-Host ""
    npm.cmd start
}

} catch {
    Write-Host ""
    Write-Host "  ==============================================" -ForegroundColor DarkGray
    Write-Host "  Installation failed" -ForegroundColor Red
    Write-Host ""
    Write-Host "  Reason: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.InvocationInfo -and $_.InvocationInfo.PositionMessage) {
        Write-Host ""
        Write-Host $_.InvocationInfo.PositionMessage -ForegroundColor DarkGray
    }
    Write-Host "  ==============================================" -ForegroundColor DarkGray
    $script:installFailed = $true
} finally {
    Pause-Before-Exit
    if ($script:installFailed) { exit 1 }
}
