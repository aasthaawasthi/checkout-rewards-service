import express, { Express } from 'express';
import { AppConfig } from '../config';
import { DB } from '../db/database';
import { notFound } from '../domain/errors';
import { CartService } from '../services/cartService';
import { CheckoutService } from '../services/checkoutService';
import { CouponService } from '../services/couponService';
import { OrderService } from '../services/orderService';
import { FakePaymentGateway, PaymentGateway } from '../services/payment';
import { ProductService } from '../services/productService';
import { ReportService } from '../services/reportService';
import { errorHandler } from './errorHandler';
import { adminRoutes } from './routes/admin';
import { cartRoutes } from './routes/carts';
import { orderRoutes } from './routes/orders';
import { productRoutes } from './routes/products';

export interface Services {
  products: ProductService;
  carts: CartService;
  checkout: CheckoutService;
  orders: OrderService;
  coupons: CouponService;
  reports: ReportService;
}

export interface AppDeps {
  db: DB;
  config: AppConfig;
  payments?: PaymentGateway;
}

/** Builds the Express app. Dependencies are injected so tests can use their own DB and fakes. */
export function createApp(deps: AppDeps): Express {
  const payments = deps.payments ?? new FakePaymentGateway();
  const services: Services = {
    products: new ProductService(deps.db),
    carts: new CartService(deps.db),
    checkout: new CheckoutService(deps.db, payments),
    orders: new OrderService(deps.db),
    coupons: new CouponService(deps.db, deps.config.milestoneN, deps.config.discountPercentX),
    reports: new ReportService(deps.db, deps.config.milestoneN, deps.config.discountPercentX),
  };

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.use('/products', productRoutes(services));
  app.use('/carts', cartRoutes(services));
  app.use('/orders', orderRoutes(services));
  app.use('/admin', adminRoutes(services));

  app.use((req, _res, next) => next(notFound('NOT_FOUND', `No route for ${req.method} ${req.path}`)));
  app.use(errorHandler);
  return app;
}
