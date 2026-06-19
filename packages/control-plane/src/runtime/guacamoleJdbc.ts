/**
 * Apache Guacamole JDBC (PostgreSQL) auth provisioner.
 *
 * This is the durable replacement for file-based user-mapping.xml. The
 * killer feature the XML backend CANNOT provide is per-connection
 * concurrency limits: every connection we create here is hard-capped at
 *   max_connections          = 1
 *   max_connections_per_user = 1
 * so a second concurrent open of the same lab (duplicate browser tab,
 * page refresh, or an aggressive client reconnect) is REJECTED by
 * Guacamole instead of being allowed to start a competing RDP session.
 *
 * Why that matters: dockur runs Windows 11 *client* SKU, which permits
 * exactly ONE inbound RDP session. With the old XML backend (no limits)
 * a second Guacamole client would connect, Windows would evict the first
 * ("Disconnected by other connection"), the kicked client would
 * auto-reconnect, and the two would fight forever — surfaced to students
 * as "The remote desktop server has closed the connection because it
 * conflicts with another connection." The concurrency limit breaks that
 * loop by protecting the incumbent session.
 *
 * The control-plane is the single writer of the guacamole_db schema. We
 * talk to it over a dedicated `pg` pool (NOT Prisma — it's a separate,
 * isolated database the Guacamole role owns and the control-plane has no
 * Prisma models for). All writes are idempotent upserts keyed on the
 * stable per-instance names:
 *   - connection_name = LabInstance.id
 *   - user/entity name = LabInstance.guacamoleUser ("lab-<token>")
 *
 * No-op (returns nulls / zero) when GUACAMOLE_DB_URL is unset, so the
 * legacy XML path keeps working on deploys that haven't been migrated.
 */
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;
let poolInitialised = false;

/** Lazily build the shared pool. Returns null when JDBC auth is disabled. */
export function getGuacPool(): pg.Pool | null {
  if (poolInitialised) return pool;
  poolInitialised = true;
  const url = config.GUACAMOLE_DB_URL;
  if (!url || url.length === 0) {
    pool = null;
    return null;
  }
  pool = new Pool({ connectionString: url, max: 4, idleTimeoutMillis: 30_000 });
  return pool;
}

/** True when JDBC provisioning is configured. */
export function guacJdbcEnabled(): boolean {
  return getGuacPool() !== null;
}

/**
 * Compute the Guacamole SHA-256 password fields. Guacamole's
 * SHA256PasswordEncryptionService hashes
 *   SHA-256( UTF8( password + UPPERCASE_HEX(salt) ) )
 * and stores the raw 32-byte digest + 32-byte salt as bytea. Replicated
 * exactly here so the `?username=&password=` auto-login validates.
 */
function guacPasswordFields(password: string): { hash: Buffer; salt: Buffer } {
  const salt = randomBytes(32);
  const saltHex = salt.toString('hex').toUpperCase();
  const hash = createHash('sha256')
    .update(Buffer.from(password + saltHex, 'utf8'))
    .digest();
  return { hash, salt };
}

/** One live Guacamole-enabled lab instance, flattened for provisioning. */
export interface GuacJdbcRow {
  instanceId: string;
  guacUser: string;
  guacPassword: string;
  hostname: string;
  port: number;
  rdpUsername: string;
  rdpPassword?: string | null;
}

/**
 * Static RDP connection params. Mirrors the legacy user-mapping.xml set:
 * NLA only (dockur Win11 rejects guacd's HYBRID_EX negotiation under
 * `any`), ignore self-signed cert, dynamic resize, chrome off for speed.
 */
const RDP_STATIC_PARAMS: Record<string, string> = {
  security: 'nla',
  'ignore-cert': 'true',
  'resize-method': 'display-update',
  'enable-wallpaper': 'false',
  'enable-theming': 'false',
  'enable-font-smoothing': 'true',
  'color-depth': '24',
};

/**
 * Idempotently upsert the entity + user + connection (+ params +
 * READ permission) for one instance inside an open transaction.
 * Returns the numeric guacamole_connection.connection_id.
 */
