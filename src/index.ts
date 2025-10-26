import { VerificationBot } from './bot';
import { WebServer } from './web/server';
import { CONFIG } from './config';

async function main() {
  console.log('Starting VeeriBot...');
  console.log(`Environment: ${CONFIG.nodeEnv}`);
  
  try {
    const bot = new VerificationBot();
    const webServer = new WebServer(bot);
    
    await bot.start();
    webServer.start();
    
    console.log('All services started');
    console.log(`Bot is READY!`);
    console.log(`Frontend: ${CONFIG.server.baseUrl}`);
    
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down gracefully...');
  process.exit(0);
});

main().catch((error) => {
  console.error('unhandled error:', error);
  process.exit(1);
});