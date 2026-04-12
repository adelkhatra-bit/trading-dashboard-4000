param([string]$action)

$port = 4000

function Stop-Server {
    Write-Host "Stopping server on port $port..."
    $p = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    if ($p) {
        Stop-Process -Id $p.OwningProcess -Force
    }
}

function Start-Server {
    Write-Host "Starting server..."
    Start-Process powershell -ArgumentList "node server.js"
}

switch ($action) {
    "stop" { Stop-Server }
    "start" { Start-Server }
    "restart" {
        Stop-Server
        Start-Sleep -Seconds 1
        Start-Server
    }
    default {
        Write-Host "Usage: .\run.ps1 stop|start|restart"
    }
}