async function upsertConnection(
  client: pg.PoolClient,
  row: GuacJdbcRow,
): Promise<number> {
  // 1. entity (USER). ON CONFLICT DO UPDATE so we get the id back.
  const ent = await client.query(
    `INSERT INTO guacamole_entity (name, type) VALUES ($1, 'USER')
       ON CONFLICT (name, type) DO UPDATE SET name = EXCLUDED.name
       RETURNING entity_id`,
    [row.guacUser],
  );
  const entityId: number = ent.rows[0].entity_id;

  // 2. user creds (upsert by entity_id) — rotate hash/salt each time so a
  //    rotated guacamolePassword takes effect.
  const { hash, salt } = guacPasswordFields(row.guacPassword);
  await client.query(
    `INSERT INTO guacamole_user (entity_id, password_hash, password_salt, password_date, disabled, expired)
       VALUES ($1, $2, $3, now(), false, false)
       ON CONFLICT (entity_id) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             password_salt = EXCLUDED.password_salt,
             password_date = EXCLUDED.password_date`,
    [entityId, hash, salt],
  );

  // 3. connection (top-level, parent_id NULL). Unique constraint includes
  //    parent_id which is NULL here, so NULLs don't dedupe — look up by
  //    name manually, then update-or-insert.
  const existing = await client.query(
    `SELECT connection_id FROM guacamole_connection
       WHERE connection_name = $1 AND parent_id IS NULL`,
    [row.instanceId],
  );
  let connectionId: number;
  if (existing.rows.length > 0) {
    connectionId = existing.rows[0].connection_id;
    await client.query(
      `UPDATE guacamole_connection
         SET protocol = 'rdp', max_connections = 1, max_connections_per_user = 1
         WHERE connection_id = $1`,
      [connectionId],
    );
  } else {
    const ins = await client.query(
      `INSERT INTO guacamole_connection
         (connection_name, protocol, max_connections, max_connections_per_user)
         VALUES ($1, 'rdp', 1, 1)
         RETURNING connection_id`,
      [row.instanceId],
    );
    connectionId = ins.rows[0].connection_id;
  }

  // 4. params — rebuild the full set (cheap; cascades on connection delete).
  await client.query(
    `DELETE FROM guacamole_connection_parameter WHERE connection_id = $1`,
    [connectionId],
  );
  const params: [string, string][] = [
    ['hostname', row.hostname],
    ['port', String(row.port)],
    ['username', row.rdpUsername],
  ];
  if (row.rdpPassword) params.push(['password', row.rdpPassword]);
  for (const [name, value] of Object.entries(RDP_STATIC_PARAMS)) {
    params.push([name, value]);
  }
  for (const [name, value] of params) {
    await client.query(
      `INSERT INTO guacamole_connection_parameter (connection_id, parameter_name, parameter_value)
         VALUES ($1, $2, $3)`,
      [connectionId, name, value],
    );
  }

  // 5. grant the user READ on its single connection.
  await client.query(
    `INSERT INTO guacamole_connection_permission (entity_id, connection_id, permission)
       VALUES ($1, $2, 'READ')
       ON CONFLICT DO NOTHING`,
    [entityId, connectionId],
  );

  return connectionId;
}

/**
 * Full reconcile: upsert every renderable row and prune connections/users
 * that are no longer present. Mirrors regenerateUserMapping's whole-file
 * rebuild semantics so the two backends stay in lock-step during the
 * migration window. No-op when JDBC is disabled.
 *
 * CRITICAL: pruning must NOT delete a connection that belongs to a still
 * live instance just because that instance was momentarily un-renderable
 * (e.g. its RDP host:port hadn't been reconciled yet this tick, so it was
 * dropped by the caller's skip guards and is absent from `rows`). Deleting
 * + later recreating a connection reassigns its serial connection_id, which
 * silently invalidates every auto-login URL already handed to that student
 * — their open Guacamole tab keeps requesting the old id and guacd answers
 * "Requested tunnel destination does not exist" on every (re)connect. To
 * keep ids stable, callers pass `keep` = the FULL set of live instances /
 * users; prune only removes entries outside that superset. When `keep` is
 * omitted we fall back to the upserted rows (legacy behaviour).
 */
