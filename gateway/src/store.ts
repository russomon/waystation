// Minimal in-memory transfer registry — enough to remember each transfer's
// BLAKE3 root (the verify-range anchor) between `complete` and the delivery
// page. Lost on restart. Production: SQLite or a Durable Object keyed by
// transferId, plus recipients, expiry, and access control.
export interface TransferMeta {
  key: string;
  blake3Root?: string; // absent if the client skipped hashing
  createdAt: number;
  // Sender-selected services + QC profile/compute target; undefined = everything on.
  options?: Record<string, boolean | string>;
}

const transfers = new Map<string, TransferMeta>();

export const saveTransfer = (transferId: string, meta: TransferMeta): void => {
  transfers.set(transferId, meta);
};
export const getTransfer = (transferId: string): TransferMeta | undefined =>
  transfers.get(transferId);
