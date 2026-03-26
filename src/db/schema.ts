import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  whatsappId: text('whatsapp_id').notNull().unique(),
  walletIndex: integer('wallet_index').notNull().unique(),
  walletAddress: text('wallet_address').notNull(),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const dcaOrders = sqliteTable('dca_orders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().references(() => users.id),
  fromToken: text('from_token').notNull(),
  toToken: text('to_token').notNull(),
  amount: text('amount').notNull(),
  frequency: text('frequency').notNull(),
  autoYield: integer('auto_yield').notNull().default(1),
  yieldProtocol: text('yield_protocol').notNull().default('sovryn'),
  status: text('status').notNull().default('active'),
  nextExecution: text('next_execution').notNull(),
  failureCount: integer('failure_count').notNull().default(0),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const executions = sqliteTable('executions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dcaOrderId: integer('dca_order_id').references(() => dcaOrders.id),
  userId: integer('user_id').notNull().references(() => users.id),
  swapTxHash: text('swap_tx_hash'),
  yieldTxHash: text('yield_tx_hash'),
  amountIn: text('amount_in').notNull(),
  amountOut: text('amount_out'),
  yieldTokensReceived: text('yield_tokens_received'),
  status: text('status').notNull().default('pending'),
  error: text('error'),
  executedAt: text('executed_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;

export type DCAOrder = InferSelectModel<typeof dcaOrders>;
export type NewDCAOrder = InferInsertModel<typeof dcaOrders>;

export type Execution = InferSelectModel<typeof executions>;
export type NewExecution = InferInsertModel<typeof executions>;
