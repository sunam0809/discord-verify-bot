import { initDB } from './db/index.js';
import { startBot, registerCommands, client } from './bot/index.js';
import app from './web/app.js';
import axios from 'axios';

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

let lastBotError = null;
let loginAttempts = 0;
let retryDelay = 15000; // 지수 백오프 시작값

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
    nextRetryDelay: retryDelay
  });
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
  console.log(`[Bot] Login attempt #${loginAttempts} (delay was ${retryDelay}ms)...`);
  try {
    await startBot();
    lastBotError = null;
    retryDelay = 15000; // 성공 시 리셋
    console.log('[Bot] ✓ Connected as', client.user?.tag);
  } catch (err) {
    lastBotError = err.message;
    console.error(`[Bot] Login failed: ${err.message}`);
    // 지수 백오프: 15s → 30s → 60s → 120s → 최대 300s
    retryDelay = Math.min(retryDelay * 2, 300000);
    console.log(`[Bot] Retrying in ${retryDelay / 1000}s...`);
    setTimeout(startBotSafe, retryDelay);
  }
}

async function main() {
  console.log('[Main] Starting...');
  await initDB();
  console.log('[DB] Connected ✓');

  app.listen(PORT, () => {
    console.log(`[Web] Running on port ${PORT}`);
  });

  // registerCommands는 REGISTER_COMMANDS=true 일 때만 실행 (Rate Limit 방지)
  // 명령어는 한 번만 등록하면 Discord에 영구 저장됨
  if (process.env.REGISTER_COMMANDS === 'true') {
    registerCommands()
      .then(() => console.log('[Bot] Commands registered ✓'))
      .catch(err => console.error('[Bot] registerCommands failed:', err.message));
  } else {
    console.log('[Bot] Skipping registerCommands (already registered)');
  }

  // 봇 연결 (30초 후 시작 - Rate Limit 429 회복 대기)
  console.log('[Bot] Waiting 30s before connecting (Discord rate limit recovery)...');
  setTimeout(startBotSafe, 30000);

  client.on('shardDisconnect', (event) => {
    console.warn(`[Bot] Disconnected (code ${event.code}), will auto-reconnect...`);
  });
  client.on('error', (err) => {
    console.error('[Bot] Error:', err.message);
  });

  setInterval(selfPing, 60 * 1000);
  setTimeout(selfPing, 5000);
  console.log(`[Ping] Self-ping every 1min → ${BASE_URL}/health`);
}

main().catch(err => {
  console.error('[Main] Fatal:', err);
  process.exit(1);
});
