import { Router } from 'express';
import { badRequest } from '../../domain/errors';
import { Services } from '../app';
import { addItemBody, checkoutBody, idempotencyKey, updateItemBody } from '../validation';

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

  r.post('/:cartId/accept-current-prices', (req, res) => {
    res.json(s.carts.acceptCurrentPrices(req.params.cartId));
  });

  /**
   * Checkout. Requires an Idempotency-Key header. A repeat with the same key and
   * same body returns the original order (200 + Idempotent-Replayed: true)
   * instead of creating a new one.
   */
  r.post('/:cartId/checkout', (req, res) => {
    const rawKey = req.get('Idempotency-Key');
    if (!rawKey) {
      throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Checkout requires an Idempotency-Key header (e.g. a UUID)');
    }
    const key = idempotencyKey.parse(rawKey);
    const body = checkoutBody.parse(req.body ?? {});

    const outcome = s.checkout.checkout({
      cartId: req.params.cartId,
      couponCode: body.couponCode,
      idempotencyKey: key,
      simulatePaymentDecline: req.get('X-Simulate-Payment') === 'decline',
    });

    res.setHeader('Idempotent-Replayed', String(outcome.replayed));
    res.status(outcome.replayed ? 200 : 201).json(s.orders.get(outcome.orderId));
  });

  return r;
}
