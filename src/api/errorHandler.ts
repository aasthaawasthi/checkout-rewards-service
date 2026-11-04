import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../domain/errors';

/**
 * Single place that turns any thrown error into the API's error envelope:
 *
 *   { "error": { "code": "INSUFFICIENT_STOCK", "message": "...", "details": { ... } } }
 */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details ?? {} } });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request is invalid',
        details: { issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
      },
    });
    return;
  }

  const e = err as { type?: string; code?: string; message?: string };

  // Malformed JSON body (raised by express.json()).
  if (e?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON', details: {} } });
    return;
  }

  // Another writer held the database lock for longer than busy_timeout. Nothing
  // was changed, so the client can safely retry (with the same Idempotency-Key).
  if (e?.code === 'SQLITE_BUSY') {
    res.setHeader('Retry-After', '1');
    res
      .status(503)
      .json({ error: { code: 'SERVICE_BUSY', message: 'Service is busy, please retry', details: {} } });
    return;
  }

  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected error', details: {} } });
}
