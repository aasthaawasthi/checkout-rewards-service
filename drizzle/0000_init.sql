CREATE TABLE `cart_items` (
	`cart_id` text NOT NULL,
	`product_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`price_seen_paise` integer NOT NULL,
	`added_at` text NOT NULL,
	PRIMARY KEY(`cart_id`, `product_id`),
	FOREIGN KEY (`cart_id`) REFERENCES `carts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "cart_items_quantity_positive" CHECK("cart_items"."quantity" > 0),
	CONSTRAINT "cart_items_price_seen_non_negative" CHECK("cart_items"."price_seen_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE `carts` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "carts_status_valid" CHECK("carts"."status" IN ('OPEN', 'CHECKED_OUT'))
);
--> statement-breakpoint
CREATE TABLE `coupons` (
	`code` text PRIMARY KEY NOT NULL,
	`milestone` integer NOT NULL,
	`unlocked_at_order` integer NOT NULL,
	`discount_percent` integer NOT NULL,
	`status` text NOT NULL,
	`generated_at` text NOT NULL,
	`redeemed_order_id` text,
	`redeemed_at` text,
	FOREIGN KEY (`redeemed_order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "coupons_milestone_positive" CHECK("coupons"."milestone" >= 1),
	CONSTRAINT "coupons_percent_range" CHECK("coupons"."discount_percent" BETWEEN 1 AND 100),
	CONSTRAINT "coupons_status_valid" CHECK("coupons"."status" IN ('AVAILABLE', 'REDEEMED')),
	CONSTRAINT "coupons_redeemed_has_order" CHECK(("coupons"."status" = 'REDEEMED') = ("coupons"."redeemed_order_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `coupons_milestone_unique` ON `coupons` (`milestone`);--> statement-breakpoint
CREATE UNIQUE INDEX `coupons_redeemed_order_id_unique` ON `coupons` (`redeemed_order_id`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`key` text PRIMARY KEY NOT NULL,
	`cart_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`order_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `order_items` (
	`order_id` text NOT NULL,
	`product_id` text NOT NULL,
	`product_name` text NOT NULL,
	`unit_price_paise` integer NOT NULL,
	`quantity` integer NOT NULL,
	`line_total_paise` integer NOT NULL,
	PRIMARY KEY(`order_id`, `product_id`),
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "order_items_unit_price_non_negative" CHECK("order_items"."unit_price_paise" >= 0),
	CONSTRAINT "order_items_quantity_positive" CHECK("order_items"."quantity" > 0),
	CONSTRAINT "order_items_line_total_non_negative" CHECK("order_items"."line_total_paise" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_order_items_product` ON `order_items` (`product_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`order_number` integer NOT NULL,
	`cart_id` text NOT NULL,
	`status` text NOT NULL,
	`subtotal_paise` integer NOT NULL,
	`discount_paise` integer NOT NULL,
	`total_paise` integer NOT NULL,
	`coupon_code` text,
	`discount_percent` integer,
	`payment_reference` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`cart_id`) REFERENCES `carts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "orders_status_valid" CHECK("orders"."status" IN ('PLACED')),
	CONSTRAINT "orders_subtotal_non_negative" CHECK("orders"."subtotal_paise" >= 0),
	CONSTRAINT "orders_discount_non_negative" CHECK("orders"."discount_paise" >= 0),
	CONSTRAINT "orders_total_non_negative" CHECK("orders"."total_paise" >= 0),
	CONSTRAINT "orders_total_consistent" CHECK("orders"."total_paise" = "orders"."subtotal_paise" - "orders"."discount_paise")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_order_number_unique` ON `orders` (`order_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_cart_id_unique` ON `orders` (`cart_id`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`price_paise` integer NOT NULL,
	`stock` integer NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "products_price_non_negative" CHECK("products"."price_paise" >= 0),
	CONSTRAINT "products_stock_non_negative" CHECK("products"."stock" >= 0)
);
