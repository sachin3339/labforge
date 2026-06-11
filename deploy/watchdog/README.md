# Labforge watchdog — Tier 0 monitoring

Minute-resolution shell script that pages a Telegram chat when the host
or platform misbehaves. Stops the "found out from students" pattern.

## What it watches

| Signal | Threshold | Severity |
|---|---|---|
| RAM used | > 85% / > 92% | warn / crit |
| Disk `/` used | > 85% | warn |
| Load avg | > 2× cores | warn |
| Kernel OOM events / 5 min | > 5 | warn |
| `docker info` | unresponsive | crit |
| Critical containers (control-plane, postgres, caddy, redis) | not `running` | crit |
| Exited student containers | > 3 | warn |
| Public API health endpoint | non-200 | crit |

Per-key 30-min cooldown prevents floods. Self-clears when the signal
returns to safe.

## One-time Telegram setup

1. Open Telegram → search `@BotFather` → `/newbot` → name it (e.g. `LabforgeAlerts`).
2. Copy the **bot token** (looks like `1234567:AABBCC...`).
3. Create a group / channel for alerts, **add the bot** to it. Make the bot an admin if it's a channel.
4. Send any message in the group, then visit
   `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser. Find
   the `chat.id` (negative number for groups, e.g. `-1001234567890`).
5. Test from a shell:
   ```bash
   TOKEN=...; CHAT=...
   curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
     --data-urlencode "chat_id=${CHAT}" --data-urlencode "text=hello"
   ```

## Install on a host (run as root)

```bash
HOST=primary   # or secondary
sudo install -m 0755 /opt/labforge/deploy/watchdog/labforge-watchdog.sh \
  /opt/labforge-watchdog.sh

sudo tee /etc/labforge-watchdog.env >/dev/null <<EOF
TELEGRAM_BOT_TOKEN=<paste-token>
TELEGRAM_CHAT_ID=<paste-chat-id>
PUBLIC_HEALTH_URL=https://api.environments.learnlytica.com/healthz
EOF
sudo chmod 600 /etc/labforge-watchdog.env

sudo tee /etc/cron.d/labforge-watchdog >/dev/null <<'EOF'
* * * * * root /opt/labforge-watchdog.sh >>/var/log/labforge-watchdog.log 2>&1
EOF
sudo chmod 644 /etc/cron.d/labforge-watchdog

# Smoke-test
sudo /opt/labforge-watchdog.sh
ls -la /var/lib/labforge-watchdog
sudo tail /var/log/labforge-watchdog.log
```

A startup ping is useful so you know each host is alive:
```bash
sudo bash -c 'source /etc/labforge-watchdog.env && \
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=✅ watchdog installed on $(hostname -s)"'
```

## Tuning

Override defaults in `/etc/labforge-watchdog.env`:

```env
ALERT_COOLDOWN_SEC=900   # 15-min reminders instead of 30
MEM_WARN=80
MEM_CRIT=90
DISK_WARN=80
```

## Trigger a test alert

```bash
# Force the memory check to fail by lying via env
sudo MEM_WARN=0 MEM_CRIT=0 /opt/labforge-watchdog.sh
```
You should get two Telegram messages within seconds. Reset by removing
`/var/lib/labforge-watchdog/mem-warn` etc. so the next real breach re-alerts.

## Uninstall

```bash
sudo rm -f /opt/labforge-watchdog.sh \
  /etc/cron.d/labforge-watchdog \
  /etc/labforge-watchdog.env
sudo rm -rf /var/lib/labforge-watchdog
```
