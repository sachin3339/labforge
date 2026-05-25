#!/bin/bash
# Kasm runs this as ROOT after container startup (kasm_post_run_root.sh).
# Boots a local MySQL server so Workbench has a DB to point at.
# Idempotent — safe to re-run on container restart.
set +e

DATADIR=/var/lib/mysql
LOGFILE=/var/log/mysql/error.log

mkdir -p "$(dirname "$LOGFILE")" /var/run/mysqld
chown -R mysql:mysql /var/run/mysqld "$(dirname "$LOGFILE")" "$DATADIR"

# Initialise the data dir if it's empty (fresh per-instance volume).
if [ ! -d "$DATADIR/mysql" ]; then
  echo "[mysql] data dir empty, initialising..." >> "$LOGFILE"
  mysqld --initialize-insecure --user=mysql --datadir="$DATADIR" >> "$LOGFILE" 2>&1
  chown -R mysql:mysql "$DATADIR"
fi

# Background mysqld. nohup so the desktop session start doesn't kill it.
nohup mysqld --user=mysql --datadir="$DATADIR" \
  --bind-address=127.0.0.1 --port=3306 \
  >> "$LOGFILE" 2>&1 &

# Wait for the socket, then provision the trainer accounts on first run.
for i in $(seq 1 20); do
  if mysqladmin --protocol=socket -uroot ping >/dev/null 2>&1; then break; fi
  sleep 0.5
done

mysql --protocol=socket -uroot <<'SQL' 2>/dev/null || true
ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY 'trainer';
CREATE USER IF NOT EXISTS 'trainer'@'localhost' IDENTIFIED BY 'trainer';
GRANT ALL PRIVILEGES ON *.* TO 'trainer'@'localhost' WITH GRANT OPTION;
CREATE DATABASE IF NOT EXISTS lab;
FLUSH PRIVILEGES;
SQL

echo "[mysql] ready — root/trainer, trainer/trainer, db=lab"
