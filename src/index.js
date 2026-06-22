import { initDB } from './db/index.js';
import { startBot, registerCommands, client } from './bot/index.js';
import app from './web/app.js';
import axios from 'axios';

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// 프로세스 크래시 방지
process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught exception (continuing):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled rejection (continuing):', reason);
});

async function selfPing() {
  try {
    await axios.get(`${BASE_URL}/health`, { timeout: 8000 });
    console.log('[Ping] OK -', new Date().toISOString());
  } catch (e) {
    console.warn('[Ping] Failed:', e.message);
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

  // 봇 연결 끊김 감지
  client.on('shardDisconnect', (event, id) => {
    console.warn(`[Bot] Shard ${id} disconnected. Code: ${event.code}`);
  });
  client.on('shardReconnecting', (id) => {
    console.log(`[Bot] Shard ${id} reconnecting...`);
  });
  client.on('shardResume', (id, replayed) => {
    console.log(`[Bot] Shard ${id} resumed. Replayed: ${replayed}`);
  });
  client.on('error', (err) => {
    console.error('[Bot] Error:', err.message);
  });

  // 1분마다 자체 핑 (Render 슬립 방지)
  setInterval(selfPing, 60 * 1000);
  setTimeout(selfPing, 5000); // 시작 후 5초 뒤 첫 핑
  console.log(`[Ping] Self-ping started every 1 min → ${BASE_URL}/health`);
}

main().catch(err => {
  console.error('[Main] Fatal error:', err);
  process.exit(1);
});
