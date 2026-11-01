/**
 * Every failure the API reports is an AppError with:
 *  - an HTTP status (the broad category, for generic clients and proxies), and
 *  - a stable machine-readable `code` (the specific reason, for client logic).
 *
 * Clients should branch on `code`, never on `message`, which is for humans.
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_JSON'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'CART_NOT_FOUND'
  | 'CART_NOT_OPEN'
  | 'CART_EMPTY'
  | 'CART_ALREADY_CHECKED_OUT'
  | 'ITEM_ALREADY_IN_CART'
  | 'ITEM_NOT_IN_CART'
  | 'PRODUCT_NOT_FOUND'
  | 'INSUFFICIENT_STOCK'
  | 'PRICE_CHANGED'
  | 'COUPON_NOT_FOUND'
  | 'COUPON_ALREADY_REDEEMED'
  | 'NO_ELIGIBLE_MILESTONE'
  | 'PAYMENT_DECLINED'
  | 'ORDER_NOT_FOUND'
  | 'NOT_FOUND'
  | 'SERVICE_BUSY'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (code: ErrorCode, message: string, details?: Record<string, unknown>) =>
  new AppError(404, code, message, details);
export const conflict = (code: ErrorCode, message: string, details?: Record<string, unknown>) =>
  new AppError(409, code, message, details);
export const unprocessable = (code: ErrorCode, message: string, details?: Record<string, unknown>) =>
  new AppError(422, code, message, details);
export const badRequest = (code: ErrorCode, message: string, details?: Record<string, unknown>) =>
  new AppError(400, code, message, details);
