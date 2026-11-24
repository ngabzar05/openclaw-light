#!/usr/bin/env bash
# Baseline LAB — ukur boot Gateway OpenClaw (fork lane A).
#
# Cara pakai (dari root worktree lane-a, sesudah `pnpm build`):
#   OPENCLAW_MOBILE_BOOT= docs/mobile-fast-boot/measure-baseline.sh <label> [timeout_s]
#   OPENCLAW_MOBILE_BOOT=1 docs/mobile-fast-boot/measure-baseline.sh <label> [timeout_s]
#
# Label dipakai sebagai nama direktori hasil di /tmp/lane-a-lab/<label>/:
#   gateway.log   — stderr lengkap (berisi baris "startup trace/phase")
#   timings.tsv   — spawn → /health 200 pertama (definisi A), /ready 200,
#                   dan / (Control UI shell) 200 pertama
#   phases.tsv    — tabel fase dari baris trace (nama, durasi ms, total ms)
#   config.json   — config minimal yang dipakai boot ini
#
# Semua angka [LAB] (VM ini, x86_64, Node 24.22.1) — BUKAN angka perangkat.
# State dir + HOME segar tiap run; tidak ada jaringan/model yang dipakai
# (chat pertama TIDAK bisa diukur di lab tanpa API key — dicatat di
# MEASUREMENT.md sebagai keterbatasan).
set -u
# Temp root OpenClaw menolak ancestor yang group/world-writable tanpa
# sticky bit — umask sesi ini 0007, jadi paksa 0077 agar semua dir lab 700.
umask 0077
LABEL="${1:-run1}"
TIMEOUT_S="${2:-900}"
# Cegah dua run berlabel sama jalan bersamaan (penulis timings.tsv ganda
# menkontaminasi hasil — pernah terjadi run1-off): kunci per label.
exec 9>"/tmp/lane-a-lab/.measure-$LABEL.lock"
if ! flock -n 9; then
  echo "FATAL: run berlabel $LABEL lain masih jalan (lock /tmp/lane-a-lab/.measure-$LABEL.lock)"
  exit 4
fi
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="/tmp/lane-a-lab/$LABEL"
HOME_DIR="$OUT/home"
STATE_DIR="$OUT/state"
mkdir -p /tmp/lane-a-lab
# Cek temp root menelusuri SEMUA ancestor sampai /tmp — induk lab harus
# 700 juga (bukan hanya dir yang dibuat skrip ini).
chmod 700 /tmp/lane-a-lab
mkdir -p "$OUT" "$HOME_DIR/.openclaw" "$STATE_DIR"

cat > "$STATE_DIR/openclaw.json" <<'EOF'
{
  "gateway": { "mode": "local", "port": 18789 },
  "agents": { "defaults": { "model": { "primary": "openai/gpt-4o" } } }
}
EOF
cp "$STATE_DIR/openclaw.json" "$OUT/config.json"
# Catatan: resolveConfigPath default = $OPENCLAW_STATE_DIR/openclaw.json,
# bukan ~/.openclaw/openclaw.json — jadi config ditulis ke STATE_DIR.

export HOME="$HOME_DIR"
export OPENCLAW_STATE_DIR="$STATE_DIR"
export OPENCLAW_GATEWAY_STARTUP_TRACE=1
# OPENCLAW_MOBILE_BOOT dibiarkan apa adanya dari lingkungan pemanggil
# (kosong = OFF / upstream; 1 = ON).

# Guard kontaminasi: port harus bebas sebelum spawn — bila ada gateway lain
# (run sebelumnya yang nyangkut), 200 yang terukur bukan milik run ini.
if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:18789/health" 2>/dev/null; then
  echo "FATAL: port 18789 sudah menjawab sebelum spawn (gateway lain masih hidup?)"
  exit 3
fi

SPAWN_EPOCH="$(date +%s.%N)"
node "$ROOT/openclaw.mjs" gateway run --port 18789 > "$OUT/gateway.log" 2>&1 < /dev/null &
GATEWAY_PID=$!
echo "spawn pid=$GATEWAY_PID label=$LABEL mobile_boot=${OPENCLAW_MOBILE_BOOT:-<unset>}"

poll_first_200() {
  local url="$1" name="$2" deadline="$3"
  while :; do
    local now
    now="$(date +%s.%N)"
    # Bila gateway mati (mis. config invalid), jangan poll sampai timeout:
    # laporkan dan berhenti — 200 sesudah itu pasti milik proses lain.
    if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
      echo -e "$name\tGATEWAY-EXITED" >> "$OUT/timings.tsv"
      echo "$name: gateway exited before 200 (lihat gateway.log)"
      return 2
    fi
    if awk -v n="$now" -v d="$deadline" 'BEGIN { exit !(n > d) }'; then
      echo -e "$name\tTIMEOUT" >> "$OUT/timings.tsv"
      return 1
    fi
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$url" 2>/dev/null || echo 000)"
    if [ "$code" = "200" ]; then
      local dt
      dt="$(awk -v a="$now" -v b="$SPAWN_EPOCH" 'BEGIN { printf "%.3f", a - b }')"
      echo -e "$name\t$dt" >> "$OUT/timings.tsv"
      echo "$name 200 after ${dt}s"
      return 0
    fi
    sleep 0.25
  done
}

DEADLINE="$(awk -v s="$SPAWN_EPOCH" -v t="$TIMEOUT_S" 'BEGIN { printf "%.3f", s + t }')"
: > "$OUT/timings.tsv"
poll_first_200 "http://127.0.0.1:18789/health" "health" "$DEADLINE" || true
poll_first_200 "http://127.0.0.1:18789/ready" "ready" "$DEADLINE" || true
poll_first_200 "http://127.0.0.1:18789/" "control-ui-root" "$DEADLINE" || true

# Beri waktu post-attach/plugin selesai, lalu hentikan gateway.
sleep 45
if kill -0 "$GATEWAY_PID" 2>/dev/null; then
  kill "$GATEWAY_PID" 2>/dev/null || true
  sleep 5
  kill -9 "$GATEWAY_PID" 2>/dev/null || true
fi
wait "$GATEWAY_PID" 2>/dev/null || true
END_EPOCH="$(date +%s.%N)"
awk -v a="$END_EPOCH" -v b="$SPAWN_EPOCH" 'BEGIN { printf "total wall: %.1fs\n", a - b }'

# Ekstrak tabel fase dari baris trace.
grep -oE 'startup (trace|phase): [^ ]+ [0-9]+\.[0-9]+ms total=[0-9]+\.[0-9]+ms' "$OUT/gateway.log" \
  | sed -E 's/startup (trace|phase): ([^ ]+) ([0-9.]+)ms total=([0-9.]+)ms/\2\t\3\t\4/' \
  | awk '!seen[$1]++' > "$OUT/phases.tsv" || true
echo "--- timings ---"; cat "$OUT/timings.tsv"
echo "--- phases ($(wc -l < "$OUT/phases.tsv") unik) ---"; cat "$OUT/phases.tsv"
echo "log: $OUT/gateway.log"
