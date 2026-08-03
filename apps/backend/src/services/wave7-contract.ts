import { getWave7ContractVersion } from '../db/queries.js';

export const WAVE7_CONTRACT_VERSION = 7;

/** Refuse startup against a database missing any Wave 7 migration. */
export async function assertWave7Contract(): Promise<void> {
  const version = await getWave7ContractVersion();
  if (version !== WAVE7_CONTRACT_VERSION) {
    throw new Error('wave7_contract_version_mismatch');
  }
}
