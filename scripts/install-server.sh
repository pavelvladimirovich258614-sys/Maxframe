#!/bin/bash
# Установка личного мейнфрейма на чистый сервер Ubuntu 22.04 или 24.04 (x86 или ARM).
#   curl -fsSL <адрес репозитория>/raw/main/scripts/install-server.sh | bash
# или из клона репозитория: bash scripts/install-server.sh
# Что делает: подкачка, файрвол, Node 24, Caddy (https на адресе вида 1-2-3-4.sslip.io),
# код в ~/mainframe, служба systemd. Потом по шагам спрашивает токен бота MAX, ключ MiniMax,
# имя владельца, режим бота (опрос событий или вебхук) и Mac, если он нужен.
# Повторный запуск безопасен: уже сделанное пропускается.
#
# Флаги для проверки на занятом сервере: --dir DIR --port PORT --service NAME --no-caddy --no-system
set -euo pipefail

DIR="$HOME/mainframe"; PORT=7777; SERVICE=mainframe; CADDY=1; SYSTEM=1
REPO_URL="${MAINFRAME_REPO:-https://github.com/qlmsv/mainframe.git}"
NEED_TOKEN=0; NEED_KEY=0
while [ $# -gt 0 ]; do case "$1" in
  --dir) DIR="$2"; shift 2;; --port) PORT="$2"; shift 2;; --service) SERVICE="$2"; shift 2;;
  --no-caddy) CADDY=0; shift;; --no-system) SYSTEM=0; shift;; *) echo "Неизвестный флаг $1"; exit 1;;
esac; done

say() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ask() { local q="$1" def="${2:-}" v; read -r -p "$q${def:+ [$def]}: " v < /dev/tty || true; echo "${v:-$def}"; }
set_env() { local k="$1" v="$2" f="$DIR/.env"; if grep -q "^$k=" "$f"; then sed -i "s|^$k=.*|$k=$v|" "$f"; else echo "$k=$v" >> "$f"; fi; }
# Значение ключа из .env (пусто, если ключа нет).
env_get() { grep "^$1=" "$DIR/.env" 2>/dev/null | cut -d= -f2- || true; }
# Ключи прошлой схемы (Telegram и Claude) мейнфрейм больше не читает: убираем их из .env.
drop_env() { local f="$DIR/.env" pat; [ -f "$f" ] || return 0; for pat in "$@"; do sed -i "/^$pat/d" "$f"; done; }

[ "$(id -u)" = 0 ] && { echo "Запусти от обычного пользователя с sudo (на AWS это ubuntu), не от root."; exit 1; }
export DEBIAN_FRONTEND=noninteractive

if [ "$SYSTEM" = 1 ]; then
  say "Система: пакеты, подкачка, файрвол, часовой пояс"
  sudo apt-get update -qq
  sudo apt-get install -y -qq git sqlite3 build-essential python3-venv ufw fail2ban unattended-upgrades ffmpeg jq curl >/dev/null
  if ! swapon --show | grep -q . && [ "$(free -m | awk '/Mem:/{print $2}')" -lt 3500 ]; then
    sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
    echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null
  fi
  TZ_NEW=$(ask "Часовой пояс (для сводок и расписания)" "$(timedatectl show -p Timezone --value 2>/dev/null || echo UTC)")
  sudo timedatectl set-timezone "$TZ_NEW" || true
  sudo sed -i "s/^#\?PasswordAuthentication.*/PasswordAuthentication no/" /etc/ssh/sshd_config && sudo systemctl reload ssh || true
  sudo ufw allow OpenSSH >/dev/null; sudo ufw allow 80/tcp >/dev/null; sudo ufw allow 443/tcp >/dev/null; sudo ufw --force enable >/dev/null
  sudo systemctl enable --now fail2ban >/dev/null 2>&1 || true
  if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
    curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - >/dev/null 2>&1 && sudo apt-get install -y -qq nodejs >/dev/null
  fi
  # Mac projects keep their Mac paths on the server: /Users must be writable for their empty folders.
  sudo mkdir -p /Users && sudo chown "$USER" /Users
fi
export PATH="$HOME/.local/bin:$PATH"

