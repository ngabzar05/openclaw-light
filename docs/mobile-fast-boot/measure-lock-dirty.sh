#!/usr/bin/env bash
# Ukur lock kotor LAB (fork Lane C, F2) — boot Gateway di atas lock basi
# yang namespace-nya TIDAK bisa diklasifikasi (simulasi D-12 PRoot/Groot).
#
# Cara pakai (dari root worktree lane-c, sesudah `pnpm build`):
#   docs/mobile-fast-boot/measure-lock-dirty.sh <label> off|on [timeout_s]
#
# Alur per run (state dir + HOME segar di /tmp/lane-c-lab/<label>/):
#   Fase 1 — buat state kotor yang realistis: boot gateway bersih (OFF),
#     tunggu /health 200, lalu kill -9 (meninggalkan owner file +
#     proyeksi gateway.state.lock + gateway.<hash>.lock + baris lease
#     sqlite — persis yang ditinggalkan Gateway yang mati mendadak).
#   Fase 2 — patch SEMUA payload lock: processNamespace diganti namespace
#     asing (host/boot_id/pid-ns lain) sehingga klasifikasi menjadi
#     "unknown" — inilah kondisi PRoot/Groot lintas restart (D-12). PID
#     tetap PID gateway yang sudah mati (provably dead).
#   Fase 3 — spawn gateway lagi dengan mode yang diuji dan ukur:
#     OFF (tanpa env)  -> ekspektasi: exit GatewayLockError ~95 dtk
#       (jalur namespace-error dibatasi heartbeat 95 dtk), TANPA /health.
#     ON (A1 + SINGLE_OWNER) -> ekspektasi: /health 200 ~waktu boot
#       bersih (~26 dtk [LAB]), lock basi direklamasi langsung.
#
# Hasil: <label>/dirty.log (log fase 1+3), <label>/timings.tsv,
#   <label>/phases.tsv (fase lock dari log fase 3), <label>/config.json.
# Semua angka [LAB] (VM x86_64, Node 24.22.1) — BUKAN angka perangkat.
set -u
umask 0077
LABEL="${1:-dirty1}"
MODE="${2:-off}"
TIMEOUT_S="${3:-300}"
if [ "$MODE" != "off" ] && [ "$MODE" != "on" ]; then
  echo "FATAL: mode harus off|on" >&2; exit 2
fi
# (Perbaikan Lane C #2: mkdir HARUS sebelum flock — sesudah restart VM
# /tmp kosong dan redirect lock gagal sebelum mkdir tercapai.)
mkdir -p /tmp/lane-c-lab
chmod 700 /tmp/lane-c-lab
exec 9>"/tmp/lane-c-lab/.measure-dirty-$LABEL.lock"
if ! flock -n 9; then
  echo "FATAL: run berlabel $LABEL lain masih jalan" >&2; exit 4
fi
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="/tmp/lane-c-lab/$LABEL"
HOME_DIR="$OUT/home"
STATE_DIR="$OUT/state"
mkdir -p /tmp/lane-c-lab
chmod 700 /tmp/lane-c-lab
mkdir -p "$OUT" "$HOME_DIR/.openclaw" "$STATE_DIR"

cat > "$STATE_DIR/openclaw.json" <<'EOF'
{
  "gateway": { "mode": "local", "port": 18789 },
  "agents": { "defaults": { "model": { "primary": "openai/gpt-4o" } } }
}
EOF
cp "$STATE_DIR/openclaw.json" "$OUT/config.json"

export HOME="$HOME_DIR"
export OPENCLAW_STATE_DIR="$STATE_DIR"
export OPENCLAW_GATEWAY_STARTUP_TRACE=1

if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:18789/health" 2>/dev/null; then
  echo "FATAL: port 18789 sudah menjawab sebelum spawn" >&2; exit 3
fi

# --- Fase 1: boot bersih lalu kill -9 -------------------------------------
echo "== fase 1: boot bersih (buat state kotor) =="
env -u OPENCLAW_MOBILE_BOOT -u OPENCLAW_MOBILE_SINGLE_OWNER \
  node "$ROOT/openclaw.mjs" gateway run --port 18789 > "$OUT/dirty.log" 2>&1 < /dev/null &
GATEWAY_PID=$!
for _ in $(seq 1 480); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:18789/health" 2>/dev/null || echo 000)"
  [ "$code" = "200" ] && break
  kill -0 "$GATEWAY_PID" 2>/dev/null || { echo "FATAL: gateway fase 1 mati sebelum /health (lihat $OUT/dirty.log)" >&2; exit 3; }
  sleep 0.25
done
[ "$code" = "200" ] || { echo "FATAL: /health tidak 200 dalam 120 dtk (fase 1)" >&2; exit 3; }
echo "fase 1: /health 200, pid=$GATEWAY_PID — kill -9"
kill -9 "$GATEWAY_PID" 2>/dev/null || true
wait "$GATEWAY_PID" 2>/dev/null || true
sleep 1

