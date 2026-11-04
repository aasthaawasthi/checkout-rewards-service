import { Router } from 'express';
import { Services } from '../app';

export function productRoutes(s: Services): Router {
  const r = Router();
  r.get('/', (_req, res) => {
    res.json({ products: s.products.list() });
  });
  r.get('/:productId', (req, res) => {
    res.json(s.products.get(req.params.productId));
  });
  return r;
}
