import 'dotenv/config';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import {
  closeDb,
  exportDatabaseBackup,
  getDb,
  resolveConfiguredDbPath,
  resolvePersistentDataDir,
} from './server/db/database.ts';
import {
  hydrateDbOnStartupIfMissing,
  isRemoteGistSyncConfigured,
  pushRemoteSnapshotFromFile,
} from './server/db/remoteSnapshot.ts';
import { ensureRegistrySeeded } from './server/ai/registry.ts';
import { recoverInterruptedMissionsOnStartup } from './server/kernel/masterKernel.ts';
import { createApiRouter } from './server/routes/api.ts';
import { createPreviewRouter } from './server/routes/preview.ts';
import { startCommerceScheduler, stopCommerceScheduler } from './server/commerce/scheduler.ts';
import { isRequestHttps, runProductionPreflight } from './server/security/auth.ts';

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

async function startServer() {
  if (IS_PROD && process.env.NEXA_SKIP_PREFLIGHT !== 'true') {
    const preflight = runProductionPreflight({ requireProductionNodeEnv: true });
    if (!preflight.ok) {
      console.error('Production preflight failed. Refusing to start with unsafe configuration:');
      for (const issue of preflight.failures) {
        console.error(` - ${issue}`);
      }
      process.exit(1);
    }
  }

  const distDir = path.resolve(process.cwd(), 'dist');
  const distIndexPath = path.join(distDir, 'index.html');
  if (IS_PROD && !fs.existsSync(distIndexPath)) {
    console.error('Production build artifact missing (dist/index.html). Run `npm run build` before starting production server.');
    process.exit(1);
  }

  // Hydrate SQLite from remote snapshot (if configured) or verified bundled seed before opening DB
  await hydrateDbOnStartupIfMissing(resolveConfiguredDbPath(), resolvePersistentDataDir());

  // Initialize unified SQLite database, recover interrupted missions, and seed AI registry
  getDb();
  ensureRegistrySeeded();
  recoverInterruptedMissionsOnStartup();

  const app = express();
  app.set('trust proxy', 1);
  const httpServer = http.createServer(app);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // Basic security headers
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (!req.path.startsWith('/preview/')) {
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    }
    if (IS_PROD && isRequestHttps(req)) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  app.use('/preview', createPreviewRouter());
  app.use('/api', createApiRouter());

  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err instanceof SyntaxError && 'status' in err && (err as { status?: number }).status === 400 && 'body' in err) {
      res.status(400).json({ error: 'Invalid JSON request body' });
      return;
    }
    if (err) {
      console.error('Unhandled request error:', err instanceof Error ? err.message : 'unknown error');
      res.status(500).json({ error: IS_PROD ? 'Internal server error' : err instanceof Error ? err.message : 'Internal error' });
      return;
    }
    next();
  });

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: { server: httpServer },
        hmr: process.env.DISABLE_HMR === 'true' ? false : { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use('/api/*', (_req, res) => {
      res.status(404).json({ error: 'API endpoint not found' });
    });
    app.use('/preview/*', (_req, res) => {
      res.status(404).send('Preview resource not found');
    });
    app.use(express.static(distDir, { maxAge: '1h' }));
    app.get('*', (_req, res) => {
      res.sendFile(distIndexPath);
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`NEXA QUANT INTELLIGENCE listening on http://0.0.0.0:${PORT}`);
    startCommerceScheduler(60000);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; stopping scheduler and closing HTTP/SQLite cleanly...`);
    stopCommerceScheduler();
    const finalize = async () => {
      if (isRemoteGistSyncConfigured()) {
        try {
          const snap = exportDatabaseBackup();
          await Promise.race([
            pushRemoteSnapshotFromFile(snap.backupPath),
            new Promise((resolve) => setTimeout(resolve, 4000)),
          ]);
        } catch {
          // ignore remote sync error on shutdown
        }
      }
      closeDb();
      process.exit(0);
    };
    httpServer.close(() => {
      void finalize();
    });
    setTimeout(() => {
      closeDb();
      process.exit(0);
    }, 6500).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    console.error('Fatal uncaught exception; closing SQLite WAL safely:', err instanceof Error ? err.message : 'unknown');
    stopCommerceScheduler();
    closeDb();
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled async rejection:', reason instanceof Error ? reason.message : 'unknown');
  });
}

startServer().catch((err) => {
  console.error('Failed to start NEXA server:', err instanceof Error ? err.message : err);
  closeDb();
  process.exit(1);
});
