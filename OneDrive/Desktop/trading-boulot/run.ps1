param([string]$action)

$port = 4001

function Stop-Port4001 {
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
        $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:4001/extension/data" -TimeoutSec 5
        Write-Host "SERVER RESPONSE:" -ForegroundColor Green
        Write-Host $r.Content
    } catch {
        Write-Host "SERVER TEST FAILED" -ForegroundColor Red
        Write-Host $_.Exception.Message
    }
}

function Start-Server {
    $projectDir = "C:\Users\97156\OneDrive\Desktop\trading-boulot"
    Start-Process powershell -WorkingDirectory $projectDir -ArgumentList "-NoExit","-Command","node server.js"
    Start-Sleep -Seconds 3
}

switch ($action) {
    "stop" {
        Stop-Port4001
        Stop-AllNode
        Start-Sleep -Seconds 2
        Write-Host "BOULOT SERVER STOPPED" -ForegroundColor Yellow
    }
    "start" {
        Stop-Port4001
        Start-Sleep -Seconds 2
        Start-Server
        Test-Server
    }
    "restart" {
        Stop-Port4001
        Start-Sleep -Seconds 2
        if (-not (Wait-PortFree)) {
            Write-Host "PORT 4001 STILL BUSY" -ForegroundColor Red
            exit 1
        }
        Start-Server
        Test-Server
    }
    "status" {
        $busy = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
        if ($busy) {
            Write-Host "PORT 4001 ACTIVE (boulot server running)" -ForegroundColor Green
            $busy | Format-Table -AutoSize
        } else {
            Write-Host "PORT 4001 FREE / BOULOT SERVER OFFLINE" -ForegroundColor Red
        }
    }
    default {
        Write-Host "Usage: .\run.ps1 stop|start|restart|status"
    }
}
