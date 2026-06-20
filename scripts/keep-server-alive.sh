#!/bin/bash
# Keep Next.js server alive - restart if it dies
cd /home/z/my-project/.next/standalone
export DATABASE_URL="file:/home/z/my-project/db/custom.db"
export PORT=3000
export HOSTNAME=0.0.0.0
export NODE_ENV=production

while true; do
  # Check if server is alive
  if ! curl -s -o /dev/null --max-time 3 http://localhost:3000/; then
    echo "[$(date +%H:%M:%S)] Server dead, restarting..."
    pkill -9 -f "node server.js" 2>/dev/null
    sleep 1
    setsid node server.js > /tmp/next-server.log 2>&1 < /dev/null &
    disown $!
    echo $! > /tmp/next-server.pid
    sleep 3
    echo "[$(date +%H:%M:%S)] Restarted, PID: $(cat /tmp/next-server.pid)"
  fi
  sleep 5
done
