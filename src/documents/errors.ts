/**
 * Document-layer errors shared by the SQL backends.
 */

/**
 * A write hit a document that changed after the transaction staged it. The
 * transaction service turns this into `transaction_conflict`.
 */
export class ConflictError extends Error {}
