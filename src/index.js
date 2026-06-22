import { initDB } from './db/index.js';
import { startBot, registerCommands, client } from './bot/index.js';
import app from './web/app.js';
import axios from 'axios';

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

let lastBotError = null;
let loginAttempts = 0;
let retryDelay = 20000;
let connecting = false;

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
    uptime: client.uptime ? Math.floor(client.uptime / 1000) + 's' : null,
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

  try {
    // login() + READY 이벤트 둘 다 90초 내에 완료돼야 함
    await Promise.race([
      new Promise(async (resolve, reject) => {
        try {
          await startBot();
          // login()이 resolve된 후 READY 기다리기
          if (client.isReady()) {
            resolve();
          } else {
            client.once('ready', resolve);
          }
        } catch (e) {
          reject(e);
        }
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Connection timeout (90s)')), 90000)
      )
    ]);

    lastBotError = null;
    retryDelay = 20000;
    connecting = false;
    console.log('[Bot] ✓ Ready as', client.user?.tag);

  } catch (err) {
    lastBotError = err.message;
    console.error(`[Bot] Connect failed (attempt ${loginAttempts}): ${err.message}`);
    // 클라이언트 리셋
    try { client.destroy(); } catch (_) {}
    retryDelay = Math.min(retryDelay * 2, 300000);
    connecting = false;
    console.log(`[Bot] Retry in ${retryDelay / 1000}s...`);
    setTimeout(connectBot, retryDelay);
  }
}

// 봇이 끊기면 자동 재연결
client.on('shardDisconnect', async (event) => {
  console.warn(`[Bot] Disconnected (code ${event.code})`);
  if (!connecting) {
    console.log('[Bot] Scheduling reconnect in 15s...');
    setTimeout(connectBot, 15000);
  }
});

client.on('error', (err) => {
  console.error('[Bot] Client error:', err.message);
});

async function main() {
  console.log('[Main] Starting...');
  await initDB();
  console.log('[DB] OK');

  app.listen(PORT, () => {
    console.log(`[Web] Port ${PORT}`);
  });

  // registerCommands는 최초 1회만 (env var로 제어)
  if (process.env.REGISTER_COMMANDS === 'true') {
    registerCommands()
      .then(() => console.log('[Bot] Commands registered'))
      .catch(err => console.error('[Bot] Commands error:', err.message));
  }

  // 30초 후 첫 연결 시도 (Rate Limit 회복 여유 시간)
  console.log('[Bot] First connect in 30s...');
  setTimeout(connectBot, 30000);

  // 1분마다 self-ping (Render 슬립 방지)
  setInterval(selfPing, 60 * 1000);
  setTimeout(selfPing, 5000);
  console.log(`[Ping] → ${BASE_URL}/health every 60s`);
}

main().catch(err => {
  console.error('[Main] Fatal:', err);
  process.exit(1);
});