export async function syncGuacConnections(
  rows: GuacJdbcRow[],
  keep?: { connNames: string[]; userNames: string[] },
): Promise<{ synced: number }> {
  const p = getGuacPool();
  if (!p) return { synced: 0 };

  const client = await p.connect();
  try {
    await client.query('BEGIN');
    // Upsert every renderable row (stable id: existing connections are
    // UPDATEd in place, never delete+recreated).
    for (const row of rows) {
      await upsertConnection(client, row);
    }
    // Build the prune keep-set as a superset of what we just upserted plus
    // any additional live names the caller declared. An instance that is
    // live but un-renderable this tick stays in `keep` and is preserved.
    const keepConn = new Set<string>(keep?.connNames ?? []);
    const keepUser = new Set<string>(keep?.userNames ?? []);
    for (const row of rows) {
      keepConn.add(row.instanceId);
      keepUser.add(row.guacUser);
    }
    const liveConnNames = [...keepConn];
    const liveUserNames = [...keepUser];

    // Prune stale top-level connections.
    if (liveConnNames.length > 0) {
      await client.query(
        `DELETE FROM guacamole_connection
           WHERE parent_id IS NULL AND connection_name <> ALL($1::text[])`,
        [liveConnNames],
      );
    } else {
      await client.query(
        `DELETE FROM guacamole_connection WHERE parent_id IS NULL`,
      );
    }

    // Prune stale control-plane-managed users (deleting the entity cascades
    // to guacamole_user + permissions). Only touches `lab-%` names so any
    // operator account is left alone.
    if (liveUserNames.length > 0) {
      await client.query(
        `DELETE FROM guacamole_entity
           WHERE type = 'USER' AND name LIKE 'lab-%' AND name <> ALL($1::text[])`,
        [liveUserNames],
      );
    } else {
      await client.query(
        `DELETE FROM guacamole_entity WHERE type = 'USER' AND name LIKE 'lab-%'`,
      );
    }

    await client.query('COMMIT');
    return { synced: rows.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Resolve the numeric connection_id for an instance, or null if absent. */
export async function getGuacConnectionId(
  instanceId: string,
): Promise<number | null> {
  const p = getGuacPool();
  if (!p) return null;
  const r = await p.query(
    `SELECT connection_id FROM guacamole_connection
       WHERE connection_name = $1 AND parent_id IS NULL`,
    [instanceId],
  );
  return r.rows.length > 0 ? Number(r.rows[0].connection_id) : null;
}

/**
 * Build the auto-login client URL for the JDBC backend. Lands the student
 * straight on their desktop by encoding the connection identifier in the
 * SPA fragment: `#/client/<base64("<id>\0c\0postgresql")>`. Query-string
 * `username`/`password` drive Guacamole's auto-login; `logout=true` drops
 * any prior browser session so opening a *different* seat in the same
 * browser switches users cleanly; `_ts` busts intermediary caches.
 *
 * `baseUrl` is the per-VM origin (e.g. `https://<sub>.lab.<root>`), NOT the
 * shared gateway host. Serving each VM's client from its own subdomain
 * origin gives the browser a separate localStorage partition, so the
 * GUAC_AUTH / GUAC_HISTORY / GUAC_PREFERENCES keys no longer collide across
 * tabs when a student opens several VMs at once.
 */
export function guacamoleClientUrlJdbc(
  baseUrl: string,
  user: string,
  password: string,
  connectionId: number,
): string {
  const base = baseUrl.replace(/\/+$/, '');
  const qs = new URLSearchParams({
    logout: 'true',
    username: user,
    password,
    _ts: String(Date.now()),
  });
  const idToken = Buffer.from(
    `${connectionId}\u0000c\u0000postgresql`,
    'utf8',
  ).toString('base64');
  return `${base}/guacamole/?${qs.toString()}#/client/${idToken}`;
}
