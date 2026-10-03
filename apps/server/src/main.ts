import { loadConfig, StartupError } from './config.ts';
import { startServer } from './start.ts';

/** Point d'entrée : refuse de démarrer si les conditions de sécurité (section 4) ne sont pas remplies. */
async function main(): Promise<void> {
  let server;
  try {
    server = await startServer(loadConfig());
  } catch (err) {
    if (err instanceof StartupError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}

void main();
