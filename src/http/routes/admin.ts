import { Router } from 'express';
import { Services } from '../app';
import { adminUpdateProductBody } from '../validation';

/**
 * Administrative operations. Everything mounted under /admin is treated as
 * admin-only. Authentication is out of scope for the assignment; in production
 * this router would sit behind an admin auth middleware (see DECISIONS.md).
 */
export function adminRoutes(s: Services): Router {
  const r = Router();

  r.post('/coupons', (_req, res) => {
    res.status(201).json(s.coupons.generate());
  });

  r.get('/coupons', (_req, res) => {
    res.json({ coupons: s.coupons.list() });
  });

  r.get('/report', (_req, res) => {
    res.json(s.reports.summary());
  });

  r.patch('/products/:productId', (req, res) => {
    const body = adminUpdateProductBody.parse(req.body ?? {});
    res.json(s.products.adminUpdate(req.params.productId, body));
  });

  return r;
}
