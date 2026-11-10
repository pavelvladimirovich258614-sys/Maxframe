#!/bin/zsh
# Автозапуск мейнфрейма при входе в macOS (launchd) и перезапуск при падении.
set -e
cd "$(dirname "$0")/.."
DIR="$(pwd)"
NODE="$(command -v node)"
LABEL="com.kai.mainframe"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents" data/logs
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string><string>--disable-warning=ExperimentalWarning</string><string>$DIR/src/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname "$NODE"):$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/data/logs/mainframe.log</string>
  <key>StandardErrorPath</key><string>$DIR/data/logs/mainframe.log</string>
</dict></plist>
PL
DOMAIN="gui/$(id -u)"
# bootout is asynchronous: wait until the old job is really gone, or bootstrap fails with error 5.
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  for i in {1..30}; do
    launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
    sleep 0.5
  done
fi
for i in {1..5}; do
  launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null && break
  [ $i -eq 5 ] && { echo "Не удалось загрузить службу. Попробуй ещё раз через пару секунд."; exit 1; }
  sleep 2
done
echo "Готово. Мейнфрейм запущен и будет стартовать сам: http://127.0.0.1:${PORT:-7777}"
echo "Логи: $DIR/data/logs/mainframe.log"
echo "Выключить: launchctl bootout gui/$(id -u)/$LABEL"
echo "Чтобы Mac не засыпал: Настройки → Аккумулятор → Не переходить в режим сна при выключенном дисплее (на питании)."
