/**
 * Typed results for expected outcomes (AGENTS §4.1).
 *
 * Expected outcomes such as not found, forbidden, conflict and validation failures are returned as
 * `Result` values, never thrown. This matters most across Durable Object RPC, where a thrown denial is
 * logged as an uncaught exception (spike finding). Results are plain objects, so they survive
 * structured cloning across RPC unchanged.
 */

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E> = Ok<T> | Err<E>;

export function ok(): Ok<void>;
export function ok<T>(value: T): Ok<T>;
export function ok<T>(value?: T): Ok<T | undefined> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}