say "Код мейнфрейма в $DIR"
if [ ! -d "$DIR/.git" ] && [ ! -f "$DIR/src/index.js" ]; then
  if [ -f "$(dirname "$0")/../src/index.js" ] && [ "$(cd "$(dirname "$0")/.." && pwd)" != "$DIR" ]; then
    mkdir -p "$DIR" && cp -r "$(dirname "$0")/.."/{src,public,scripts,kb,package.json,package-lock.json,mcp.example.json,.env.example,README.md} "$DIR"/ 2>/dev/null || true
  else
    git clone -q "$REPO_URL" "$DIR"
  fi
fi
cd "$DIR"
# Зависимости ровно те, что в package.json: клиент MAX, планировщик и валидатор.
npm ci --omit=dev --no-audit --no-fund >/dev/null

say "Настройки"
[ -f .env ] || cp .env.example .env
chmod 600 .env
# Старые ключи Telegram и Claude в .env больше не нужны.
drop_env 'BOT_TOKEN=' 'OWNER_TG_ID=' 'SOCIAL_TG_CHANNEL=' 'TELEGRAM_' 'CLAUDE_' 'TG_MCP_'
# Старый режим прав (acceptEdits/default) больше не понимается: заменяем на допустимый.
PM=$(env_get PERMISSION_MODE)
case "$PM" in bypassPermissions|ask|deny) : ;; *) set_env PERMISSION_MODE bypassPermissions;; esac
IP=$(curl -fsS -4 https://checkip.amazonaws.com 2>/dev/null || curl -fsS -4 https://ifconfig.me 2>/dev/null || true)
[ -n "$IP" ] || { echo "Не удалось определить внешний IP сервера: проверь интернет и запусти скрипт снова."; exit 1; }
HOSTNAME_PUBLIC="${IP//./-}.sslip.io"
set_env HOST 127.0.0.1
set_env PORT "$PORT"
set_env TUNNEL off
[ "$CADDY" = 1 ] && set_env PUBLIC_URL "https://$HOSTNAME_PUBLIC"
set_env WORKSPACE_DIR "$HOME/workspace"; mkdir -p "$HOME/workspace"
set_env SERVER_DIRS "$HOME/workspace"
grep -q "^OWNER_NAME=..*" .env || set_env OWNER_NAME "$(ask 'Как тебя зовут (так агент будет к тебе обращаться)')"
grep -q "^SOCIAL_MAX_CHAT_ID=..*" .env || set_env SOCIAL_MAX_CHAT_ID "$(ask 'Канал в MAX для постов и статистики: числовый chat_id (Enter — нет)' '')"

say "Бот MAX и модель MiniMax"
if ! grep -q "^MAX_BOT_TOKEN=..*" .env; then
  echo "Создай бота в MAX: MAX → Чат-боты → ⋮ → Настройки, там токен."
  T=$(ask 'Токен бота MAX (Enter — добавишь позже)') || T=""
  if [ -n "$T" ]; then
    set_env MAX_BOT_TOKEN "$T"
  else
    NEED_TOKEN=1
    echo "Оставляю MAX_BOT_TOKEN пустым: пульт поднимется, бот заработает после правки .env и перезапуска службы."
  fi
fi
if ! grep -q "^MINIMAX_API_KEY=..*" .env; then
  echo "Ключ MiniMax: https://platform.minimax.io (международный регион, api.minimax.io)."
  K=$(ask 'Ключ MiniMax API (Enter — добавишь позже)') || K=""
  if [ -n "$K" ]; then
    set_env MINIMAX_API_KEY "$K"
  else
    NEED_KEY=1
    echo "Оставляю MINIMAX_API_KEY пустым: без него исполнитель не ответит, впиши ключ в .env и перезапусти службу."
  fi
fi
# MAX_OWNER_ID и MAX_WEBHOOK_SECRET можно не заполнять: бота привяжешь кодом со страницы
# «Система», а секрет вебхука мейнфрейм сгенерирует сам (data/max-webhook-secret.secret).

if [ "$CADDY" = 1 ]; then
  say "https для пульта: $HOSTNAME_PUBLIC"
  if ! command -v caddy >/dev/null; then
    sudo apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
    curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg --yes
    curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    sudo apt-get update -qq && sudo apt-get install -y -qq caddy >/dev/null
  fi
  printf '%s {\n  encode gzip\n  reverse_proxy 127.0.0.1:%s {\n    flush_interval -1\n  }\n}\n' "$HOSTNAME_PUBLIC" "$PORT" | sudo tee /etc/caddy/Caddyfile >/dev/null
  sudo systemctl reload caddy || sudo systemctl restart caddy
  echo "Если у сервера облачный файрвол (AWS Security Group и т.п.), открой в нём порты 80 и 443."
fi

say "Как получать события бота"
MODE=$(ask 'Режим: 1 — опрос событий (проще, работает сразу), 2 — вебхук (production, нужен https на 443)' '1') || MODE=1
if [ "$MODE" = "2" ]; then
  U=$(ask 'Адрес пульта для вебхука (https, без порта)' "$(env_get PUBLIC_URL)") || U=""
  case "$U" in
    https://*)
      set_env PUBLIC_URL "$U"; set_env MAX_LONG_POLLING 0
      echo "Вебхук: MAX будет слать события на $U/max/webhook. Секрет мейнфрейм сгенерирует сам."
      ;;
    *)
      echo "Адрес не https: оставляю опрос событий (MAX_LONG_POLLING=1)."
      set_env MAX_LONG_POLLING 1
      ;;
  esac
