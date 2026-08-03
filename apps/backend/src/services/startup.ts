import { assertWave7Contract } from './wave7-contract.js';

/** Gate every externally visible startup action behind the Wave 7 contract. */
export async function runWave7GatedStartup<T>(
  start: () => T | Promise<T>,
  assertContract: () => Promise<void> = assertWave7Contract,
): Promise<T> {
  await assertContract();
  return start();
}
