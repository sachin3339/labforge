#!/usr/bin/env bash
# labforge-watchdog.sh — minute-resolution host + service health probe.
#
# Run via cron (one line in /etc/cron.d/labforge-watchdog). Sends Telegram
# alerts for memory pressure, disk fill, OOM cascades, dead containers,
# unreachable public API. Per-key cooldown (default 30 min) prevents spam.
#
# Required env (set in /etc/cron.d/labforge-watchdog or sourced from
# /etc/labforge-watchdog.env):
#   TELEGRAM_BOT_TOKEN   — bot token from @BotFather
#   TELEGRAM_CHAT_ID     — chat/group/channel id (numeric, may be negative)
#   PUBLIC_HEALTH_URL    — optional; defaults to the prod control-plane URL
#
# Optional env:
#   ALERT_COOLDOWN_SEC   — seconds between identical alerts (default 1800)
#   MEM_WARN / MEM_CRIT  — % thresholds (default 85 / 92)
#   DISK_WARN            — % threshold (default 85)
#
# Idempotent. Designed to be safe to invoke every minute even on a
# half-dead host (no fork bombs, short curl timeouts, fail-open if state
# dir cannot be written).

set -u

# Allow an env file to override defaults without editing the script.
if [ -f /etc/labforge-watchdog.env ]; then
  # shellcheck disable=SC1091
  . /etc/labforge-watchdog.env
fi

: "${TELEGRAM_BOT_TOKEN:=}"
: "${TELEGRAM_CHAT_ID:=}"
: "${PUBLIC_HEALTH_URL:=https://api.environments.learnlytica.com/healthz}"
: "${ALERT_COOLDOWN_SEC:=1800}"
: "${MEM_WARN:=85}"
: "${MEM_CRIT:=92}"
: "${DISK_WARN:=85}"

HOSTNAME_SHORT=$(hostname -s 2>/dev/null || hostname)
STATE=/var/lib/labforge-watchdog
mkdir -p "$STATE" 2>/dev/null || true

# alert <key> <severity> <message>
#   key — short identifier; cooldown is per-key
#   severity — info|warn|crit (controls emoji)
#   message — single-line text
alert() {
  local key=$1 sev=$2 msg=$3
  local stamp="$STATE/$key"
  local now icon
  now=$(date +%s)
  if [ -f "$stamp" ]; then
    local last
    last=$(stat -c %Y "$stamp" 2>/dev/null || echo 0)
    if [ $((now - last)) -lt "$ALERT_COOLDOWN_SEC" ]; then
      return 0
    fi
  fi
  case "$sev" in
    crit) icon='🔴' ;;
    warn) icon='⚠️' ;;
    *)    icon='ℹ️' ;;
  esac
  if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID" ]; then
    curl -fsS --max-time 8 \
      -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
      --data-urlencode "text=${icon} [${HOSTNAME_SHORT}] ${msg}" \
      >/dev/null 2>&1 || true
  fi
  touch "$stamp" 2>/dev/null || true
}

# clear <key> — drop the cooldown stamp so the next breach re-alerts.
clear_alert() { rm -f "$STATE/$1" 2>/dev/null || true; }

# 1. Memory pressure
mem_used=$(free | awk '/^Mem:/ {if ($2>0) printf("%d", $3*100/$2); else print 0}')
if [ "$mem_used" -ge "$MEM_CRIT" ]; then
  alert "mem-crit" crit "RAM ${mem_used}% used — system OOM imminent"
elif [ "$mem_used" -ge "$MEM_WARN" ]; then
  alert "mem-warn" warn "RAM ${mem_used}% used"
elif [ "$mem_used" -lt 70 ]; then
  clear_alert "mem-warn"
  clear_alert "mem-crit"
fi

# 2. Disk usage on /
disk_used=$(df -P / | awk 'NR==2 {gsub("%",""); print $5}')
if [ -n "$disk_used" ] && [ "$disk_used" -ge "$DISK_WARN" ]; then
  alert "disk-warn" warn "Disk / ${disk_used}% used"
elif [ -n "$disk_used" ] && [ "$disk_used" -lt 75 ]; then
  clear_alert "disk-warn"
fi

# 3. Load average sustained > 2× cores
cores=$(nproc 2>/dev/null || echo 1)
la=$(awk '{print $1}' /proc/loadavg)
la_int=$(printf '%.0f' "$la" 2>/dev/null || echo 0)
cap=$((cores * 2))
if [ "$la_int" -gt "$cap" ]; then
  alert "load-high" warn "Load ${la} on ${cores} cores"
fi

# 4. Kernel OOM activity in last 5 min
if command -v journalctl >/dev/null 2>&1; then
  oom=$(journalctl -k --since "5 minutes ago" --no-pager 2>/dev/null \
        | grep -c -iE "out of memory|killed process" || true)
  if [ -n "$oom" ] && [ "$oom" -gt 5 ]; then
    alert "oom-spam" warn "${oom} OOM kills in last 5 min"
  fi
fi

# 5. Docker daemon
if ! docker info >/dev/null 2>&1; then
  alert "docker-down" crit "docker daemon unresponsive"
else
  clear_alert "docker-down"
fi

# 6. Critical platform containers
for svc in deploy-control-plane-1 deploy-postgres-1 deploy-caddy-1 deploy-redis-1; do
  state=$(docker inspect --format '{{.State.Status}}' "$svc" 2>/dev/null || echo missing)
  case "$state" in
    running) clear_alert "svc-$svc" ;;
    missing) ;;  # might run on a different host; ignore
    *)       alert "svc-$svc" crit "${svc} is ${state}" ;;
  esac
done

# 7. Student containers exited unexpectedly
exited=$(docker ps -a --filter status=exited \
         --filter ancestor=labforge/ubuntu-trainer:1.2 --format '{{.ID}}' 2>/dev/null \
         | wc -l | tr -d ' ')
if [ -n "$exited" ] && [ "$exited" -gt 3 ]; then
  alert "labs-exited" warn "${exited} student containers in exited state"
elif [ -n "$exited" ] && [ "$exited" -lt 1 ]; then
  clear_alert "labs-exited"
fi

# 8. Public health endpoint (only fires from the host that owns the URL —
#    reachable means the API + ingress + DNS path is healthy end-to-end).
#    Use -s (silent) + -o /dev/null and only print %{http_code}. We do NOT
#    use -f here, because -f makes curl exit non-zero on 4xx/5xx which
#    would cause the `|| echo 000` fallback to concatenate with the real
#    code (e.g. "404000"). Curl exit code 0 + non-200 body is fine.
code=$(curl -sk -o /dev/null -w '%{http_code}' \
       --max-time 8 "$PUBLIC_HEALTH_URL" 2>/dev/null)
[ -z "$code" ] && code=000
if [ "$code" != "200" ]; then
  alert "api-down" crit "control-plane API ${PUBLIC_HEALTH_URL} HTTP ${code}"
else
  clear_alert "api-down"
fi

exit 0
