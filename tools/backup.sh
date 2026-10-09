#!/bin/sh
# Nightly backup to your home storage (Mac/Linux/NAS). Edit these, then add to cron:  15 2 * * * /path/backup.sh
APP_URL="https://YOUR-APP.onrender.com"
TOKEN="PASTE-BACKUP_TOKEN-FROM-RENDER"
DIR="$HOME/CrewHoursBackups"
mkdir -p "$DIR"
curl -fsS -H "Authorization: Bearer $TOKEN" "$APP_URL/api/backup" -o "$DIR/crewhours-$(date +%F).json"
find "$DIR" -name 'crewhours-*.json' -mtime +90 -delete
