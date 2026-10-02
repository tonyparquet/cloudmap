import type { Server } from 'node:https';
import { buildApp } from './app.ts';
import { loadConfig, StartupError } from './config.ts';
import { watchCertificate } from './tls.ts';

/** Point d'entrée : refuse de démarrer si les conditions de sécurité (section 4) ne sont pas remplies. */
async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof StartupError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  let built;
  try {
    built = await buildApp(config);
  } catch (err) {
    if (err instanceof StartupError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  const { app } = built;
  await app.listen({ port: config.port, host: config.host });
  const stopWatch = watchCertificate(app.server as unknown as Server, config.tlsFiles, {
    info: (m) => app.log.info(m),
    error: (m) => app.log.error(m),
  });
  app.log.info(`Cartographe AWS en écoute sur ${config.publicOrigin} (HTTPS TLS 1.3, port ${config.port})`);
  const stop = async () => {
    stopWatch();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}

void main();