# --- Fase 2: patch namespace semua payload lock menjadi asing ------------
echo "== fase 2: patch processNamespace -> asing (simulasi D-12) =="
node --input-type=module -e "
import fs from 'node:fs';
import path from 'node:path';
const lockDir = process.argv[1];
const foreign = { platform: 'linux', host: 'foreign-host', identity: '00000000-0000-0000-0000-000000000000', pidNsInode: '999999999' };
let n = 0;
for (const name of fs.readdirSync(lockDir)) {
  if (!name.endsWith('.lock')) continue;
  const p = path.join(lockDir, name);
  try {
    const payload = JSON.parse(fs.readFileSync(p, 'utf8'));
    payload.processNamespace = foreign;
    fs.writeFileSync(p, JSON.stringify(payload));
    n += 1;
    console.log('patched', name, 'pid=' + payload.pid);
  } catch (e) { console.log('skip', name, String(e).slice(0, 80)); }
}
if (n === 0) { console.error('FATAL: tidak ada payload lock yang di-patch'); process.exit(1); }
" "$STATE_DIR/tmp/openclaw-$(id -u)"
# Lock dir default = $STATE_DIR/tmp/openclaw-<uid>; bila kosong, cari di mana saja.
LOCKDIR="$STATE_DIR/tmp/openclaw-$(id -u)"
if [ ! -d "$LOCKDIR" ] || [ -z "$(ls "$LOCKDIR"/*.lock 2>/dev/null)" ]; then
  echo "FATAL: lock dir $LOCKDIR tidak berisi *.lock sesudah fase 1" >&2
  find "$STATE_DIR" -name '*.lock' | head >&2
  exit 3
fi

# --- Fase 3: spawn ulang dengan mode yang diuji ---------------------------
echo "== fase 3: spawn ulang mode=$MODE =="
if [ "$MODE" = "on" ]; then
  export OPENCLAW_MOBILE_BOOT=1
  export OPENCLAW_MOBILE_SINGLE_OWNER=1
else
  unset OPENCLAW_MOBILE_BOOT OPENCLAW_MOBILE_SINGLE_OWNER
fi
SPAWN_EPOCH="$(date +%s.%N)"
node "$ROOT/openclaw.mjs" gateway run --port 18789 >> "$OUT/dirty.log" 2>&1 < /dev/null &
GATEWAY_PID=$!
echo "spawn pid=$GATEWAY_PID label=$LABEL mode=$MODE"
DEADLINE="$(awk -v s="$SPAWN_EPOCH" -v t="$TIMEOUT_S" 'BEGIN { printf "%.3f", s + t }')"
: > "$OUT/timings.tsv"
HEALTH_DT=""
while :; do
  NOW="$(date +%s.%N)"
  if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
    wait "$GATEWAY_PID" 2>/dev/null; EXIT_CODE=$?
    DT="$(awk -v a="$NOW" -v b="$SPAWN_EPOCH" 'BEGIN { printf "%.3f", a - b }')"
    echo -e "exit\t$DT\texit_code=$EXIT_CODE" >> "$OUT/timings.tsv"
    echo "gateway EXITED after ${DT}s exit_code=$EXIT_CODE (tanpa /health)"
    break
  fi
  if awk -v n="$NOW" -v d="$DEADLINE" 'BEGIN { exit !(n > d) }'; then
    echo -e "health\tTIMEOUT" >> "$OUT/timings.tsv"
    echo "TIMEOUT ${TIMEOUT_S}s tanpa /health dan tanpa exit"
    break
  fi
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:18789/health" 2>/dev/null || echo 000)"
  if [ "$code" = "200" ]; then
    HEALTH_DT="$(awk -v a="$NOW" -v b="$SPAWN_EPOCH" 'BEGIN { printf "%.3f", a - b }')"
    echo -e "health\t$HEALTH_DT" >> "$OUT/timings.tsv"
    echo "health 200 after ${HEALTH_DT}s"
    break
  fi
  sleep 0.25
done
if kill -0 "$GATEWAY_PID" 2>/dev/null; then
  # Beri waktu post-attach selesai bila /health tercapai, lalu hentikan.
  sleep 20
  kill "$GATEWAY_PID" 2>/dev/null || true
  sleep 5
  kill -9 "$GATEWAY_PID" 2>/dev/null || true
fi
wait "$GATEWAY_PID" 2>/dev/null || true
END_EPOCH="$(date +%s.%N)"
awk -v a="$END_EPOCH" -v b="$SPAWN_EPOCH" 'BEGIN { printf "total wall fase 3: %.1fs\n", a - b }'
grep -oE 'startup (trace|phase): [^ ]+ [0-9]+\.[0-9]+ms total=[0-9]+\.[0-9]+ms' "$OUT/dirty.log" \
  | sed -E 's/startup (trace|phase): ([^ ]+) ([0-9.]+)ms total=([0-9.]+)ms/\2\t\3\t\4/' \
  | awk '!seen[$1]++' > "$OUT/phases.tsv" || true
echo "--- timings ---"; cat "$OUT/timings.tsv"
echo "--- fase lock (fase 3) ---"
grep -E "gateway-lock|lock-acquire|gateway\.lock" "$OUT/phases.tsv" || echo "(tidak ada baris lock di phases.tsv)"
grep -iE "GatewayLockError|failed to acquire gateway state ownership|single-owner" "$OUT/dirty.log" | tail -5 || true
echo "log: $OUT/dirty.log"
