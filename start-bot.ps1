# FTmarket bot launcher (long polling, no web server, no tunnel)
# Run: powershell -ExecutionPolicy Bypass -File start-bot.ps1

$ErrorActionPreference = 'SilentlyContinue'
$dir = 'C:\Users\Admin\Desktop\fpmarket\server'
$token = '9185949916:AAGHGe6aWu1f2fDyyIXZODJLFK_18pt_HuA'

Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Stopping old bot..."
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*bot.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# Снимаем webhook, если он остался от старой версии
Invoke-RestMethod -Uri "https://api.telegram.org/bot$token/deleteWebhook?drop_pending_updates=true" -TimeoutSec 20 | Out-Null

Start-Sleep -Seconds 1

Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Starting FTmarket bot..."
Start-Process -FilePath 'node' -ArgumentList 'bot.js' -WorkingDirectory $dir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dir '..' 'bot.log') -RedirectStandardError (Join-Path $dir '..' 'bot-error.log') | Out-Null

Start-Sleep -Seconds 5
$proc = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*bot.js*' }
if ($proc) {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] OK. Bot @fanpuymarket_bot is running."
} else {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] ERROR. Check bot-error.log"
}
