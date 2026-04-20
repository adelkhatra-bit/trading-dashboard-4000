param([string]$action)

$port = 4000
$cloudflaredExe = "C:\ProgramData\chocolatey\bin\cloudflared.exe"

function Stop-Port4000 {
    $conns = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    if ($conns) {
        $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($procId in $pids) {
            try { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } catch {}
        }
    }
}

function Stop-AllNode {
    Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

function Wait-PortFree {
    $max = 10
    for ($i=0; $i -lt $max; $i++) {
        $busy = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
        if (-not $busy) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Test-Server {
    try {
        $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:4000/extension/data" -TimeoutSec 5
        Write-Host "SERVER RESPONSE:" -ForegroundColor Green
        Write-Host $r.Content
    } catch {
        Write-Host "SERVER TEST FAILED" -ForegroundColor Red
        Write-Host $_.Exception.Message
    }
}

function Stop-AutoAgents {
    try {
        Invoke-WebRequest -UseBasicParsing -Method POST "http://127.0.0.1:4000/agents/runtime/stop" -TimeoutSec 5 | Out-Null
        Write-Host "AUTO-AGENTS STOPPED (runtime loop disabled)" -ForegroundColor Cyan
    } catch {
        Write-Host "Could not stop auto-agents: $($_.Exception.Message)" -ForegroundColor DarkYellow
    }
}

function Start-Server {
    $projectDir = "C:\Users\97156\OneDrive\Desktop\trading-boulot"
    Start-Process powershell -WorkingDirectory $projectDir -ArgumentList "-NoExit","-Command","node server.js"
    Start-Sleep -Seconds 3
}

function Start-Tunnel {
    if (-not (Test-Path $cloudflaredExe)) {
        Write-Host "cloudflared non trouve: $cloudflaredExe" -ForegroundColor Red
        return
    }
    Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    $logFile = "$env:TEMP\cloudflared-adel.log"
    Start-Process -FilePath $cloudflaredExe `
        -ArgumentList "tunnel","--url","http://localhost:$port","--no-autoupdate","--logfile","$logFile" `
        -WindowStyle Hidden
    Write-Host "Tunnel cloudflared demarre (log: $logFile)" -ForegroundColor Cyan
    Start-Sleep -Seconds 8
    $tunnelUrl = Select-String -Path $logFile -Pattern "trycloudflare\.com" -ErrorAction SilentlyContinue |
        Select-Object -Last 1 |
        ForEach-Object { if ($_ -match "(https://[^\s]+trycloudflare\.com)") { $Matches[1] } }
    if ($tunnelUrl) {
        $webhookUrl = "$tunnelUrl/tradingview/live"
        Write-Host ""
        Write-Host "====================================================" -ForegroundColor Green
        Write-Host "  BRIDGE TV ACTIF — URL PINE SCRIPT:" -ForegroundColor Green
        Write-Host "  $webhookUrl" -ForegroundColor Yellow
        Write-Host "====================================================" -ForegroundColor Green
        Write-Host ""
        Set-Content -Path "C:\Users\97156\OneDrive\Desktop\trading-boulot\bridge\out\tunnel-url.txt" -Value $webhookUrl
    } else {
        Write-Host "URL tunnel non encore disponible — verifier $logFile" -ForegroundColor Yellow
    }
}

switch ($action) {
    "stop" {
        Stop-Port4000
        Stop-AllNode
        Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        Write-Host "BOULOT SERVER STOPPED" -ForegroundColor Yellow
    }
    "start" {
        Stop-Port4000
        Start-Sleep -Seconds 2
        Start-Server
        Stop-AutoAgents
        Start-Tunnel
        Test-Server
    }
    "restart" {
        Stop-Port4000
        Start-Sleep -Seconds 2
        if (-not (Wait-PortFree)) {
            Write-Host "PORT 4000 STILL BUSY" -ForegroundColor Red
            exit 1
        }
        Start-Server
        Stop-AutoAgents
        Start-Tunnel
        Test-Server
    }
    "tunnel" {
        Start-Tunnel
    }
    "status" {
        $busy = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
        if ($busy) {
            Write-Host "PORT 4000 ACTIVE (boulot server running)" -ForegroundColor Green
            $busy | Format-Table -AutoSize
        } else {
            Write-Host "PORT 4000 FREE / BOULOT SERVER OFFLINE" -ForegroundColor Red
        }
        $cf = Get-Process cloudflared -ErrorAction SilentlyContinue
        if ($cf) {
            Write-Host "TUNNEL cloudflared ACTIF (PID $($cf.Id))" -ForegroundColor Green
            $saved = "C:\Users\97156\OneDrive\Desktop\trading-boulot\bridge\out\tunnel-url.txt"
            if (Test-Path $saved) { Write-Host "Webhook URL: $(Get-Content $saved)" -ForegroundColor Yellow }
        } else {
            Write-Host "TUNNEL cloudflared INACTIF" -ForegroundColor Red
        }
    }
    default {
        Write-Host "Usage: .\run.ps1 stop|start|restart|tunnel|status"
    }
}
