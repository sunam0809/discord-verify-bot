import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

export async function initDB() {
  await query(`
    CREATE TABLE IF NOT EXISTS server_configs (
      guild_id TEXT PRIMARY KEY,
      role_id TEXT NOT NULL,
      webhook_url TEXT,
      panel_title TEXT NOT NULL DEFAULT '인증',
      panel_description TEXT NOT NULL DEFAULT '아래 버튼을 눌러 인증을 완료하세요.',
      channel_id TEXT
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS verified_users (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      username TEXT,
      email TEXT,
      ip TEXT,
      isp TEXT,
      carrier TEXT,
      country TEXT,
      region TEXT,
      city TEXT,
      access_token TEXT,
      refresh_token TEXT,
      token_expires_at TIMESTAMPTZ,
      verified_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, guild_id)
    )
  `);

  await query(`ALTER TABLE server_configs ALTER COLUMN webhook_url DROP NOT NULL`).catch(() => {});

  await query(`
    ALTER TABLE verified_users
      ADD COLUMN IF NOT EXISTS access_token TEXT,
      ADD COLUMN IF NOT EXISTS refresh_token TEXT,
      ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ
  `).catch(() => {});

  await query(`
    CREATE TABLE IF NOT EXISTS recovery_keys (
      id SERIAL PRIMARY KEY,
      recovery_key TEXT NOT NULL UNIQUE,
      source_guild_id TEXT NOT NULL,
      used BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  console.log('[DB] Tables initialized');
}

export default pool;
