import assert from 'node:assert/strict';
import { currentAttemptFailure, describeUpdateFailure, priorFailureForRelease } from './src/update-client.js';

const release = { updateAvailable: true, version: 'v1.0.15', currentVersion: '1.0.6-local.20261107' };
assert.equal(priorFailureForRelease({
  phase: 'idle',
  lastResult: { phase: 'error', version: 'v1.0.3', message: '工作台程序有本地代码修改。请先备份或提交修改，再升级。' },
}, release), null, 'an older failed apply does not hide a newer release');
assert.equal(priorFailureForRelease({
  phase: 'idle',
  lastResult: { phase: 'error', version: 'v1.0.15', message: '请先关闭项目。' },
}, release).message, '请先关闭项目。');
assert.equal(priorFailureForRelease({ phase: 'idle', lastResult: { phase: 'success', version: 'v1.0.15' } }, release), null);

const listed = describeUpdateFailure({
  message: '工作台程序有本地代码修改。请先备份或提交修改，再升级。',
  details: { kind: 'git', paths: ['src/App.jsx', 'src/UpdateCenter.jsx'], count: 2 },
});
assert.match(listed, /请先备份或提交修改/);
assert.match(listed, /src\/App\.jsx/);
assert.equal(describeUpdateFailure({
  message: '官方安装的程序文件与上次更新记录不一致，升级已停止，这些文件没有被覆盖：src/App.jsx。',
  details: { kind: 'installed-files', paths: ['src/App.jsx'], count: 1 },
}).includes('src/App.jsx'), true);

const startedAt = Date.parse('2026-11-13T14:30:00Z');
const rollback = { phase: 'error', version: 'v1.0.16', message: '新版启动失败，已恢复旧版。', updatedAt: '2026-11-13T14:30:10Z' };
assert.equal(currentAttemptFailure({ phase: 'idle', lastResult: rollback }, 'v1.0.16', startedAt), rollback);
assert.equal(currentAttemptFailure({ phase: 'idle', lastResult: { ...rollback, updatedAt: '2026-11-13T14:29:59Z' } }, 'v1.0.16', startedAt), null, 'a previous same-version failure cannot unlock a new attempt');
assert.equal(currentAttemptFailure({ phase: 'idle', lastResult: { ...rollback, version: 'v1.0.15' } }, 'v1.0.16', startedAt), null);
assert.equal(currentAttemptFailure({ phase: 'idle', lastResult: { ...rollback, updatedAt: undefined } }, 'v1.0.16', startedAt), null);
assert.equal(currentAttemptFailure({ phase: 'restarting', lastResult: rollback }, 'v1.0.16', startedAt), null);
assert.equal(currentAttemptFailure(rollback, 'v1.0.16', startedAt), rollback);
console.log('UPDATE_OFFER_OK staleFailureHidden=true rejectionKeepsPaths=true rollbackRecovered=true');
