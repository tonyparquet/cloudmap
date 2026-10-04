import type { Server } from 'node:https';
import { buildApp } from './app.ts';
import type { ServerConfig } from './config.ts';
import { watchCertificate } from './tls.ts';

/** Démarre le serveur HTTPS (point d'entrée Docker et application de bureau). */
export async function startServer(config: ServerConfig): Promise<{ close: () => Promise<void> }> {
  const { app } = await buildApp(config);
  await app.listen({ port: config.port, host: config.host });
  const stopWatch = watchCertificate(app.server as unknown as Server, config.tlsFiles, {
    info: (m) => app.log.info(m),
    error: (m) => app.log.error(m),
  });
  app.log.info(`CloudMap en écoute sur ${config.publicOrigin} (HTTPS TLS 1.3, port ${config.port})`);
  return {
    close: async () => {
      stopWatch();
      await app.close();
    },
  };
}
