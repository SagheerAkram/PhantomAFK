#!/data/data/com.termux/files/usr/bin/bash
export PREFIX=/data/data/com.termux/files/usr
export PATH=$PREFIX/bin:/system/bin:$PATH
export LD_LIBRARY_PATH=$PREFIX/lib

# Ensure Android does not sleep the CPU while running 24/7
termux-wake-lock 2>/dev/null

echo "=========================================================="
echo "👻 PhantomAFK: 24/7 Minecraft Sentinel Daemon"
echo "📱 Platform: Android (Termux Runtime)"
echo "🛡️ Mode: Infinite Supervisor Loop"
echo "=========================================================="

BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$BOT_DIR/phantom_runtime.log"

cd "$BOT_DIR" || exit 1

while true; do
  echo "[$(date +'%Y-%m-%d %T')] Starting PhantomAFK Sentinel..." >> "$LOG_FILE"
  
  # Run bot process and stream output to log
  node phantom_afk.js >> "$LOG_FILE" 2>&1
  EXIT_CODE=$?
  
  echo "[$(date +'%Y-%m-%d %T')] Process exited with code $EXIT_CODE. Restarting in 5s..." >> "$LOG_FILE"
  
  # Keep log file bounded to last 5000 lines to preserve phone storage
  if [ -f "$LOG_FILE" ]; then
    tail -n 5000 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
  fi
  
  sleep 5
done
