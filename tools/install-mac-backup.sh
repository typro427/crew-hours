#!/bin/bash
# Crew Hours: nightly backup from Render to your AirPort disk (Mac).
# Run once in Terminal:   bash ~/Downloads/install-mac-backup.sh
# Run again any time to change the settings. To remove it: bash install-mac-backup.sh --remove
set -e
APP_URL="https://crew-hours.onrender.com"
LABEL="com.mycrewhours.backup"
HOME_DIR="$HOME/Library/Application Support/CrewHours"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ "$1" = "--remove" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"; security delete-generic-password -s "$LABEL" >/dev/null 2>&1 || true
  echo "Removed. Backups already saved are kept."; exit 0
fi

echo ""
echo "=== Crew Hours nightly backup ==="
echo ""
echo "1) Your AirPort disk must be connected in Finder (it shows under Locations)."
echo "   These are the disks connected right now:"
ls /Volumes | grep -v "^Macintosh HD" | sed 's/^/     - /' || true
echo ""
read -r -p "   Type the AirPort disk's name exactly as listed above: " VOL
if [ ! -d "/Volumes/$VOL" ]; then echo "   Can't find /Volumes/$VOL. Connect it in Finder first, then run this again."; exit 1; fi
SERVER=$(mount | grep " on /Volumes/$VOL " | sed -E 's#^//([^@]*@)?([^/]+)/([^ ]+) on .*#smb://\2/\3#' | head -1)
case "$SERVER" in smb://*) ;; *) SERVER="" ;; esac
echo ""
read -r -s -p "2) Paste BACKUP_TOKEN (Render > crew-hours > Environment), then press Return: " TOKEN; echo ""
[ -n "$TOKEN" ] || { echo "   No token entered."; exit 1; }

echo "   Checking the token..."
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$APP_URL/api/backup")
[ "$CODE" = "200" ] || { echo "   The app said $CODE. Check the token and try again."; exit 1; }

# Keep the token in the Mac's Keychain, not in a file.
security delete-generic-password -s "$LABEL" >/dev/null 2>&1 || true
security add-generic-password -s "$LABEL" -a crewhours -w "$TOKEN"

mkdir -p "$HOME_DIR/pending" "$HOME/Library/LaunchAgents"
cat > "$HOME_DIR/backup.sh" <<EOF
#!/bin/bash
# Runs nightly. Saves to the AirPort disk; if it isn't reachable, saves on this Mac and copies it over next time.
APP_URL="$APP_URL"; VOL="$VOL"; SERVER="$SERVER"; LABEL="$LABEL"
PENDING="$HOME_DIR/pending"
TOKEN=\$(security find-generic-password -s "\$LABEL" -w 2>/dev/null)
note() { osascript -e "display notification \"\$1\" with title \"Crew Hours backup\"" >/dev/null 2>&1; }
FILE="crewhours-\$(date +%F).json"
if ! curl -fsS --retry 3 --retry-delay 60 -m 300 -H "Authorization: Bearer \$TOKEN" "\$APP_URL/api/backup" -o "\$PENDING/\$FILE.part"; then
  rm -f "\$PENDING/\$FILE.part"; note "Couldn't download tonight's backup. Will try again tomorrow."; exit 1
fi
mv "\$PENDING/\$FILE.part" "\$PENDING/\$FILE"
# Reconnect the AirPort disk if needed (uses the password saved in Keychain).
if [ ! -d "/Volumes/\$VOL" ] && [ -n "\$SERVER" ]; then osascript -e "mount volume \"\$SERVER\"" >/dev/null 2>&1; sleep 5; fi
if [ -d "/Volumes/\$VOL" ]; then
  DEST="/Volumes/\$VOL/CrewHoursBackups"; mkdir -p "\$DEST"
  for f in "\$PENDING"/crewhours-*.json; do [ -e "\$f" ] && cp "\$f" "\$DEST/" && rm "\$f"; done
  find "\$DEST" -name 'crewhours-*.json' -mtime +180 -delete
  echo "\$(date) saved \$FILE to \$DEST"
else
  note "AirPort disk not found. Saved on this Mac; it will be copied over next time."
fi
EOF
chmod 700 "$HOME_DIR/backup.sh"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$HOME_DIR/backup.sh</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>2</integer><key>Minute</key><integer>15</integer></dict>
  <key>StandardOutPath</key><string>$HOME_DIR/backup.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/backup.log</string>
</dict></plist>
EOF
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "   Running a first backup now..."
/bin/bash "$HOME_DIR/backup.sh" && ls -lh "/Volumes/$VOL/CrewHoursBackups" | tail -3
echo ""
echo "Done. Every night at 2:15 AM (or when the Mac next wakes up) a copy goes to $VOL > CrewHoursBackups."
echo "Copies older than 6 months are deleted. Log: $HOME_DIR/backup.log"
