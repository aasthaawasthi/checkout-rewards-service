import { Router } from 'express';
import { Services } from '../app';
import { addItemBody, updateItemBody } from '../validation';

export function cartRoutes(s: Services): Router {
  const r = Router();

  r.post('/', (_req, res) => {
    res.status(201).json(s.carts.create());
  });

  r.get('/:cartId', (req, res) => {
    res.json(s.carts.view(req.params.cartId));
  });

  r.post('/:cartId/items', (req, res) => {
    const body = addItemBody.parse(req.body ?? {});
    res.status(201).json(s.carts.addItem(req.params.cartId, body.productId, body.quantity));
  });

  r.patch('/:cartId/items/:productId', (req, res) => {
    const body = updateItemBody.parse(req.body ?? {});
    res.json(s.carts.updateItem(req.params.cartId, req.params.productId, body.quantity));
  });

  r.delete('/:cartId/items/:productId', (req, res) => {
    res.json(s.carts.removeItem(req.params.cartId, req.params.productId));
  });

  return r;
}
