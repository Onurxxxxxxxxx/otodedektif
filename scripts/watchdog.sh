#!/bin/bash
# Watchdog: restart Next.js server if it's not responding
if ! curl -s -o /dev/null --max-time 3 http://localhost:3000/ 2>/dev/null; then
  pkill -9 -f "node server.js" 2>/dev/null
  sleep 1
  cd /home/z/my-project/.next/standalone
  DATABASE_URL="file:/home/z/my-project/db/custom.db" PORT=3000 HOSTNAME=0.0.0.0 NODE_ENV=production \
    setsid node server.js > /tmp/next-server.log 2>&1 < /dev/null &
  disown $!
  echo $! > /tmp/next-server.pid
fi
