import { initDB } from './db/index.js';
import { startBot, registerCommands } from './bot/index.js';
import app from './web/app.js';
import axios from 'axios';

const PORT = process.env.PORT || 3000;

async function main() {
  console.log('[Main] Starting...');

  await initDB();

  app.listen(PORT, () => {
    console.log(`[Web] Server running on port ${PORT}`);
  });

  await registerCommands();
  await startBot();

  // Render 무료 플랜 슬립 방지 - 10분마다 자체 핑
  if (process.env.BASE_URL) {
    setInterval(async () => {
      try {
        await axios.get(`${process.env.BASE_URL}/health`, { timeout: 5000 });
        console.log('[Ping] Self-ping OK');
      } catch(e) {
        console.log('[Ping] Self-ping failed:', e.message);
      }
    }, 10 * 60 * 1000);
    console.log('[Ping] Self-ping started (every 10 min)');
  }
}

main().catch(err => {
  console.error('[Main] Fatal error:', err);
  process.exit(1);
});
