import assert from 'node:assert/strict';
import {lodIssueTargets,lodBlockerLabel,validateLodIssueSummary} from './src/native3d-lod-issues.js';
const stage={stage:'lod3',status:'blocked',eligibleForDownstream:false,diagnosticFilename:'blocked_lod3.glb',diagnosticFileSha256:'a'.repeat(64),mesh_hash:'b'.repeat(64)};
const targets=lodIssueTargets({nativeJobId:'n3d_'+'1'.repeat(32),metadata:{geometry:{stages:[stage]}}});assert.equal(targets.length,1);
assert.equal(lodIssueTargets({nativeJobId:'bad',metadata:{geometry:{stages:[stage]}}}).length,0);
assert.match(lodBlockerLabel('Boundary distance upper bound could not be certified within budget'),/认证未完成/);
assert.throws(()=>validateLodIssueSummary({...targets[0],meshHash:'c'.repeat(64),items:[]},targets[0]));
assert.equal(validateLodIssueSummary({...targets[0],items:[]},targets[0]).stage,'lod3');
console.log('LOD_ISSUES_IDENTITY_OK');
