import { EventRecord } from './models';
export interface EventList { events: EventRecord[]; usage?: { nonArchivedEvents: number; limit: number | null }; }
export interface EventTemplate { templateId: string; name: string; currency: string; version: number; participantCount: number; participants?: { name: string; reference: string; agreedMinor: string }[]; sourceEventId?: string; sourceEventRevision?: number; createdAt?: string; }
export interface Closure { closureId: string; createdAt: string; createdBy: string; ledgerVersion: number; rosterRevision: number; }
export interface ReopeningTransition { kind: 'reopening'; operationId: string; closureId: string; expectedLifecycleVersion: number; expectedEventRevision: number; }
export interface ClosingState { financialStatus: 'open' | 'closed'; lifecycleVersion: number; ledgerVersion: number; eventRevision: number; archivedAt?: string; transition?: ReopeningTransition; closures: Closure[]; latestClosure?: Closure; canClose: boolean; canReopen: boolean; canArchive: boolean; }
export interface EventReport { fileName: string; contentType: string; content: string; ledgerVersion: number; closureId?: string; }
export interface EventOverview { event: EventRecord; financialStatus: 'open' | 'closed'; ledgerVersion: number; totals: { agreedMinor: string; paidMinor: string; pendingMinor: string; currency: string }; }
export interface OverviewResponse { events: EventOverview[]; totalsByCurrency: { agreedMinor: string; paidMinor: string; pendingMinor: string; currency: string }[]; activeOnly?: true; usage?: EventList['usage']; }
