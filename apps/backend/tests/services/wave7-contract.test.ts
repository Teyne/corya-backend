import { beforeEach, describe, expect, it, vi } from 'vitest';

const getWave7ContractVersionMock = vi.fn<() => Promise<number>>();
vi.mock('../../src/db/queries.js', () => ({
  getWave7ContractVersion: getWave7ContractVersionMock,
}));

const { assertWave7Contract } = await import('../../src/services/wave7-contract.js');
const { runWave7GatedStartup } = await import('../../src/services/startup.js');

beforeEach(() => {
  getWave7ContractVersionMock.mockReset().mockResolvedValue(7);
});

describe('Wave 7 bootstrap gate', () => {
  it('prevents listen and every loop from starting when the contract is absent', async () => {
    const listen = vi.fn();
    const startJobLoop = vi.fn();
    const startDeletionLoop = vi.fn();
    const startAlertPollers = vi.fn();
    const absentContract = vi.fn<() => Promise<void>>().mockRejectedValue(
      new Error('db_get_wave7_contract_version_failed'),
    );

    await expect(runWave7GatedStartup(() => {
      listen();
      startJobLoop();
      startDeletionLoop();
      startAlertPollers();
    }, absentContract)).rejects.toThrow('db_get_wave7_contract_version_failed');

    expect(listen).not.toHaveBeenCalled();
    expect(startJobLoop).not.toHaveBeenCalled();
    expect(startDeletionLoop).not.toHaveBeenCalled();
    expect(startAlertPollers).not.toHaveBeenCalled();
  });
});

describe('Wave 7 startup contract', () => {
  it('allows API and worker startup only on contract version 7', async () => {
    await expect(assertWave7Contract()).resolves.toBeUndefined();
  });

  it('fails fast when the contract marker RPC is absent', async () => {
    getWave7ContractVersionMock.mockRejectedValueOnce(
      new Error('db_get_wave7_contract_version_failed'),
    );
    await expect(assertWave7Contract()).rejects.toThrow('db_get_wave7_contract_version_failed');
  });

  it('fails fast on any version other than 7', async () => {
    getWave7ContractVersionMock.mockResolvedValueOnce(6);
    await expect(assertWave7Contract()).rejects.toThrow('wave7_contract_version_mismatch');
  });
});
