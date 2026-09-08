$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $ProjectRoot "logs"
$OutLog = Join-Path $LogDir "claw-task-hub-launcher.out.log"
$ErrLog = Join-Path $LogDir "claw-task-hub-launcher.err.log"
$StartScript = Join-Path $PSScriptRoot "start-clawtaskhub.ps1"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Add-LaunchLog {
  param([string]$Message)
  Add-Content -Path $OutLog -Value "[$(Get-Date -Format o)] $Message"
}

function Invoke-BunInstall {
  param([string[]]$Arguments)
  $process = Start-Process `
    -FilePath "bun.exe" `
    -ArgumentList $Arguments `
    -WorkingDirectory $ProjectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $OutLog `
    -RedirectStandardError $ErrLog `
    -Wait `
    -PassThru
  return $process.ExitCode
}

try {
  Add-LaunchLog "Launcher started from $ProjectRoot"

  if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "node_modules"))) {
    Add-LaunchLog "node_modules missing; running bun install --frozen-lockfile"
    $exitCode = Invoke-BunInstall -Arguments @("install", "--frozen-lockfile")
    if ($exitCode -ne 0) {
      Add-LaunchLog "frozen Bun install failed with $exitCode; running bun install"
      $exitCode = Invoke-BunInstall -Arguments @("install")
    }
    if ($exitCode -ne 0) {
      Add-LaunchLog "dependency install failed with $exitCode"
      exit $exitCode
    }
  }

  if (-not (Test-Path -LiteralPath $StartScript)) {
    Add-LaunchLog "start script missing: $StartScript"
    exit 1
  }

  & powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $StartScript
  if ($LASTEXITCODE -ne 0) {
    Add-LaunchLog "start script failed with $LASTEXITCODE"
    exit $LASTEXITCODE
  }

  Start-Process "http://localhost:5173"
  Add-LaunchLog "Launcher completed"
  exit 0
} catch {
  Add-LaunchLog "Launcher failed: $($_.Exception.Message)"
  exit 1
}
