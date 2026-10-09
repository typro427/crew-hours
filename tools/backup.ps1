# Nightly backup to your home storage (Windows). Edit the 3 lines below, then add it to Task Scheduler.
$AppUrl    = "https://YOUR-APP.onrender.com"
$Token     = "PASTE-BACKUP_TOKEN-FROM-RENDER"
$BackupDir = "D:\CrewHoursBackups"

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$file = Join-Path $BackupDir ("crewhours-" + (Get-Date -Format "yyyy-MM-dd") + ".json")
Invoke-WebRequest -Uri "$AppUrl/api/backup" -Headers @{ Authorization = "Bearer $Token" } -OutFile $file
# keep 90 days
Get-ChildItem $BackupDir -Filter "crewhours-*.json" | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-90) } | Remove-Item
