#!/bin/zsh
# Local voice transcription: whisper.cpp on the Mac GPU (Metal) + large-v3-turbo model,
# as a launchd service on 127.0.0.1:8178. Audio never leaves the machine.
set -e
# WHISPER_DIR: where to build and keep the model (the Mac bridge uses ~/.mainframe-mac/whisper).
if [ -n "${WHISPER_DIR:-}" ]; then mkdir -p "$WHISPER_DIR"/data/models "$WHISPER_DIR"/vendor; cd "$WHISPER_DIR"; else cd "$(dirname "$0")/.."; fi
DIR="$(pwd)"
PORT="${WHISPER_PORT:-8178}"
# A fixed language skips detection, a second pass over the audio: 1.6 s instead of 3 s for
# a 10 s voice note on an M2. WHISPER_LANG=auto detects it (needed for mixed-language chats).
LANG_HINT="${WHISPER_LANG:-ru}"
MODEL="$DIR/data/models/ggml-large-v3-turbo-q5_0.bin"
LABEL="com.kai.whisper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

command -v ffmpeg >/dev/null || brew install ffmpeg
# Homebrew in /usr/local on Apple Silicon has no bottles and would compile LLVM for hours,
# so whisper.cpp is built from its latest release tag (about two minutes, needs cmake).
SERVER="$(command -v whisper-server || true)"
if [ -z "$SERVER" ]; then
  SERVER="$DIR/vendor/whisper.cpp/build/bin/whisper-server"
  if [ ! -x "$SERVER" ]; then
    command -v cmake >/dev/null || brew install cmake
    TAG=$(git ls-remote --tags --refs https://github.com/ggml-org/whisper.cpp 'v1.*' | awk -F/ '{print $3}' | sort -V | tail -1)
    echo "Собираю whisper.cpp $TAG с поддержкой видеокарты (Metal)..."
    rm -rf vendor/whisper.cpp
    git -c advice.detachedHead=false clone -q --depth 1 --branch "$TAG" https://github.com/ggml-org/whisper.cpp vendor/whisper.cpp
    # Command Line Tools on new macOS can ship a clang that does not look in the SDK for
    # the C++ standard library ('mutex' file not found): point it there explicitly.
    SDK="$(xcrun --show-sdk-path)"
    CXXFLAGS_EXTRA=""
    [ -f "$SDK/usr/include/c++/v1/mutex" ] && CXXFLAGS_EXTRA="-isystem $SDK/usr/include/c++/v1"
    cmake -S vendor/whisper.cpp -B vendor/whisper.cpp/build -Wno-dev -Wno-deprecated -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_OSX_SYSROOT="$SDK" -DCMAKE_CXX_FLAGS="$CXXFLAGS_EXTRA" \
      -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_OPENMP=OFF -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF >/dev/null
    cmake --build vendor/whisper.cpp/build -j 8 --target whisper-server 2>&1 | grep -E "error|Error" || true
    [ -x "$SERVER" ] || { echo "Сборка whisper.cpp не удалась, смотри ошибки выше."; exit 1; }
  fi
fi
FFMPEG_DIR="$(dirname "$(command -v ffmpeg)")"

mkdir -p data/models data/logs "$HOME/Library/LaunchAgents"
if [ ! -s "$MODEL" ]; then
  echo "Скачиваю модель large-v3-turbo (~550 МБ)..."
  curl -fL --retry 3 -o "$MODEL.part" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
  mv "$MODEL.part" "$MODEL"
fi

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$SERVER</string>
    <string>--host</string><string>127.0.0.1</string>
    <string>--port</string><string>$PORT</string>
    <string>-m</string><string>$MODEL</string>
    <string>-l</string><string>$LANG_HINT</string>
    <string>-nt</string>
    <string>-t</string><string>$(sysctl -n hw.perflevel0.physicalcpu 2>/dev/null || echo 4)</string>
    <string>-bo</string><string>1</string>
    <string>--convert</string>
    <string>--inference-path</string><string>/v1/audio/transcriptions</string>
    <string>--tmp-dir</string><string>$DIR/data/whisper-tmp</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$FFMPEG_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/data/logs/whisper.log</string>
  <key>StandardErrorPath</key><string>$DIR/data/logs/whisper.log</string>
</dict></plist>
PL
mkdir -p data/whisper-tmp

DOMAIN="gui/$(id -u)"
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  for i in {1..30}; do
    launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
    sleep 0.5
  done
fi
for i in {1..5}; do
  launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null && break
  [ $i -eq 5 ] && { echo "Не удалось загрузить службу whisper."; exit 1; }
  sleep 2
done
echo "Готово: расшифровка голосовых на http://127.0.0.1:$PORT (логи: data/logs/whisper.log)"
