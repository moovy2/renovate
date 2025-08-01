import is from '@sindresorhus/is';
import { getConfig } from '../../../config/defaults';
import { GlobalConfig } from '../../../config/global';
import { addMeta } from '../../../logger';
import { hashMap } from '../../../modules/manager';
import * as _repoCache from '../../../util/cache/repository';
import type {
  BranchCache,
  RepoCacheData,
} from '../../../util/cache/repository/types';
import { fingerprint } from '../../../util/fingerprint';
import type { LongCommitSha } from '../../../util/git/types';
import { counts } from '../../global/limits';
import type { BranchConfig, BranchUpgradeConfig } from '../../types';
import * as _branchWorker from '../update/branch';
import * as _limits from './limits';
import {
  compareCacheFingerprint,
  generateCommitFingerprintConfig,
  syncBranchState,
  writeUpdates,
} from './write';
import { logger, partial, scm } from '~test/util';
import type { RenovateConfig } from '~test/util';

vi.mock('../../../util/cache/repository');
vi.mock('./limits');
vi.mock('../update/branch');

const branchWorker = vi.mocked(_branchWorker);
const limits = vi.mocked(_limits);
const repoCache = vi.mocked(_repoCache);

let config: RenovateConfig;

beforeEach(() => {
  config = getConfig();
  repoCache.getCache.mockReturnValue({});
  limits.getConcurrentPrsCount.mockResolvedValue(0);
  limits.getConcurrentBranchesCount.mockResolvedValue(0);
  limits.getPrHourlyCount.mockResolvedValue(0);
});

