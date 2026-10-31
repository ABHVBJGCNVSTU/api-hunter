#!/bin/bash
# devup.sh — start the Next.js dev server if port 3000 is dead, wait until healthy.
cd /home/z/my-project
if curl -s -o /dev/null --max-time 3 http://localhost:3000/; then
  echo "SERVER ALREADY UP"
  exit 0
fi
setsid nohup bun run dev </dev/null >/dev/null 2>&1 &
for i in $(seq 1 45); do
  sleep 2
  if curl -s -o /dev/null --max-time 5 http://localhost:3000/; then
    echo "SERVER UP after ~$((i*2))s"
    exit 0
  fi
done
echo "SERVER FAILED TO COME UP"
exit 1
