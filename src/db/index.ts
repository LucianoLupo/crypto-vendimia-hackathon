import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, lte, and, desc, max } from 'drizzle-orm';
import * as schema from './schema';
import type { User, NewUser, DCAOrder, NewDCAOrder, Execution, NewExecution } from './schema';

const sqlite = new Database('./autostack.db');

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    whatsapp_id TEXT NOT NULL UNIQUE,
    wallet_index INTEGER NOT NULL UNIQUE,
    wallet_address TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS dca_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    from_token TEXT NOT NULL,
    to_token TEXT NOT NULL,
    amount TEXT NOT NULL,
    frequency TEXT NOT NULL,
    auto_yield INTEGER NOT NULL DEFAULT 1,
    yield_protocol TEXT NOT NULL DEFAULT 'sovryn',
    status TEXT NOT NULL DEFAULT 'active',
    next_execution TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dca_order_id INTEGER REFERENCES dca_orders(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    swap_tx_hash TEXT,
    yield_tx_hash TEXT,
    amount_in TEXT NOT NULL,
    amount_out TEXT,
    yield_tokens_received TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    executed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

export const db = drizzle(sqlite, { schema });

export function getUserByWhatsappId(whatsappId: string): User | undefined {
  return db
    .select()
    .from(schema.users)
    .where(eq(schema.users.whatsappId, whatsappId))
    .get();
}

export function getOrCreateUser(whatsappId: string): User {
  const existing = getUserByWhatsappId(whatsappId);
  if (existing) return existing;

  const result = db
    .select({ maxIndex: max(schema.users.walletIndex) })
    .from(schema.users)
    .get();

  const nextIndex = result?.maxIndex != null ? result.maxIndex + 1 : 0;

  // walletAddress will be set by the caller after wallet derivation; we insert a placeholder
  // and rely on the wallet service to update it. For hackathon simplicity, we derive it here
  // by computing from index — but wallet.ts owns derivation, so we return the index to the caller.
  // Instead, we accept that getOrCreateUser is called AFTER address is known, so we use a
  // two-step approach: insert with empty address then update, or accept address as param.
  // Since the spec says getOrCreateUser(whatsappId) with no address param, we insert with
  // a placeholder and the bot layer is responsible for updating the address after derivation.
  const inserted = db
    .insert(schema.users)
    .values({
      whatsappId,
      walletIndex: nextIndex,
      walletAddress: '',
    } as NewUser)
    .returning()
    .get();

  return inserted;
}

export function createDCAOrder(params: Omit<NewDCAOrder, 'id' | 'createdAt'>): DCAOrder {
  return db
    .insert(schema.dcaOrders)
    .values(params)
    .returning()
    .get();
}

export function getActiveDCAOrders(userId: number): DCAOrder[] {
  return db
    .select()
    .from(schema.dcaOrders)
    .where(
      and(
        eq(schema.dcaOrders.userId, userId),
        eq(schema.dcaOrders.status, 'active')
      )
    )
    .all();
}

export function getDueOrders(): DCAOrder[] {
  const now = new Date().toISOString();
  return db
    .select()
    .from(schema.dcaOrders)
    .where(
      and(
        eq(schema.dcaOrders.status, 'active'),
        lte(schema.dcaOrders.nextExecution, now)
      )
    )
    .all();
}

export function updateOrderNextExecution(orderId: number, nextExecution: string): void {
  db.update(schema.dcaOrders)
    .set({ nextExecution })
    .where(eq(schema.dcaOrders.id, orderId))
    .run();
}

export function updateOrderStatus(orderId: number, status: string): void {
  db.update(schema.dcaOrders)
    .set({ status })
    .where(eq(schema.dcaOrders.id, orderId))
    .run();
}

export function logExecution(params: Omit<NewExecution, 'id' | 'executedAt'>): void {
  db.insert(schema.executions).values(params).run();
}

export function getUserExecutions(userId: number, limit = 10): Execution[] {
  return db
    .select()
    .from(schema.executions)
    .where(eq(schema.executions.userId, userId))
    .orderBy(desc(schema.executions.executedAt))
    .limit(limit)
    .all();
}
