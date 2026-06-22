import { initDB } from './db/index.js';
import { startBot, registerCommands, client } from './bot/index.js';
import app from './web/app.js';
import axios from 'axios';

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

let lastBotError = null;
let loginAttempts = 0;
let cmdRegStatus = 'pending';

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled rejection:', reason);
});

app.get('/bot-status', (req, res) => {
  res.json({
    botReady: client.isReady(),
    tag: client.user?.tag || null,
    uptime: client.uptime,
    loginAttempts,
    lastError: lastBotError,
    commandsStatus: cmdRegStatus
  });
});

// Discord API 연결 테스트 (토큰 유효성 + 네트워크 체크)
app.get('/discord-test', async (req, res) => {
  const results = {};
  try {
    const gw = await axios.get('https://discord.com/api/v10/gateway', { timeout: 10000 });
    results.gateway = { ok: true, url: gw.data.url };
  } catch (e) {
    results.gateway = { ok: false, error: e.message };
  }
  try {
    const me = await axios.get('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` },
      timeout: 10000
    });
    results.botToken = { ok: true, id: me.data.id, username: me.data.username };
  } catch (e) {
    results.botToken = { ok: false, status: e.response?.status, error: e.message };
  }
  res.json(results);
});

async function selfPing() {
  try {
    await axios.get(`${BASE_URL}/health`, { timeout: 8000 });
  } catch (e) {
    console.warn('[Ping] Failed:', e.message);
  }
}

async function startBotSafe() {
  loginAttempts++;
  console.log(`[Bot] Login attempt #${loginAttempts}...`);
  try {
    await startBot();
    lastBotError = null;
    console.log('[Bot] ✓ Connected as', client.user?.tag);
  } catch (err) {
    lastBotError = err.message;
    console.error(`[Bot] Login failed (attempt ${loginAttempts}): ${err.message}`);
    setTimeout(startBotSafe, 30000);
  }
}

async function main() {
  console.log('[Main] Starting...');
  await initDB();
  console.log('[DB] Connected ✓');

  app.listen(PORT, () => {
    console.log(`[Web] Running on port ${PORT}`);
  });

  startBotSafe();

  registerCommands()
    .then(() => { cmdRegStatus = 'ok'; console.log('[Bot] Commands registered ✓'); })
    .catch(err => { cmdRegStatus = `error: ${err.message}`; console.error('[Bot] registerCommands failed:', err.message); });

  client.on('shardDisconnect', (event) => {
    console.warn(`[Bot] Disconnected (code ${event.code})`);
  });
  client.on('error', (err) => {
    console.error('[Bot] Error:', err.message);
  });

  setInterval(selfPing, 60 * 1000);
  setTimeout(selfPing, 5000);
}

main().catch(err => {
  console.error('[Main] Fatal:', err);
  process.exit(1);
});
