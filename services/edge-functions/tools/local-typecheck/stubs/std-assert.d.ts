// Real-shaped @std/assert so assertion narrowing works (the loose `*` stub
// types assert as `any`, which loses the `asserts` predicate and produces false
// "possibly null" / "property does not exist" errors in existing tests).
declare module "@std/assert" {
  export function assert(expr: unknown, msg?: string): asserts expr;
  export function assertEquals<T>(actual: T, expected: T, msg?: string): void;
  export function assertExists<T>(actual: T, msg?: string): asserts actual is NonNullable<T>;
  export function assertNotEquals<T>(actual: T, expected: T, msg?: string): void;
  export function assertStrictEquals<T>(actual: unknown, expected: T, msg?: string): asserts actual is T;
  export function assertThrows(fn: () => unknown, msg?: string): unknown;
  export function assertRejects(fn: () => Promise<unknown>, msg?: string): Promise<unknown>;
  export function assertMatch(actual: string, expected: RegExp, msg?: string): void;
  export function assertStringIncludes(actual: string, expected: string, msg?: string): void;
  export function assertArrayIncludes<T>(actual: ArrayLike<T>, expected: ArrayLike<T>, msg?: string): void;
  export function assertAlmostEquals(actual: number, expected: number, tolerance?: number, msg?: string): void;
  export function assertFalse(expr: unknown, msg?: string): void;
  export function assertInstanceOf<T>(actual: unknown, expected: new (...args: never[]) => T, msg?: string): asserts actual is T;
  export function assertObjectMatch(actual: Record<PropertyKey, unknown>, expected: Record<PropertyKey, unknown>, msg?: string): void;
  export function fail(msg?: string): never;
  export function unreachable(msg?: string): never;
}