else
  set_env MAX_LONG_POLLING 1
  echo "Опрос событий: бот сам спрашивает MAX обновления (MAX_LONG_POLLING=1)."
fi

say "Mac (необязательно)"
MU=$(ask 'Есть Mac? Имя пользователя на Mac (Enter — без Mac)' '') || MU=""
if [ -n "$MU" ]; then
  set_env MAC_USER "$MU"
  set_env MAC_SSH_PORT 2222
  # MAC_RUNNER: маркер режима «сервер с Mac» — команды проектов идут по SSH (src/mac-remote.js).
  set_env MAC_RUNNER 1
  echo "Режим сервера с Mac: команды проектов вне $HOME/workspace будут выполняться на Mac по SSH."
else
  echo "Без MAC_USER проекты выполняются только на сервере."
  # whisper на сервере не запущен: голосовые расшифровывает Mac (scripts/install-mac.sh).
  set_env WHISPER_URL off
fi
[ -f mcp.json ] || echo '{ "mcpServers": {} }' > mcp.json

say "Служба $SERVICE"
sudo tee /etc/systemd/system/$SERVICE.service >/dev/null <<EOF
[Unit]
Description=Personal mainframe
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$DIR
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$HOME
ExecStart=$(command -v node) --disable-warning=ExperimentalWarning $DIR/src/index.js
Restart=always
RestartSec=5
StandardOutput=append:$DIR/data/logs/mainframe.log
StandardError=append:$DIR/data/logs/mainframe.log

[Install]
WantedBy=multi-user.target
EOF
mkdir -p data/logs data/backups
sudo systemctl daemon-reload && sudo systemctl enable --now "$SERVICE" >/dev/null 2>&1
# Бэкап раз в сутки: строка добавляется один раз, старая не дублируется.
{ crontab -l 2>/dev/null | grep -v "$DIR/scripts/backup.sh" || true
  echo "30 3 * * * MAINFRAME_DIR=$DIR $DIR/scripts/backup.sh >> $DIR/data/logs/backup.log 2>&1"; } | crontab -
for i in $(seq 1 30); do curl -fs -o /dev/null -H 'x-mf-client: 1' "http://127.0.0.1:$PORT/api/state" && break; sleep 2; done

TOKEN=$(cat data/dashboard-token.secret 2>/dev/null || true)
CODE=$(cat data/pairing-code.secret 2>/dev/null || true)
say "Готово"
if [ -n "$CODE" ]; then
  echo "1. Открой своего бота в MAX и отправь ему: /start $CODE"
else
  echo "1. Код привязки бота смотри на странице «Система» в пульте: отправь его боту в MAX как /start КОД"
fi
[ "$CADDY" = 1 ] && echo "2. Пульт в браузере (личная ссылка, никому не пересылай): https://$HOSTNAME_PUBLIC/?token=$TOKEN"
echo "3. Если есть Mac: на нём выполни установку моста (почта, календарь, голосовые, команды проектов):"
echo "   bash <(curl -fsSL ${REPO_URL%.git}/raw/main/scripts/install-mac.sh) $USER@$IP"
[ "$NEED_TOKEN" = 1 ] && echo "Внимание: MAX_BOT_TOKEN пуст — бот молчит, пока не впишешь токен и не перезапустишь службу."
[ "$NEED_KEY" = 1 ] && echo "Внимание: MINIMAX_API_KEY пуст — исполнитель не ответит, пока не впишешь ключ и не перезапустишь службу."
echo "Перезапуск после правки .env: sudo systemctl restart $SERVICE"
