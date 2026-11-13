import assert from 'node:assert/strict';
import { describeUpdateFailure, priorFailureForRelease } from './src/update-client.js';

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

console.log('UPDATE_OFFER_OK staleFailureHidden=true rejectionKeepsPaths=true');
