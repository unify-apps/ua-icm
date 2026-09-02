// Hand-written request/response contracts for the callables the ICM pages
// invoke. Mirrors docs/automations/*.md — when a spec changes, this changes in
// the same commit, and vice versa.
//
// Nothing is built yet, so this file holds only the shapes every callable
// shares. Add one request/response pair per callable as it is specified.

/** Every callable answers with a status. A transport 200 does NOT mean the work happened. */
export type IcmStatus =
  | "SUCCESS"
  | "INVALID_INPUT"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "PERIOD_LOCKED"
  | "CALCULATION_IN_PROGRESS"
  | "OVERLAPPING_ASSIGNMENT"
  | "CREDIT_OVER_ALLOCATED"
  | "RATE_TABLE_INVALID"
  | "PARTIAL_FAILURE";

/** The envelope every callable returns. Branch on `status`, never on the HTTP code. */
export interface IcmResponse<T> {
  success: boolean;
  status: IcmStatus;
  /** Human-readable, safe to show. Present on every non-success outcome. */
  message?: string;
  /** Present only when `success` is true. */
  data?: T;
}

/**
 * An amount never travels without its currency. Minor units vs decimal is an
 * open decision — see docs/model/money-and-time.md and open question 8 — so
 * this type deliberately does not yet commit to `number`.
 */
export interface IcmMoney {
  /** Serialized exactly; do not parse into a float before displaying. */
  amount: string;
  /** ISO 4217, e.g. "USD". */
  currency: string;
}

/** Paging shape shared by every list callable. */
export interface IcmPage {
  limit: number;
  offset?: number;
}

export interface IcmPagedData<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}
