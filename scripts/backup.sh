#!/bin/bash
# Nightly backup: database snapshot, shared memory and knowledge base, 14 days kept on the
# server, and a copy to the owner's Mac through the bridge tunnel when the Mac is on.
set -e
M=${MAINFRAME_DIR:-$(cd "$(dirname "$0")/.." && pwd)}
envv() { grep "^$1=" "$M/.env" 2>/dev/null | cut -d= -f2-; }
WS=$(envv WORKSPACE_DIR); WS=${WS:-$HOME/workspace}
MEM="$WS/$(envv MEMORY_DIR_NAME)"; [ "$(envv MEMORY_DIR_NAME)" ] || MEM="$WS/Память"
D=$M/data/backups; mkdir -p $D
STAMP=$(date +%Y%m%d)
sqlite3 $M/data/mainframe.db ".backup $D/mainframe-$STAMP.db"
tar -czf $D/memory-$STAMP.tgz -C "$(dirname "$MEM")" "$(basename "$MEM")" -C "$M" kb 2>/dev/null || true
chmod 600 $D/*
find $D -type f -mtime +14 -delete
MAC_USER=$(envv MAC_USER)
if [ -n "$MAC_USER" ] && timeout 3 bash -c "</dev/tcp/127.0.0.1/2222" 2>/dev/null; then
  rsync -a -e "ssh -p 2222 -i $HOME/.ssh/to_mac -o BatchMode=yes" $D/ "$MAC_USER@127.0.0.1:mainframe-backups/" && echo "copied to Mac"
fi
