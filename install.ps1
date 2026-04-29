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

# .env.local writes are MERGE, not overwrite. A wholesale Set-Content here
# was the cause of vanishing STALWART_* / VAPID_* lines on every re-run:
# the file got truncated at this step, and any later block that decided
# "those are already set, skip" left the truncated file as the final state.
# Same hazard for AUTH_SECRET - regenerating it on each run silently
# invalidates every active login session and unverifies any in-flight
# HMAC-signed calendar tool proposals.

function Set-EnvLine {
    # Set or replace a single KEY=VALUE in .env.local. Preserves all other
    # lines, including comments and unrelated keys.
    param(
        [Parameter(Mandatory)] [string] $Key,
        [Parameter(Mandatory)] [string] $Value
    )
    $existing = if (Test-Path $envFile) { Get-Content $envFile } else { @() }
    $found = $false
    $kept = foreach ($line in $existing) {
        if ($line -match "^\s*$([regex]::Escape($Key))\s*=") {
            $found = $true
            "$Key=$Value"
        } else {
            $line
        }
    }
    if (-not $found) { $kept = @($kept) + "$Key=$Value" }
    Set-Content -Path $envFile -Value $kept -Encoding UTF8
}

# Only generate AUTH_SECRET if .env.local doesn't already have one.
$haveAuthSecret = $false
if (Test-Path $envFile) {
    $existingEnv = Get-Content $envFile -Raw
    if ($existingEnv -match "(?m)^AUTH_SECRET\s*=\s*\S") { $haveAuthSecret = $true }
}

if (-not $haveAuthSecret) {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $authSecret = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
    Set-EnvLine -Key "AUTH_SECRET" -Value $authSecret
    Write-Ok "Generated AUTH_SECRET"
} else {
    Write-Ok "Reusing existing AUTH_SECRET"
}

