import { Router } from 'express';
import { Services } from '../app';

export function orderRoutes(s: Services): Router {
  const r = Router();
  r.get('/:orderId', (req, res) => {
    res.json(s.orders.get(req.params.orderId));
  });
  return r;
}
