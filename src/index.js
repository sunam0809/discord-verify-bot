import { initDB } from './db/index.js';
  import { startBot, registerCommands } from './bot/index.js';
  import app from './web/app.js';

  const PORT = process.env.PORT || 3000;

  async function main() {
    console.log('[Main] Starting...');
    
    // Initialize database
    await initDB();

    // Start web server
    app.listen(PORT, () => {
      console.log(`[Web] Server running on port ${PORT}`);
    });

    // Register slash commands and start bot
    await registerCommands();
    await startBot();
  }

  main().catch(err => {
    console.error('[Main] Fatal error:', err);
    process.exit(1);
  });
  