Set-EnvLine -Key "OLLAMA_MODEL" -Value $model
Write-Ok ".env.local updated"

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
    # Paths used throughout the Stalwart block. Declared up front so the
    # catch block can surface stderr.log on failure.
    $installRoot = Join-Path $env:ProgramFiles "Stalwart"
    $binDir   = Join-Path $installRoot "bin"
    $etcDir   = Join-Path $installRoot "etc"
    $dataDir  = Join-Path $installRoot "data"
    $logsDir  = Join-Path $installRoot "logs"
    $stderrLog   = Join-Path $logsDir "stderr.log"
    $stdoutLog   = Join-Path $logsDir "stdout.log"
    $configJson  = Join-Path $etcDir "config.json"
    $stalwartExe = Join-Path $binDir "stalwart.exe"
    $nssmExe     = Join-Path $binDir "nssm.exe"

    try {
        # --- Admin is required to start/register a Windows service ---
        $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            Write-Err "Stalwart setup needs Administrator (required to start/register a Windows service)."
            Write-Err "Right-click install.ps1 > Run as administrator, then try again."
            throw "Stalwart setup requires admin"
        }

        # --- Always wipe any existing Stalwart service so we end up with a clean NSSM registration ---
        # Earlier runs of this script may have registered the service with
        # New-Service (no stdio capture) or left it in a broken Stopped
        # state. Remove first, install fresh. data / etc / logs dirs are
        # preserved so an already-completed wizard keeps its config.
        $existingService = Get-Service -Name "Stalwart" -ErrorAction SilentlyContinue
        if ($existingService) {
            Write-Host "   Existing Stalwart service found ($($existingService.Status)) - removing to re-register cleanly..." -ForegroundColor White
            if ($existingService.Status -eq "Running") {
                try { Stop-Service -Name Stalwart -Force -ErrorAction Stop } catch {
                    Write-Warn "Stop-Service failed: $($_.Exception.Message) - continuing"
                }
            }
            if (Test-Path $nssmExe) {
                & $nssmExe remove Stalwart confirm | Out-Null
            } else {
                & sc.exe delete Stalwart | Out-Null
            }
            # Give the SCM a moment to acknowledge the removal
            Start-Sleep -Seconds 2
        }

        # --- Ensure directory layout (per Stalwart's Windows docs) ---
        foreach ($d in @($installRoot, $binDir, $etcDir, $dataDir, $logsDir)) {
            if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
        }

        # --- Download + extract Stalwart if the binary isn't already present ---
        if (-not (Test-Path $stalwartExe)) {
            Write-Host "   Fetching latest Stalwart release metadata..." -ForegroundColor White
            $release = $null
            try {
                $release = Invoke-RestMethod `
                    -Uri "https://api.github.com/repos/stalwartlabs/mail-server/releases/latest" `
                    -Headers @{ "User-Agent" = "eidetic-installer" } `
                    -UseBasicParsing
            } catch {
                Write-Err "Could not reach GitHub API: $($_.Exception.Message)"
                Write-Err "Check your internet connection and re-run this script."
                throw "Stalwart release lookup failed"
            }

            $zipAsset = $release.assets | Where-Object {
                $_.name -match "x86_64.*windows" -and $_.name -match "\.zip$" -and $_.name -notmatch "sigstore"
            } | Select-Object -First 1

            if (-not $zipAsset) {
                Write-Err "Latest Stalwart release has no x86_64 Windows zip asset."
                Write-Err "Install manually from https://stalw.art/download and re-run this script."
                throw "Stalwart release missing Windows asset"
            }

            $zipPath = Join-Path $env:TEMP $zipAsset.name
            Write-Host "   Downloading $($zipAsset.name) ($([math]::Round($zipAsset.size / 1MB, 1)) MB)..." -ForegroundColor White
            Invoke-WebRequest -Uri $zipAsset.browser_download_url -OutFile $zipPath -UseBasicParsing

            $extractTmp = Join-Path $env:TEMP "stalwart-extract"
            if (Test-Path $extractTmp) { Remove-Item $extractTmp -Recurse -Force }
            Expand-Archive -Path $zipPath -DestinationPath $extractTmp -Force
            $stalwartExeSrc = Get-ChildItem -Path $extractTmp -Recurse -Filter "stalwart.exe" | Select-Object -First 1
            if (-not $stalwartExeSrc) {
                Write-Err "stalwart.exe not found inside $($zipAsset.name)"
                throw "Stalwart binary missing after extract"
            }
            Copy-Item -Path $stalwartExeSrc.FullName -Destination $stalwartExe -Force
            Remove-Item $extractTmp -Recurse -Force
        } else {
            Write-Ok "Stalwart binary already present at $stalwartExe"
        }

        # --- Download NSSM if missing (service wrapper that captures stdio) ---
        # Stalwart's Windows docs recommend NSSM because the bootstrap-mode
        # admin password is written to stderr and services registered via
        # sc.exe / New-Service provide no way to capture it or diagnose
        # startup failures.
        if (-not (Test-Path $nssmExe)) {
            Write-Host "   Downloading NSSM 2.24 (service wrapper)..." -ForegroundColor White
            $nssmZip = Join-Path $env:TEMP "nssm-2.24.zip"
            try {
                Invoke-WebRequest `
                    -Uri "https://nssm.cc/release/nssm-2.24.zip" `
                    -OutFile $nssmZip `
                    -UseBasicParsing `
                    -UserAgent "Mozilla/5.0"
            } catch {
                Write-Err "Could not download NSSM: $($_.Exception.Message)"
                throw "NSSM download failed"
            }
            $nssmExtract = Join-Path $env:TEMP "nssm-extract"
            if (Test-Path $nssmExtract) { Remove-Item $nssmExtract -Recurse -Force }
            Expand-Archive -Path $nssmZip -DestinationPath $nssmExtract -Force
            $nssmExeSrc = Get-ChildItem -Path $nssmExtract -Recurse -Filter "nssm.exe" |
                Where-Object { $_.DirectoryName -match "win64" } |
                Select-Object -First 1
            if (-not $nssmExeSrc) {
                Write-Err "nssm.exe (win64) not found inside NSSM archive"
                throw "NSSM binary missing after extract"
            }
            Copy-Item -Path $nssmExeSrc.FullName -Destination $nssmExe -Force
            Remove-Item $nssmExtract -Recurse -Force
        } else {
            Write-Ok "NSSM already present at $nssmExe"
        }

        # --- Was the wizard already completed on a prior install? ---
        # Stalwart writes config.json once the user finishes the web-admin
        # wizard. If it exists, Stalwart won't re-enter bootstrap mode.
        $alreadyConfigured = Test-Path $configJson

        # --- Generate bootstrap admin password and pin via env var ---
        # STALWART_RECOVERY_ADMIN=user:pass lets us set the bootstrap admin
        # to a known value instead of tailing stderr for a random password.
        # Only meaningful when config.json is absent (bootstrap mode).
        $adminBytes = New-Object byte[] 16
        $rng2 = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng2.GetBytes($adminBytes) } finally { $rng2.Dispose() }
        $adminPass = ($adminBytes | ForEach-Object { $_.ToString("x2") }) -join ""
        $bootstrapCreds = "admin:$adminPass"

        # --- Register the Stalwart service via NSSM ---
        # Two PowerShell 5.1 quirks force us away from `nssm set` for most
        # values: (a) the argv serializer strips embedded `\"` so paths
        # with spaces arrive unquoted at nssm.exe, and (b) `nssm set
        # AppEnvironmentExtra` splits its input on ":" and rejects the
        # user:pass credential format. We let `nssm install` scaffold the
        # service then write every Parameters value directly to the
        # registry where quoting and typing are preserved verbatim.
        Write-Host "   Registering Stalwart service via NSSM..." -ForegroundColor White
        & $nssmExe install Stalwart $stalwartExe | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "nssm install failed (exit $LASTEXITCODE)" }

        $svcRegPath    = "HKLM:\SYSTEM\CurrentControlSet\Services\Stalwart"
        $paramsRegPath = "$svcRegPath\Parameters"
        if (-not (Test-Path $paramsRegPath)) {
            Write-Err "NSSM Parameters key missing at $paramsRegPath - nssm install likely failed silently."
            throw "NSSM Parameters key missing"
        }

        # ImagePath must be `"<nssm.exe>" <service-name>`:
        # - quotes are required because "C:\Program Files\..." contains
        #   spaces; SCM otherwise tries to launch C:\Program and fails
        #   with %%193 (ERROR_BAD_EXE_FORMAT) before nssm ever runs
        # - the trailing service name is how nssm.exe knows which
        #   Parameters subkey to load when SCM spawns it
        Set-ItemProperty -Path $svcRegPath -Name "ImagePath" `
            -Value "`"$nssmExe`" Stalwart" -Type ExpandString

        # All of NSSM's per-service values as REG_SZ under Parameters.
        Set-ItemProperty -Path $paramsRegPath -Name "Application"   -Type String -Value $stalwartExe
        Set-ItemProperty -Path $paramsRegPath -Name "AppParameters" -Type String -Value "--config `"$configJson`""
        Set-ItemProperty -Path $paramsRegPath -Name "AppDirectory"  -Type String -Value $installRoot
        Set-ItemProperty -Path $paramsRegPath -Name "AppStdout"     -Type String -Value $stdoutLog
        Set-ItemProperty -Path $paramsRegPath -Name "AppStderr"     -Type String -Value $stderrLog

        # DisplayName / Description / Start type live on the service
        # root key, not Parameters. `nssm set` handles these fine
        # because none contain embedded quotes.
        & $nssmExe set Stalwart DisplayName "Stalwart Mail Server" | Out-Null
        & $nssmExe set Stalwart Description "Stalwart mail + CalDAV server (managed by eidetic)" | Out-Null
        & $nssmExe set Stalwart Start SERVICE_AUTO_START | Out-Null

        # Pin the bootstrap admin creds only when the wizard hasn't
        # been completed. After config.json exists Stalwart ignores
        # STALWART_RECOVERY_ADMIN anyway, but leaving it set would
        # leak the password into the registry unnecessarily.
        if (-not $alreadyConfigured) {
            Set-ItemProperty -Path $paramsRegPath `
                -Name "AppEnvironmentExtra" -Type MultiString `
                -Value @("STALWART_RECOVERY_ADMIN=$bootstrapCreds")
        } else {
            Remove-ItemProperty -Path $paramsRegPath `
                -Name "AppEnvironmentExtra" -ErrorAction SilentlyContinue
        }

        # Sanity-check that the registry matches what we wrote. If any
        # of these are empty the service will fail with %%193 or drop
        # args, so catch it here with a useful error rather than after
        # Start-Service returns an opaque code.
        $verifyImg = (Get-ItemProperty -Path $svcRegPath -Name ImagePath).ImagePath
        $verifyApp = (Get-ItemProperty -Path $paramsRegPath -Name Application).Application
        $verifyArg = (Get-ItemProperty -Path $paramsRegPath -Name AppParameters).AppParameters
        if ($verifyImg -notmatch '^"[^"]+"\s+Stalwart$') {
            Write-Err "ImagePath is malformed: [$verifyImg]"
            throw "Service ImagePath not quoted correctly"
        }
        if (-not $verifyApp -or -not $verifyArg) {
            Write-Err "Parameters missing - Application=[$verifyApp] AppParameters=[$verifyArg]"
            throw "NSSM parameters not registered"
        }
        Write-Host "   ImagePath:      $verifyImg" -ForegroundColor DarkGray
        Write-Host "   Application:    $verifyApp" -ForegroundColor DarkGray
        Write-Host "   AppParameters:  $verifyArg" -ForegroundColor DarkGray

        # --- Start the service ---
        Write-Host "   Starting Stalwart service..." -ForegroundColor White
        try { Start-Service -Name Stalwart -ErrorAction Stop } catch {
            Write-Err "Start-Service failed: $($_.Exception.Message)"
            if (Test-Path $stderrLog) {
                Write-Err "Last 20 lines of $stderrLog :"
                $tail = Get-Content $stderrLog -Tail 20 -ErrorAction SilentlyContinue | Out-String
                Write-Host $tail -ForegroundColor DarkGray
            }
            throw "Stalwart service failed to start"
        }
        Start-Sleep -Seconds 3

        $svc = Get-Service -Name Stalwart
        if ($svc.Status -ne "Running") {
            Write-Err "Stalwart service didn't stay running (status: $($svc.Status))"
            if (Test-Path $stderrLog) {
                Write-Err "Last 20 lines of $stderrLog :"
                $tail = Get-Content $stderrLog -Tail 20 -ErrorAction SilentlyContinue | Out-String
                Write-Host $tail -ForegroundColor DarkGray
            }
            throw "Stalwart service crashed on start"
        }
        Write-Ok "Stalwart service running"

        # --- Poll admin port (default 8080) - wait up to 120s ---
        # Stalwart's bootstrap listener binds to "[::]:8080". On Windows
        # that socket is IPv6-only by default (unlike Linux), so 127.0.0.1
        # won't connect. We TCP-probe both loopbacks and remember whichever
        # accepts the connection - that becomes the admin URL for the
        # browser and the JMAP/CalDAV URLs written to .env.local.
        # Raw TCP (not HTTP) keeps us immune to /admin returning 404/503
        # while webui.zip is still downloading in the background.
        # NOTE: TcpClient() defaults to InterNetwork (IPv4), so a plain
        # `ConnectAsync("::1", ...)` silently fails. Parse the candidate
        # to an IPAddress and construct the client with the matching
        # AddressFamily so v6 probes actually reach a v6 listener.
        Write-Host "   Waiting for Stalwart port 8080 to accept connections ..." -ForegroundColor White
        $adminHost = $null
        $candidates = @(
            @{ Ip = "127.0.0.1"; UrlHost = "127.0.0.1" },
            @{ Ip = "::1"; UrlHost = "[::1]" }
        )
        for ($i = 0; $i -lt 60; $i++) {
            foreach ($c in $candidates) {
                $ip = [System.Net.IPAddress]::Parse($c.Ip)
                $tcp = New-Object System.Net.Sockets.TcpClient -ArgumentList ($ip.AddressFamily)
                try {
                    $t = $tcp.ConnectAsync($ip, 8080)
                    try { [void]$t.Wait(2000) } catch {}
                    if ($tcp.Connected) {
                        $adminHost = $c.UrlHost
                        break
                    }
                } catch {} finally {
                    try { $tcp.Close() } catch {}
                }
            }
            if ($adminHost) { break }
            Start-Sleep -Seconds 1
        }

        if (-not $adminHost) {
            Write-Err "Stalwart isn't accepting connections on port 8080 after 120s."

            # Show what Windows sees listening on 8080, and whether each
            # loopback is reachable via Test-NetConnection (which uses
            # the correct address family internally).
            $listeners = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
            if ($listeners) {
                Write-Err "Listeners on port 8080:"
                $listeners | ForEach-Object {
                    Write-Host "     $($_.LocalAddress):$($_.LocalPort) -> PID $($_.OwningProcess)" -ForegroundColor DarkGray
                }
            } else {
                Write-Err "Nothing is listening on port 8080 (service may have failed to bind)."
            }
            Write-Err "Loopback probe (via Test-NetConnection):"
            foreach ($ip in @("127.0.0.1", "::1")) {
                $ok = $false
                try { $ok = Test-NetConnection -ComputerName $ip -Port 8080 -InformationLevel Quiet -WarningAction SilentlyContinue } catch {}
                Write-Host "     $ip`:8080 -> $(if ($ok) { 'OK' } else { 'fail' })" -ForegroundColor DarkGray
            }

            if (Test-Path $stderrLog) {
                Write-Err "Last 20 lines of $stderrLog :"
                Get-Content $stderrLog -Tail 20 -ErrorAction SilentlyContinue |
                    ForEach-Object { Write-Host "     $_" -ForegroundColor DarkGray }
            }
            if (Test-Path $stdoutLog) {
                Write-Err "Last 20 lines of $stdoutLog :"
                Get-Content $stdoutLog -Tail 20 -ErrorAction SilentlyContinue |
                    ForEach-Object { Write-Host "     $_" -ForegroundColor DarkGray }
            }

            throw "Stalwart admin unreachable"
        }

        # Two URLs: one for the user to click (via localhost so the
        # browser picks whichever loopback works), one for .env.local
        # (using the IP we actually confirmed a connection on, so
        # Node.js doesn't fight its own localhost -> v4 lookup).
        $adminUrl = "http://localhost:8080/admin"
        Write-Ok "Admin port responsive via $adminHost"

        # --- Detect existing Stalwart creds in .env.local ---
        $envHasStalwartCreds = $false
        if (Test-Path $envFile) {
            $envContentCurrent = Get-Content $envFile -Raw
            if ($envContentCurrent -match "(?m)^STALWART_USERNAME\s*=\s*\S" -and
                $envContentCurrent -match "(?m)^STALWART_PASSWORD\s*=\s*\S") {
                $envHasStalwartCreds = $true
            }
        }

        $stalwartUser = $null
        $stalwartPass = $null

        if ($alreadyConfigured -and $envHasStalwartCreds) {
            Write-Ok "Stalwart already configured - reusing existing credentials from .env.local"
        } elseif ($alreadyConfigured) {
            # Wizard was done on an earlier run, but creds aren't in
            # .env.local - just prompt for them.
            Write-Host ""
            Write-Host "   Stalwart is configured but I can't find its credentials in .env.local." -ForegroundColor White
            Write-Host "   Enter the mailbox admin email + password you set up earlier." -ForegroundColor White
            Write-Host "   (If you've lost them, stop the Stalwart service, delete" -ForegroundColor White
            Write-Host "    '$configJson', and re-run this script to start over.)" -ForegroundColor DarkGray
            Write-Host ""
            $stalwartUser = Read-Host "   Stalwart mailbox email (e.g. admin@eidetic.local)"
            $stalwartPassRaw = Read-Host "   Stalwart mailbox password" -AsSecureString
            $stalwartPass = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
                [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($stalwartPassRaw)
            )
            if (-not $stalwartUser -or -not $stalwartPass) {
                Write-Err "Username and password are required to wire Stalwart into Eidetic."
                throw "Stalwart credentials missing"
            }
        } else {
            # Fresh install - walk through the bootstrap wizard
            Write-Host ""
            Write-Host "   Stalwart is in BOOTSTRAP MODE. Log in with these credentials:" -ForegroundColor Cyan
            Write-Host ""
            Write-Host "     URL:      $adminUrl" -ForegroundColor White
            Write-Host "     Username: admin" -ForegroundColor White
            Write-Host "     Password: $adminPass" -ForegroundColor Yellow
            Write-Host ""
            Write-Host "   In the browser:" -ForegroundColor White
            Write-Host "     1. Step 1: hostname = '127.0.0.1', domain = 'eidetic.example.com'" -ForegroundColor White
            Write-Host "        (Stalwart rejects .local and other non-public TLDs; an IP" -ForegroundColor White
            Write-Host "         bypasses the FQDN check. example.com is RFC 2606 reserved.)" -ForegroundColor White
            Write-Host "        Uncheck 'Automatically obtain TLS certificate' (no public DNS here)." -ForegroundColor White
            Write-Host "     2. Step 2 (data store): pick 'RocksDB', then REPLACE the default" -ForegroundColor White
            Write-Host "        path '/var/lib/stalwart/' (Linux path, won't work on Windows) with:" -ForegroundColor Yellow
            Write-Host "            $dataDir" -ForegroundColor Yellow
            Write-Host "        Without this the auth backend can't open and every login" -ForegroundColor Yellow
            Write-Host "        returns 'Temporary server failure'." -ForegroundColor Yellow
            Write-Host "     3. Step 3 (directory): accept 'Internal'." -ForegroundColor White
            Write-Host "     4. Step 4 (log file): if the default path starts with /var/log or any" -ForegroundColor White
            Write-Host "        other Linux path, change it to:" -ForegroundColor White
            Write-Host "            $(Join-Path $logsDir 'stalwart.log')" -ForegroundColor Yellow
            Write-Host "     5. Step 5 (DNS): leave 'Manual DNS Server Management' selected." -ForegroundColor White
            Write-Host "     !! CRITICAL: BEFORE submitting any step, check EVERY email/domain" -ForegroundColor Yellow
            Write-Host "        field for a stale '.local' value (Stalwart auto-fills some" -ForegroundColor Yellow
            Write-Host "        fields like postmaster/contact email based on the hostname" -ForegroundColor Yellow
            Write-Host "        shown on startup, which is your Windows hostname + .local)." -ForegroundColor Yellow
            Write-Host "        Replace anything ending in .local with @eidetic.example.com - Stalwart" -ForegroundColor Yellow
            Write-Host "        silently aborts wizard submission on the first invalid email." -ForegroundColor Yellow
            Write-Host "     6. FINAL SCREEN: Stalwart prints an email + password for the new admin." -ForegroundColor White
            Write-Host "        COPY BOTH - they won't be shown again. These are your mailbox creds." -ForegroundColor White
            Write-Host "     7. Come back here and press Enter." -ForegroundColor White
            Write-Host ""
            Write-Host "   After that, I'll restart Stalwart so your config takes effect, then" -ForegroundColor White
            Write-Host "   ask you to paste the admin email + password below." -ForegroundColor White
            Write-Host ""
            try { Start-Process $adminUrl } catch {}

            [void](Read-Host "   Press Enter once the wizard's final screen is showing")

            # Per Stalwart's docs: restart after wizard so config.json loads.
            # The wizard's default listener config tries to bind 25 / 80 /
            # 443 / etc. On Windows those often collide with IIS, the
            # Windows SMTP service, or other mail software - surface the
            # real reason from stderr.log so the user can resolve it.
            Write-Host "   Restarting Stalwart to load wizard config..." -ForegroundColor White
            try {
                Restart-Service -Name Stalwart -ErrorAction Stop
            } catch {
                Write-Err "Restart-Service failed: $($_.Exception.Message)"
                if (Test-Path $stderrLog) {
                    Write-Err "Last 30 lines of $stderrLog :"
                    Get-Content $stderrLog -Tail 30 -ErrorAction SilentlyContinue |
                        ForEach-Object { Write-Host "     $_" -ForegroundColor DarkGray }
                }
                if (Test-Path $stdoutLog) {
                    Write-Err "Last 30 lines of $stdoutLog :"
                    Get-Content $stdoutLog -Tail 30 -ErrorAction SilentlyContinue |
                        ForEach-Object { Write-Host "     $_" -ForegroundColor DarkGray }
                }
                Write-Err "Common causes on Windows:"
                Write-Err "  - ports 25/80/443 bound by IIS or the Windows SMTP service"
                Write-Err "  - wizard configured a TLS cert that can't be loaded"
                Write-Err "Fix the conflict, then re-run install.ps1 to finish setup."
                throw "Stalwart restart failed after wizard"
            }
            Start-Sleep -Seconds 5

            Write-Host ""
            Write-Host "   Paste the admin email and password from the wizard's final screen." -ForegroundColor White
            Write-Host "   These become STALWART_USERNAME / STALWART_PASSWORD in .env.local." -ForegroundColor White
            Write-Host ""
            $stalwartUser = Read-Host "   Stalwart mailbox email (e.g. admin@eidetic.local)"
            $stalwartPassRaw = Read-Host "   Stalwart mailbox password" -AsSecureString
            $stalwartPass = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
                [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($stalwartPassRaw)
            )

            if (-not $stalwartUser -or -not $stalwartPass) {
                Write-Err "Username and password are required to wire Stalwart into Eidetic."
                throw "Stalwart credentials missing"
            }

            Write-Host ""
            Write-Host "   After the wizard, open $adminUrl again and add" -ForegroundColor White
            Write-Host "   your Outlook IMAP credentials under 'Fetched accounts' (server:" -ForegroundColor White
            Write-Host "   outlook.office365.com:993, auth: app password, poll: every 5 min)." -ForegroundColor White
            Write-Host "   Eidetic will pick up mail from there." -ForegroundColor White
            Write-Host ""
        }

        # --- Write STALWART_* to .env.local (in-place, no destructive strip) ---
        if ($stalwartUser -and $stalwartPass) {
            $jmapUrl   = "http://$($adminHost):8080/jmap"
            $caldavUrl = "http://$($adminHost):8080/dav"
            Set-EnvLine -Key "STALWART_JMAP_URL"   -Value $jmapUrl
            Set-EnvLine -Key "STALWART_CALDAV_URL" -Value $caldavUrl
            Set-EnvLine -Key "STALWART_USERNAME"   -Value $stalwartUser
            Set-EnvLine -Key "STALWART_PASSWORD"   -Value $stalwartPass
            Write-Ok "Wrote STALWART_* to .env.local"
        }

        # --- VAPID keys for Web Push (only generate if not already present) ---
        $envNeedsVapid = $true
        if (Test-Path $envFile) {
            $envContentCurrent = Get-Content $envFile -Raw
            if ($envContentCurrent -match "(?m)^VAPID_PUBLIC_KEY\s*=\s*\S") {
                $envNeedsVapid = $false
            }
        }

        if ($envNeedsVapid) {
            Write-Host "   Generating VAPID keys for Web Push..." -ForegroundColor White
            $vapidOutput = & node -e "const w=require('web-push');const k=w.generateVAPIDKeys();console.log(k.publicKey);console.log(k.privateKey);" 2>&1 | Out-String
            $vapidLines = $vapidOutput.Trim().Split("`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ }
            if ($vapidLines.Count -ge 2) {
                Set-EnvLine -Key "VAPID_PUBLIC_KEY"  -Value $vapidLines[0]
                Set-EnvLine -Key "VAPID_PRIVATE_KEY" -Value $vapidLines[1]
                Set-EnvLine -Key "VAPID_SUBJECT"     -Value "mailto:admin@eidetic.local"
                Write-Ok "VAPID keys generated"
            } else {
                Write-Warn "Could not generate VAPID keys automatically - Web Push will be disabled"
                Write-Warn "Run: node -e `"console.log(require('web-push').generateVAPIDKeys())`""
            }
        } else {
            Write-Ok "VAPID keys already present in .env.local"
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

    # Make sure the Windows Tailscale service is actually running. If only the
    # tray helper is up (or the service was stopped after install), `tailscale
    # up` will return success but the backend stays in NoState forever.
    try {
        $tsSvc = Get-Service -Name "Tailscale" -ErrorAction Stop
        if ($tsSvc.Status -ne "Running") {
            Write-Host "   Tailscale service is $($tsSvc.Status) - starting it..." -ForegroundColor White
            Start-Service -Name "Tailscale"
            $svcDeadline = (Get-Date).AddSeconds(30)
            while ((Get-Service -Name "Tailscale").Status -ne "Running" -and (Get-Date) -lt $svcDeadline) {
                Start-Sleep -Seconds 1
            }
            if ((Get-Service -Name "Tailscale").Status -ne "Running") {
                Write-Err "Could not start the Tailscale Windows service."
                throw "Tailscale service not running"
            }
            # Give tailscaled a beat after the service flips to Running before
            # we start poking it with CLI commands.
            Start-Sleep -Seconds 2
        }
    } catch [Microsoft.PowerShell.Commands.ServiceCommandException] {
        Write-Warn "Tailscale Windows service not registered - the CLI may still work via the tray helper."
    } catch {
        if ($_.Exception.Message -ne "Tailscale service not running") {
            Write-Warn "Could not query Tailscale service state: $($_.Exception.Message)"
        } else {
            throw
        }
    }

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
        # Prefer unattended login via a reusable auth key so the installer
        # doesn't need a human in the browser. Accept it from $env:TS_AUTHKEY
        # or prompt for one (offering the URL where it can be generated).
        $authKey = $env:TS_AUTHKEY
        if (-not $authKey) {
            Write-Host ""
            Write-Host "   Tailscale needs to log in. To keep this fully automated, paste a" -ForegroundColor White
            Write-Host "   one-time auth key from:" -ForegroundColor White
            Write-Host "     https://login.tailscale.com/admin/settings/keys" -ForegroundColor DarkGray
            Write-Host "   (click 'Generate auth key', leave defaults, copy the tskey-... value)." -ForegroundColor White
            Write-Host "   Leave blank to fall back to the browser login flow." -ForegroundColor White
            Write-Host ""
            $authKey = Read-Host "   Tailscale auth key (tskey-...)"
        }

        if ($authKey) {
            Write-Host "   Logging in to Tailscale with auth key (unattended)..." -ForegroundColor White
            $upOutput = & $tsExe up --auth-key=$authKey --unattended 2>&1 | Out-String
            $upExit = $LASTEXITCODE
            if ($upOutput.Trim()) { Write-Host $upOutput.Trim() -ForegroundColor DarkGray }
            if ($upExit -ne 0) {
                $lower = $upOutput.ToLower()
                if ($lower -match "invalid key" -or $lower -match "expired" -or $lower -match "already used" -or $lower -match "not authorized") {
                    Write-Err "Tailscale rejected the auth key (invalid/expired/already-used)."
                    Write-Err "Generate a fresh one at https://login.tailscale.com/admin/settings/keys and re-run."
                }
                throw "tailscale up (auth-key) failed"
            }
        } else {
            Write-Host ""
            Write-Host "   Logging in to Tailscale - a browser window will open." -ForegroundColor White
            Write-Host "   Complete the login, then return here." -ForegroundColor White
            Write-Host ""
            & $tsExe up
            if ($LASTEXITCODE -ne 0) { throw "tailscale up failed" }
        }
    } else {
        Write-Ok "Already logged in to Tailscale"
    }

    # Wait for the backend to actually reach Running. After a fresh install
    # or a just-completed `up`, the daemon can briefly report NoState/Starting,
    # which makes the funnel call below fail with "unexpected state: NoState".
    $parsed = $null
    $deadline = (Get-Date).AddSeconds(60)
    $lastState = $backendState
    $waitedOnce = $false
    while ($true) {
        try {
            $statusJson = & $tsExe status --json 2>$null | Out-String
            if ($statusJson) {
                $parsed = $statusJson | ConvertFrom-Json
                $lastState = $parsed.BackendState
            }
        } catch { $parsed = $null }

        if ($lastState -eq "Running") { break }
        if ((Get-Date) -ge $deadline) { break }

        if (-not $waitedOnce) {
            Write-Host "   Waiting for Tailscale to finish connecting (state: $lastState)..." -ForegroundColor White
            $waitedOnce = $true
        }
        Start-Sleep -Seconds 2
    }

    if ($lastState -ne "Running") {
        Write-Err "Tailscale never reached the Running state (last state: $lastState)."
        if ($lastState -eq "NoState") {
            Write-Err "This usually means the login wasn't completed in the browser, or the"
            Write-Err "Tailscale service isn't running. Open the Tailscale tray icon, sign in,"
            Write-Err "then re-run this script."
        } else {
            Write-Err "Open the Tailscale tray icon to check status, then re-run this script."
        }
        throw "tailscale not running"
    }

    # Fetch the device DNS name (e.g. aguglielmi.tail671088.ts.net)
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

# -- 9. Mount Stalwart CalDAV on Funnel (iPhone CalDAV path) --------

# Phase 16: expose Stalwart's /dav path on the existing Funnel hostname so
# iPhone Calendar/Reminders can connect over real HTTPS without a custom
# cert. We only attempt this when (a) Stalwart is configured and (b) the
# Funnel block above succeeded - both are required for the path to mean
# anything.

$stalwartCaldavConfigured = $false
$stalwartCaldavTarget = $null
if (Test-Path $envFile) {
    $envContentPhase16 = Get-Content $envFile -Raw
    if ($envContentPhase16 -match "(?m)^STALWART_CALDAV_URL\s*=\s*(\S+)") {
        $envCaldavUrl = $Matches[1].Trim()
        $stalwartCaldavConfigured = $true

        # Rewrite the host portion to `localhost`. Two reasons:
        #   1. Tailscale's serve config display strips IPv6 brackets
        #      (`http://[::1]:8080/dav` becomes `http://::1:8080/dav`),
        #      and at least some 1.96-era builds then refuse to forward
        #      to that mapping at the public edge ("unknown proxy
        #      destination"). Using `localhost` sidesteps the IPv6 URL
        #      parser entirely.
        #   2. The Tailscale daemon resolves `localhost` via the system
        #      hosts file, which on Windows has both `127.0.0.1` and
        #      `::1` aliased - so the daemon connects to whichever
        #      address Stalwart is actually listening on.
        $stalwartCaldavTarget = $envCaldavUrl `
            -replace '^http://\[::1\]:', 'http://localhost:' `
            -replace '^http://127\.0\.0\.1:', 'http://localhost:'

        # Strip the trailing /dav so we can also build well-known mappings.
        # The CalDAV URL is like `http://localhost:8080/dav`; we want
        # `http://localhost:8080` as the bare host base.
        $stalwartFunnelHost = $stalwartCaldavTarget -replace '/dav/?$', ''
    }
}

if ($stalwartCaldavConfigured -and $publicUrl) {
    Write-Step "Mounting Stalwart CalDAV on Funnel (for iPhone)"

    Write-Host ""
    Write-Host "   This adds a /dav path to your Funnel hostname pointing at" -ForegroundColor White
    Write-Host "   Stalwart's local CalDAV listener. Only /dav is proxied - the" -ForegroundColor White
    Write-Host "   admin UI on /admin stays local-only." -ForegroundColor White
    Write-Host ""

    $wantsDav = Read-Host "   Expose Stalwart CalDAV at $publicUrl/dav so iPhone can connect? [Y/n]"

    if ($wantsDav -ne "" -and $wantsDav -notmatch "^[Yy]") {
        Write-Warn "Skipped - iPhone CalDAV setup will not work until you re-run this step"
    } else {
        try {
            # Three Funnel mappings make iPhone CalDAV/CardDAV "just work":
            #   1. /dav/*                    - the CalDAV/CardDAV protocol surface
            #   2. /.well-known/caldav       - iOS Calendar auto-discovery
            #   3. /.well-known/carddav      - iOS Contacts auto-discovery
            # Without (2) and (3), the iPhone form requires Advanced Settings
            # to type the path manually, which most users won't find.
            #
            # Two gotchas folded in:
            #   - Use `tailscale funnel` (NOT `tailscale serve`). The serve
            #     form adds the path mapping but simultaneously REMOVES
            #     Funnel from port 443, killing public access. The funnel
            #     form preserves Funnel.
            #   - No `2>&1` on the native exe. With $ErrorActionPreference =
            #     Stop, Windows PowerShell wraps every stderr line as an
            #     ErrorRecord and trips the catch even on exit 0.
            $mappings = @(
                @{ Path = "/dav"; Target = "$stalwartCaldavTarget" },
                @{ Path = "/.well-known/caldav"; Target = "$stalwartFunnelHost/.well-known/caldav" },
                @{ Path = "/.well-known/carddav"; Target = "$stalwartFunnelHost/.well-known/carddav" }
            )

            foreach ($m in $mappings) {
                Write-Host "   Adding funnel mapping: $($m.Path) -> $($m.Target) ..." -ForegroundColor White
                $funnelOutput = & $tsExe funnel --bg --https=443 --set-path=$($m.Path) $($m.Target) | Out-String
                $funnelExitDav = $LASTEXITCODE
                if ($funnelOutput.Trim()) { Write-Host $funnelOutput.Trim() -ForegroundColor DarkGray }

                if ($funnelExitDav -ne 0) {
                    $lower = $funnelOutput.ToLower()
                    if ($lower -match "unknown flag" -or $lower -match "unrecognized" -or $lower -match "invalid argument") {
                        Write-Err "Your Tailscale CLI doesn't understand --set-path."
                        Write-Err "Update Tailscale (winget upgrade Tailscale.Tailscale) and re-run."
                    } else {
                        Write-Err "tailscale funnel --set-path=$($m.Path) failed."
                    }
                    throw "tailscale funnel --set-path failed"
                }
            }

            # Validate via /.well-known/caldav rather than /dav/. iOS hits
            # well-known first, expects a 301/307 redirect, then follows it
            # to the actual CalDAV collection. A successful well-known
            # response is the iOS-relevant success signal AND proves both
            # the well-known mapping and Stalwart's redirect logic work.
            # Funnel propagation can lag ~30-60s after each `funnel
            # --set-path`, so we poll.
            Write-Host "   Verifying $publicUrl/.well-known/caldav redirects (iOS auto-discovery) ..." -ForegroundColor White
            $wellKnownUrl = "$publicUrl/.well-known/caldav"
            $autoDiscoveryWorks = $false
            $stalwartStatus = $null
            $deadlineDav = (Get-Date).AddSeconds(60)
            while ((Get-Date) -lt $deadlineDav -and -not $autoDiscoveryWorks) {
                try {
                    $resp = Invoke-WebRequest -Uri $wellKnownUrl -Method GET -UseBasicParsing `
                        -MaximumRedirection 0 -TimeoutSec 15 -ErrorAction SilentlyContinue
                    if ($resp) {
                        $stalwartStatus = [int]$resp.StatusCode
                        if ($stalwartStatus -in 200, 301, 302, 307, 308) {
                            $autoDiscoveryWorks = $true; break
                        }
                    }
                } catch {
                    # 3xx with -MaximumRedirection 0 throws into here. Pull
                    # the status from the response. Anything other than 502
                    # (Tailscale-can't-reach-upstream) or 504 (timeout)
                    # proves Stalwart is responding.
                    $exResp = $null
                    try { $exResp = $_.Exception.Response } catch {}
                    if ($exResp) {
                        $stalwartStatus = [int]$exResp.StatusCode
                        if ($stalwartStatus -in 301, 302, 307, 308) {
                            $autoDiscoveryWorks = $true; break
                        }
                    }
                }
                Start-Sleep -Seconds 5
            }

            if ($autoDiscoveryWorks) {
                Write-Ok "iOS CalDAV auto-discovery reachable at $publicUrl (well-known $stalwartStatus)"
            } else {
                $statusInfo = if ($stalwartStatus) { " (last status: $stalwartStatus)" } else { "" }
                Write-Warn "Couldn't confirm /.well-known/caldav redirects$statusInfo."
                Write-Warn "Funnel propagation can take 1-2 minutes - test manually:"
                Write-Warn "  curl.exe -is $publicUrl/.well-known/caldav"
                Write-Warn "Expect: HTTP/1.1 307 Temporary Redirect with location: /dav/cal"
            }

            # Defense-in-depth: confirm the admin UI stays local-only.
            Write-Host "   Confirming /admin is NOT exposed on Funnel ..." -ForegroundColor White
            $adminLeaked = $false
            try {
                $adminResp = Invoke-WebRequest -Uri "$publicUrl/admin" -Method GET -UseBasicParsing `
                    -MaximumRedirection 0 -TimeoutSec 15 -ErrorAction SilentlyContinue
                # Any 2xx/3xx from the admin path means it was proxied through.
                if ($adminResp -and $adminResp.StatusCode -lt 400) { $adminLeaked = $true }
            } catch {
                # 404 from Eidetic's catch-all is the expected, safe outcome.
            }

            if ($adminLeaked) {
                Write-Err "Stalwart admin UI is reachable through Funnel - this MUST NOT happen."
                Write-Err "Inspect: $tsExe serve status"
                Write-Err "Then remove any '/' or '/admin' mapping pointing at port 8080 with:"
                Write-Err "  $tsExe serve --https=443 --set-path=/admin off"
                throw "admin UI leaked on Funnel"
            }
            Write-Ok "/admin is NOT exposed (good)"
        } catch {
            Write-Err "Stalwart Funnel mount failed: $($_.Exception.Message)"
            Write-Warn "iPhone CalDAV setup won't work until this is resolved."
            Write-Warn "Common causes:"
            Write-Warn "  - Tailscale CLI too old (needs --set-path support; winget upgrade)"
            Write-Warn "  - Tailscale daemon not fully running (re-run after a few seconds)"
            Write-Warn "  - Funnel attribute revoked from this device in tailnet ACLs"
            Write-Warn "Continuing - re-run install.ps1 once the cause is fixed."
        }
    }
} elseif ($stalwartCaldavConfigured) {
    Write-Warn "Stalwart is configured but Funnel isn't - skipping iPhone CalDAV mount"
    Write-Warn "Re-run install.ps1 with Funnel enabled to expose CalDAV to iPhone"
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
