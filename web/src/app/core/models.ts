export interface EventRecord { eventId: string; name: string; currency: string; }
export interface Participant { participantId: string; name: string; reference: string; agreedMinor: string; }
export interface ImportRow {
  rowId: string; provider: string; movementId?: string; movement_id?: string;
  reference?: string; participantReference?: string; amountMinor: string; currency: string;
  status: string; reason?: string; participantId?: string; suggestedParticipantId?: string; candidates?: string[];
  suggestion?: { participantId: string; evidence?: string }; evidence?: string;
}
export interface ImportBatch { batchId: string; fileName: string; status: string; rows?: ImportRow[]; error?: string; rejected?: unknown[]; createdAt?: string; duplicateOf?: string; }
export interface Balance { participantId: string; paidMinor: string; agreedMinor: string; pendingMinor: string; currency: string; }
export interface Movement { movementId: string; participantId: string; amountMinor: string; currency: string; kind: string; reversalOf?: string; createdAt?: string; }
export interface BalancesResponse { version: number; balances: Balance[]; movements?: Movement[]; }
export interface RuntimeConfig { mode: 'local' | 'cloud'; cognitoDomain: string; clientId: string; }
