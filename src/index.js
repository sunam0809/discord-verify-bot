import { initDB } from './db/index.js';
import { createClient, registerCommands } from './bot/index.js';
import { clientStore } from './bot/clientStore.js';
import app from './web/app.js';
import axios from 'axios';

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

let lastBotError = null;
let loginAttempts = 0;
let retryDelay = 5000;
let connecting = false;

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled rejection:', reason);
});

app.get('/bot-status', (req, res) => {
  const c = clientStore.current;
  res.json({
    botReady: c?.isReady() || false,
    tag: c?.user?.tag || null,
    uptime: c?.uptime ? Math.floor(c.uptime / 1000) + 's' : null,
    loginAttempts,
    lastError: lastBotError,
    nextRetryMs: retryDelay
  });
});

async function selfPing() {
  try {
    await axios.get(`${BASE_URL}/health`, { timeout: 8000 });
  } catch (e) {
    console.warn('[Ping] Failed:', e.message);
  }
}

async function connectBot() {
  if (connecting) return;
  connecting = true;
  loginAttempts++;
  console.log(`[Bot] Connecting... attempt #${loginAttempts}`);

  // 이전 클라이언트 정리
  if (clientStore.current) {
    try { clientStore.current.destroy(); } catch (_) {}
    clientStore.current = null;
  }

  try {
    const client = createClient();
    clientStore.current = client;

    await Promise.race([
      new Promise((resolve, reject) => {
        client.once('ready', resolve);
        client.once('error', reject);
        client.login(process.env.BOT_TOKEN).catch(reject);
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Connection timeout (120s)')), 120000)
      )
    ]);

    client.on('shardDisconnect', (event) => {
      console.warn(`[Bot] Disconnected (code ${event.code})`);
      if (!connecting) {
        console.log('[Bot] Reconnecting in 10s...');
        setTimeout(connectBot, 10000);
      }
    });

    client.on('error', (err) => {
      console.error('[Bot] Client error:', err.message);
    });

    lastBotError = null;
    retryDelay = 5000;
    connecting = false;
    console.log('[Bot] ✓ Ready as', client.user?.tag);

  } catch (err) {
    lastBotError = err.message;
    console.error(`[Bot] Connect failed (attempt ${loginAttempts}): ${err.message}`);
    if (clientStore.current) {
      try { clientStore.current.destroy(); } catch (_) {}
      clientStore.current = null;
    }
    retryDelay = Math.min(retryDelay * 2, 60000);
    connecting = false;
    console.log(`[Bot] Retry in ${retryDelay / 1000}s...`);
    setTimeout(connectBot, retryDelay);
  }
}

async function main() {
  console.log('[Main] Starting...');
  await initDB();
  console.log('[DB] OK');

  app.listen(PORT, () => {
    console.log(`[Web] Port ${PORT}`);
  });

  if (process.env.REGISTER_COMMANDS === 'true') {
    registerCommands()
      .then(() => console.log('[Bot] Commands registered'))
      .catch(err => console.error('[Bot] Commands error:', err.message));
  }

  console.log('[Bot] Connecting now...');
  connectBot();

  setInterval(selfPing, 60 * 1000);
  setTimeout(selfPing, 5000);
  console.log(`[Ping] → ${BASE_URL}/health every 60s`);
}

main().catch(err => {
  console.error('[Main] Fatal:', err);
  process.exit(1);
});
