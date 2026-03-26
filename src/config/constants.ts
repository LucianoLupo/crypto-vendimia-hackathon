export const ORDER_STATUS = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  CANCELLED: 'cancelled',
} as const;

export const EXEC_STATUS = {
  COMPLETED: 'completed',
  FAILED: 'failed',
  PENDING: 'pending',
} as const;
