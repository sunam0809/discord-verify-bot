import { initDB } from './db/index.js';
import { startBot, registerCommands, client } from './bot/index.js';
import app from './web/app.js';
import axios from 'axios';

const PORT = process.env.PORT || 3000;

async function selfPing() {
  const url = process.env.BASE_URL
    ? `${process.env.BASE_URL}/health`
    : `http://localhost:${PORT}/health`;
  try {
    await axios.get(url, { timeout: 8000 });
    console.log('[Ping] Self-ping OK');
  } catch (e) {
    console.log('[Ping] Self-ping failed:', e.message);
  }
}

async function main() {
  console.log('[Main] Starting...');

  await initDB();

  app.listen(PORT, () => {
    console.log(`[Web] Server running on port ${PORT}`);
  });

  await registerCommands();
  await startBot();

  // 5분마다 자체 핑 (Render 슬립 방지)
  setInterval(selfPing, 5 * 60 * 1000);
  console.log('[Ping] Self-ping started (every 5 min)');

  // 봇 연결 끊김 감지 및 재연결
  client.on('disconnect', () => {
    console.log('[Bot] Disconnected from Discord. Reconnecting...');
  });

  client.on('error', (err) => {
    console.error('[Bot] Client error:', err.message);
  });

  client.on('warn', (info) => {
    console.warn('[Bot] Warning:', info);
  });

  client.on('shardReconnecting', () => {
    console.log('[Bot] Shard reconnecting...');
  });

  client.on('shardResume', () => {
    console.log('[Bot] Shard resumed.');
  });
}

main().catch(err => {
  console.error('[Main] Fatal error:', err);
  process.exit(1);
});
