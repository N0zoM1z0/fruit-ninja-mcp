#!/bin/bash
# restart the dev port with the given adapter/mode/seed
ADAPTER=${1:-/output/intermediate/probe-adapter.js}
MODE=${2:-arcade}
SEED=${3:-7}
DUR=${4:-60}
if [ -f /work/port.pid ]; then kill "$(cat /work/port.pid)" 2>/dev/null; sleep 0.5; fi
rm -f /work/port.sock
cd /work
nohup node /opt/toolchain/fn/bin/fn-port.js --adapter "$ADAPTER" --socket /work/port.sock --mode "$MODE" --seed "$SEED" --duration "$DUR" --log > /work/port.log 2>&1 &
echo $! > /work/port.pid
sleep 5
cat /work/port.log
