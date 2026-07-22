// Placeholder-only data source for the Transfers preview (profile-v2/
// transfers-preview.tsx) and the full Transactions page
// (app/transactions/[userId].tsx) — no ownership-transfer table/query
// exists yet. Both screens read from this single fixed list regardless of
// which userId is passed in, so the preview's "recent activity" and the
// full page's list can never disagree with each other. Swap the body of
// getPlaceholderTransactions for a real per-user query once the schema
// exists; every call site already threads userId through in preparation.
export type TransactionPreview = {
  id: string;
  itemTitle: string;
  direction: 'sent' | 'received';
  counterpartUsername: string;
  date: string;
  status?: 'completed' | 'pending';
  imageUrl?: string | null;
};

const PLACEHOLDER_TRANSACTIONS: TransactionPreview[] = [
  { id: '1', itemTitle: 'Shohei Ohtani', direction: 'sent', counterpartUsername: 'username', date: '2026-10-02', status: 'completed' },
  { id: '2', itemTitle: 'Lamar Jackson', direction: 'received', counterpartUsername: 'username', date: '2026-09-18', status: 'completed' },
  { id: '3', itemTitle: 'Munetaka Murakami', direction: 'sent', counterpartUsername: 'collector', date: '2026-09-04', status: 'completed' },
  { id: '4', itemTitle: 'Victor Wembanyama', direction: 'received', counterpartUsername: 'hoopsfan', date: '2026-08-22', status: 'pending' },
  { id: '5', itemTitle: 'Paul Skenes', direction: 'sent', counterpartUsername: 'pirates_pc', date: '2026-08-11', status: 'completed' },
  { id: '6', itemTitle: 'Caitlin Clark', direction: 'received', counterpartUsername: 'wnbacards', date: '2026-07-30', status: 'pending' },
  { id: '7', itemTitle: 'Bobby Witt Jr.', direction: 'sent', counterpartUsername: 'royalsvault', date: '2026-07-15', status: 'completed' },
  { id: '8', itemTitle: 'Jayden Daniels', direction: 'received', counterpartUsername: 'rookiewatch', date: '2026-06-28', status: 'completed' },
  { id: '9', itemTitle: 'Anthony Edwards', direction: 'sent', counterpartUsername: 'twolvesfan', date: '2026-06-10', status: 'completed' },
  { id: '10', itemTitle: 'Angel Reese', direction: 'received', counterpartUsername: 'sky_collector', date: '2026-05-22', status: 'pending' },
  { id: '11', itemTitle: 'Jackson Merrill', direction: 'sent', counterpartUsername: 'padrescards', date: '2026-05-03', status: 'completed' },
  { id: '12', itemTitle: 'Ronald Acuña Jr.', direction: 'received', counterpartUsername: 'cardvault', date: '2026-04-19', status: 'completed' },
];

// userId is accepted (and will matter once this is backed by a real query)
// but unused today — every profile sees the same fixed placeholder list.
export function getPlaceholderTransactions(userId: string | undefined): TransactionPreview[] {
  return PLACEHOLDER_TRANSACTIONS;
}

export function getTransactionSummary(transactions: TransactionPreview[]): { total: number; pending: number } {
  return {
    total: transactions.length,
    pending: transactions.filter((t) => t.status === 'pending').length,
  };
}

export function formatTransactionDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
