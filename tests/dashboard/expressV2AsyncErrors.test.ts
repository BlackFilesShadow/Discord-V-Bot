import '../../src/dashboard/expressAsyncErrors';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

describe('Express v2 async error bridge', () => {
  it('forwards rejected async route promises into Express error middleware', async () => {
    const app = express();

    app.get('/boom', async () => {
      await Promise.resolve();
      throw new Error('async boom');
    });

    app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      res.status(503).json({
        error: error instanceof Error ? error.message : 'unknown',
      });
    });

    const response = await request(app).get('/boom');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'async boom' });
  });

  it('preserves synchronous Express error handling', async () => {
    const app = express();

    app.get('/sync-boom', () => {
      throw new Error('sync boom');
    });

    app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      res.status(502).json({
        error: error instanceof Error ? error.message : 'unknown',
      });
    });

    const response = await request(app).get('/sync-boom');

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: 'sync boom' });
  });
});
