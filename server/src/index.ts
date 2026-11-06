import { createApp } from './app';
import { loadConfig } from './lib/config';
import { createLogger } from './lib/logger';

export function startServer(): void {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const app = createApp({ config, logger });
  const server = app.listen(config.port, config.host, () => {
    logger.info(`GReview server listening on http://${config.host}:${config.port}`);
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`端口 ${config.port} 已被占用，请通过 PORT 环境变量指定其他端口`);
    } else {
      logger.error('server failed', { error: err.message });
    }
    process.exitCode = 1;
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  startServer();
}
