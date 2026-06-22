import { initDB } from './db/index.js';
import { startBot, registerCommands, client } from './bot/index.js';
import app from './web/app.js';
import axios from 'axios';

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled rejection:', reason);
});

// /bot-status 엔드포인트 - 봇 연결 상태 확인용
app.get('/bot-status', (req, res) => {
  res.json({
    botReady: client.isReady(),
    uptime: client.uptime,
    tag: client.user?.tag || null
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
  try {
    await startBot();
    console.log('[Bot] Connected to Discord ✓');
  } catch (err) {
    console.error('[Bot] Login failed:', err.message);
    console.log('[Bot] Retrying in 30s...');
    setTimeout(startBotSafe, 30000);
  }
}

async function main() {
  console.log('[Main] Starting...');

  await initDB();

  app.listen(PORT, () => {
    console.log(`[Web] Server running on port ${PORT}`);
  });

  await registerCommands();
  await startBotSafe();

  client.on('shardDisconnect', (event, id) => {
    console.warn(`[Bot] Disconnected (code ${event.code}). Auto-reconnecting...`);
  });
  client.on('error', (err) => {
    console.error('[Bot] Client error:', err.message);
  });

  // 1분마다 self-ping (Render 슬립 방지)
  setInterval(selfPing, 60 * 1000);
  setTimeout(selfPing, 5000);
  console.log(`[Ping] Self-ping every 1min → ${BASE_URL}/health`);
}

main().catch(err => {
  console.error('[Main] Fatal:', err);
  process.exit(1);
});
