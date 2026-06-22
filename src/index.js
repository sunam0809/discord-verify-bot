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
let retryTimer = null;

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
    nextRetryMs: retryDelay,
    connecting
  });
});

async function selfPing() {
  try {
    await axios.get(`${BASE_URL}/health`, { timeout: 8000 });
    console.log('[Ping] OK');
  } catch (e) {
    console.warn('[Ping] Failed:', e.message);
  }
}

async function connectBot() {
  if (connecting) {
    console.log('[Bot] Already connecting, skip.');
    return;
  }
  connecting = true;
  loginAttempts++;
  console.log(`[Bot] Connecting attempt #${loginAttempts}...`);

  if (clientStore.current) {
    try { clientStore.current.destroy(); } catch (_) {}
    clientStore.current = null;
  }

  const client = createClient();
  clientStore.current = client;

  const timer = setTimeout(() => {
    console.error('[Bot] Timeout! No READY in 60s.');
    connecting = false;
    lastBotError = 'Connection timeout (60s)';
    try { client.destroy(); } catch(_) {}
    clientStore.current = null;
    retryDelay = Math.min(retryDelay * 2, 60000);
    console.log(`[Bot] Retry in ${retryDelay/1000}s...`);
    retryTimer = setTimeout(connectBot, retryDelay);
  }, 60000);

  client.once('ready', () => {
    clearTimeout(timer);
    lastBotError = null;
    retryDelay = 5000;
    connecting = false;
    console.log('[Bot] ✓ Ready as', client.user?.tag);

    client.on('shardDisconnect', (event) => {
      console.warn(`[Bot] Disconnected (code ${event.code})`);
      if (!connecting) {
        console.log('[Bot] Reconnecting in 10s...');
        retryTimer = setTimeout(connectBot, 10000);
      }
    });
    client.on('error', (err) => {
      console.error('[Bot] Client error:', err.message);
    });
  });

  client.on('debug', (msg) => {
    if (msg.includes('Heartbeat') || msg.includes('RESUME') || msg.includes('HELLO') || msg.includes('READY') || msg.includes('error') || msg.includes('Error')) {
      console.log('[WS Debug]', msg.slice(0, 200));
    }
  });

  try {
    console.log('[Bot] Calling client.login()...');
    await client.login(process.env.BOT_TOKEN);
    console.log('[Bot] login() resolved, waiting for READY...');
  } catch (err) {
    clearTimeout(timer);
    connecting = false;
    lastBotError = err.message;
    console.error(`[Bot] login() threw: ${err.message}`);
    try { client.destroy(); } catch(_) {}
    clientStore.current = null;
    retryDelay = Math.min(retryDelay * 2, 60000);
    console.log(`[Bot] Retry in ${retryDelay/1000}s...`);
    retryTimer = setTimeout(connectBot, retryDelay);
  }
}

async function main() {
  console.log('[Main] Starting...');
  await initDB();
  console.log('[DB] OK');

  app.listen(PORT, () => {
    console.log(`[Web] Listening on port ${PORT}`);
  });

  if (process.env.REGISTER_COMMANDS === 'true') {
    registerCommands()
      .then(() => console.log('[Bot] Commands registered'))
      .catch(err => console.error('[Bot] Commands error:', err.message));
  }

  console.log('[Bot] Starting connection...');
  connectBot();

  setInterval(selfPing, 60 * 1000);
  setTimeout(selfPing, 5000);
  console.log(`[Ping] Self-ping → ${BASE_URL}/health every 60s`);
}

main().catch(err => {
  console.error('[Main] Fatal:', err);
  process.exit(1);
});
