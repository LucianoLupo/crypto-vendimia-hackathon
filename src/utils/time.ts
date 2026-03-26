export function calcNextExecution(frequency: string, fromTime?: string): string {
  const next = fromTime ? new Date(fromTime) : new Date();
  switch (frequency) {
    case 'hourly':
      next.setHours(next.getHours() + 1);
      break;
    case 'weekly':
      next.setDate(next.getDate() + 7);
      break;
    case 'daily':
    default:
      next.setDate(next.getDate() + 1);
  }
  return next.toISOString();
}