describe('workers/repository/process/write', () => {
  describe('writeUpdates()', () => {
    it('stops after automerge', async () => {
      const branches: BranchConfig[] = [
        {
          branchName: 'test_branch',
          baseBranch: 'base',
          manager: 'npm',
          upgrades: [],
        },
        {
          branchName: 'test_branch',
          baseBranch: 'base',
          manager: 'npm',
          upgrades: [],
        },
        {
          branchName: 'test_branch',
          baseBranch: 'base',
          manager: 'npm',
          automergeType: 'pr-comment',
          ignoreTests: true,
          upgrades: [],
        },
        {
          branchName: 'test_branch',
          baseBranch: 'base',
          manager: 'npm',
          upgrades: [],
        },
        {
          branchName: 'test_branch',
          baseBranch: 'base',
          manager: 'npm',
          upgrades: [],
        },
      ];
      scm.branchExists.mockResolvedValue(true);
      branchWorker.processBranch.mockResolvedValueOnce({
        branchExists: true,
        result: 'pr-created',
      });
      branchWorker.processBranch.mockResolvedValueOnce({
        branchExists: false,
        result: 'already-existed',
      });
      branchWorker.processBranch.mockResolvedValueOnce({
        branchExists: false,
        result: 'automerged',
      });
      branchWorker.processBranch.mockResolvedValueOnce({
        branchExists: false,
        result: 'automerged',
      });
      GlobalConfig.set({ dryRun: 'full' });
      const res = await writeUpdates(config, branches);
      expect(res).toBe('automerged');
      expect(branchWorker.processBranch).toHaveBeenCalledTimes(4);
    });

    it('increments branch counter', async () => {
      const branchName = 'branchName';
      const branches = partial<BranchConfig[]>([
        {
          baseBranch: 'main',
          branchName,
          upgrades: partial<BranchUpgradeConfig>([{ prConcurrentLimit: 10 }]),
          manager: 'npm',
        },
        {
          baseBranch: 'dev',
          branchName,
          upgrades: partial<BranchUpgradeConfig>([{ prConcurrentLimit: 10 }]),
          manager: 'npm',
        },
      ]);
      repoCache.getCache.mockReturnValueOnce({});
      branchWorker.processBranch.mockResolvedValueOnce({
        branchExists: true,
        result: 'pr-created',
      });

      limits.getConcurrentPrsCount.mockResolvedValue(0);
      limits.getConcurrentBranchesCount.mockResolvedValue(0);
      limits.getPrHourlyCount.mockResolvedValue(0);

      scm.branchExists.mockResolvedValueOnce(false).mockResolvedValue(true);
      GlobalConfig.set({ dryRun: 'full' });
      config.baseBranchPatterns = ['main', 'dev'];
      await writeUpdates(config, branches);
      expect(counts.get('Branches')).toBe(1);
      expect(addMeta).toHaveBeenCalledWith({
        baseBranch: 'main',
        branch: branchName,
      });
      expect(addMeta).toHaveBeenCalledWith({
        baseBranch: 'dev',
        branch: branchName,
      });
    });

    it('return no-work if branch fingerprint is not different', async () => {
      const branches: BranchConfig[] = [
        {
          branchName: 'new/some-branch',
          baseBranch: 'base',
          manager: 'npm',
          upgrades: [
            partial<BranchUpgradeConfig>({
              manager: 'npm',
            }),
          ],
        },
      ];
      repoCache.getCache.mockReturnValueOnce({
        branches: [
          partial<BranchCache>({
            branchName: 'new/some-branch',
            sha: '111',
            commitFingerprint: '111',
          }),
        ],
      });
      branchWorker.processBranch.mockResolvedValueOnce({
        branchExists: true,
        result: 'no-work',
      });
      expect(await writeUpdates(config, branches)).toBe('done');
    });

    it('updates branch fingerprint when new commit is made', async () => {
      const branches: BranchConfig[] = [
        {
          branchName: 'new/some-branch',
          baseBranch: 'base',
          manager: 'npm',
          upgrades: [
            partial<BranchUpgradeConfig>({
              manager: 'unknown-manager',
            }),
          ],
        },
      ];
      repoCache.getCache.mockReturnValueOnce({
        branches: [
          partial<BranchCache>({
            branchName: 'new/some-branch',
            commitFingerprint: '222',
          }),
        ],
      });
      branchWorker.processBranch.mockResolvedValueOnce({
        branchExists: true,
        updatesVerified: true,
        result: 'done',
        commitSha: 'some-value',
      });
      const branch = branches[0];
      const managers = [
        ...new Set(
          branch.upgrades
            .map((upgrade) => hashMap.get(upgrade.manager) ?? upgrade.manager)
            .filter(is.string),
        ),
      ].sort();
      const commitFingerprint = fingerprint({
        commitFingerprintConfig: generateCommitFingerprintConfig(branch),
        managers,
      });
      expect(await writeUpdates(config, branches)).toBe('done');
      expect(branch.commitFingerprint).toBe(commitFingerprint);
    });

    it('caches same fingerprint when no commit is made and branch cache existed', async () => {
      const branches: BranchConfig[] = [
        {
          branchName: 'new/some-branch',
          baseBranch: 'base_branch',
          manager: 'npm',
          upgrades: [
            partial<BranchUpgradeConfig>({
              manager: 'unknown-manager',
            }),
          ],
        },
      ];
      const branch = branches[0];
      const managers = [
        ...new Set(
          branch.upgrades
            .map((upgrade) => hashMap.get(upgrade.manager) ?? upgrade.manager)
            .filter(is.string),
        ),
      ].sort();

      const commitFingerprint = fingerprint({
        branch,
        managers,
      });
      repoCache.getCache.mockReturnValueOnce({
        branches: [
          partial<BranchCache>({
            branchName: 'new/some-branch',
            baseBranch: 'base_branch',
            commitFingerprint,
          }),
        ],
      });
      branchWorker.processBranch.mockResolvedValueOnce({
        branchExists: true,
        result: 'done',
      });
      scm.branchExists.mockResolvedValue(true);
      config.repositoryCache = 'enabled';
      expect(await writeUpdates(config, branches)).toBe('done');
      expect(branch.commitFingerprint).toBe(commitFingerprint);
    });

    it('caches same fingerprint when no commit is made', async () => {
      const branches: BranchConfig[] = [
        {
          branchName: 'new/some-branch',
          baseBranch: 'base_branch',
          manager: 'npm',
          upgrades: [
            partial<BranchUpgradeConfig>({
              manager: 'unknown-manager',
            }),
          ],
        },
      ];
      const branch = branches[0];
      const managers = [
        ...new Set(
          branch.upgrades
            .map((upgrade) => hashMap.get(upgrade.manager) ?? upgrade.manager)
            .filter(is.string),
        ),
      ].sort();
      const commitFingerprint = fingerprint({
        branch,
        managers,
      });
      repoCache.getCache.mockReturnValueOnce({
        branches: [
          partial<BranchCache>({
            branchName: 'new/some-branch',
            baseBranch: 'base_branch',
            commitFingerprint,
          }),
        ],
      });
      branchWorker.processBranch.mockResolvedValueOnce({
        branchExists: true,
        result: 'done',
      });
      expect(await writeUpdates(config, branches)).toBe('done');
      expect(branch.commitFingerprint).toBe(commitFingerprint);
    });

    it('creates new branchCache when cache is not enabled', async () => {
      const branches: BranchConfig[] = [
        {
          branchName: 'new/some-branch',
          baseBranch: 'base_branch',
          manager: 'npm',
          upgrades: [
            partial<BranchUpgradeConfig>({
              manager: 'npm',
            }),
          ],
        },
      ];
      const repoCacheObj = partial<RepoCacheData>();
      repoCache.getCache.mockReturnValueOnce(repoCacheObj);
      branchWorker.processBranch.mockResolvedValueOnce({
        branchExists: true,
        result: 'no-work',
      });
      scm.getBranchCommit
        .mockResolvedValueOnce('sha' as LongCommitSha)
        .mockResolvedValueOnce('base_sha' as LongCommitSha);
      scm.branchExists.mockResolvedValueOnce(true);
      await writeUpdates(config, branches);
      expect(logger.logger.debug).not.toHaveBeenCalledWith(
        'No branch cache found for new/some-branch',
      );
      expect(repoCacheObj).toEqual({
        branches: [
          {
            branchName: 'new/some-branch',
            baseBranch: 'base_branch',
            baseBranchSha: 'base_sha',
            sha: 'sha',
          },
        ],
      });
    });
  });

  describe('canSkipBranchUpdateCheck()', () => {
    let branchCache: BranchCache = {
      branchName: 'branch',
      baseBranch: 'base',
      baseBranchSha: 'base_sha',
      sha: 'sha',
      upgrades: [],
      automerge: false,
      prNo: null,
    };

    it('returns false if no cache', () => {
      branchCache = {
        ...branchCache,
        branchName: 'new/some-branch',
        sha: '111',
      };
      expect(compareCacheFingerprint(branchCache, '222')).toBe(
        'no-fingerprint',
      );
    });

    it('returns false when fingerprints are not same', () => {
      branchCache = {
        ...branchCache,
        branchName: 'new/some-branch',
        sha: '111',
        commitFingerprint: '211',
      };
      expect(compareCacheFingerprint(branchCache, '222')).toBe('no-match');
    });

    it('returns true', () => {
      branchCache = {
        ...branchCache,
        branchName: 'new/some-branch',
        sha: '111',
        commitFingerprint: '222',
      };
      expect(compareCacheFingerprint(branchCache, '222')).toBe('matched');
    });
  });

  describe('syncBranchState()', () => {
    it('creates minimal branch state when cache is not populated', () => {
      const repoCacheObj = partial<RepoCacheData>();
      repoCache.getCache.mockReturnValue(repoCacheObj);
      scm.getBranchCommit.mockResolvedValueOnce('sha' as LongCommitSha);
      scm.getBranchCommit.mockResolvedValueOnce('base_sha' as LongCommitSha);
      return expect(
        syncBranchState('branch_name', 'base_branch'),
      ).resolves.toEqual({
        branchName: 'branch_name',
        sha: 'sha',
        baseBranch: 'base_branch',
        baseBranchSha: 'base_sha',
      });
    });

    it('when base branch name is different updates it and invalidates related cache', () => {
      const repoCacheObj: RepoCacheData = {
        branches: [
          {
            branchName: 'branch_name',
            baseBranch: 'base_branch',
            sha: 'sha',
            baseBranchSha: 'base_sha',
            isModified: true,
            pristine: false,
            upgrades: [],
            automerge: false,
            prNo: null,
          },
        ],
      };
      repoCache.getCache.mockReturnValue(repoCacheObj);
      scm.getBranchCommit.mockResolvedValueOnce('sha' as LongCommitSha);
      scm.getBranchCommit.mockResolvedValueOnce('base_sha' as LongCommitSha);
      return expect(
        syncBranchState('branch_name', 'new_base_branch'),
      ).resolves.toEqual({
        branchName: 'branch_name',
        sha: 'sha',
        baseBranch: 'new_base_branch',
        baseBranchSha: 'base_sha',
        pristine: false,
        upgrades: [],
        automerge: false,
        prNo: null,
      });
    });

    it('when base branch sha is different updates it and invalidates related values', () => {
      const repoCacheObj: RepoCacheData = {
        branches: [
          {
            branchName: 'branch_name',
            sha: 'sha',
            baseBranch: 'base_branch',
            baseBranchSha: 'base_sha',
            isBehindBase: true,
            pristine: false,
            upgrades: [],
            automerge: false,
            prNo: null,
          },
        ],
      };
      repoCache.getCache.mockReturnValue(repoCacheObj);
      scm.getBranchCommit.mockResolvedValueOnce('sha' as LongCommitSha);
      scm.getBranchCommit.mockResolvedValueOnce(
        'new_base_sha' as LongCommitSha,
      );
      return expect(
        syncBranchState('branch_name', 'base_branch'),
      ).resolves.toEqual({
        branchName: 'branch_name',
        sha: 'sha',
        baseBranch: 'base_branch',
        baseBranchSha: 'new_base_sha',
        upgrades: [],
        pristine: false,
        automerge: false,
        prNo: null,
      });
    });

    it('when branch sha is different updates it and invalidates related values', () => {
      const repoCacheObj: RepoCacheData = {
        branches: [
          {
            branchName: 'branch_name',
            sha: 'sha',
            baseBranch: 'base_branch',
            baseBranchSha: 'base_sha',
            isBehindBase: true,
            isModified: true,
            pristine: true,
            isConflicted: true,
            commitFingerprint: '123',
            upgrades: [],
            automerge: false,
            prNo: null,
          },
        ],
      };
      repoCache.getCache.mockReturnValue(repoCacheObj);
      scm.getBranchCommit.mockResolvedValueOnce('new_sha' as LongCommitSha);
      scm.getBranchCommit.mockResolvedValueOnce('base_sha' as LongCommitSha);
      return expect(
        syncBranchState('branch_name', 'base_branch'),
      ).resolves.toEqual({
        branchName: 'branch_name',
        sha: 'new_sha',
        baseBranch: 'base_branch',
        baseBranchSha: 'base_sha',
        upgrades: [],
        pristine: false,
        automerge: false,
        prNo: null,
      });
    });

    it('no change if all parameters are same', () => {
      const repoCacheObj: RepoCacheData = {
        branches: [
          {
            branchName: 'branch_name',
            sha: 'sha',
            baseBranch: 'base_branch',
            baseBranchSha: 'base_sha',
            isBehindBase: true,
            isModified: true,
            isConflicted: true,
            commitFingerprint: '123',
            upgrades: [],
            automerge: false,
            prNo: null,
            pristine: true,
          },
        ],
      };
      repoCache.getCache.mockReturnValue(repoCacheObj);
      scm.getBranchCommit.mockResolvedValueOnce('sha' as LongCommitSha);
      scm.getBranchCommit.mockResolvedValueOnce('base_sha' as LongCommitSha);
      return expect(
        syncBranchState('branch_name', 'base_branch'),
      ).resolves.toEqual({
        branchName: 'branch_name',
        sha: 'sha',
        baseBranch: 'base_branch',
        baseBranchSha: 'base_sha',
        isBehindBase: true,
        isModified: true,
        isConflicted: true,
        commitFingerprint: '123',
        upgrades: [],
        automerge: false,
        prNo: null,
        pristine: true,
      });
    });
  });
});
