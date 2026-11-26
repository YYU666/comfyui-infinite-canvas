"""CPU-only fixed-recipe parity and compatibility checks."""
import json
from pathlib import Path
import subprocess
import unittest
from native3d_jobs import validate_parameters, SCHEMAS
from native3d_presets import AI_LOWPOLY_PRESET, AI_LOWPOLY_DEFAULTS

class FixedPresetTests(unittest.TestCase):
    def test_backend_defaults_and_explicit_custom(self):
        self.assertEqual(validate_parameters('ai_lowpoly', {}), AI_LOWPOLY_DEFAULTS)
        self.assertEqual(validate_parameters('ai_lowpoly', AI_LOWPOLY_DEFAULTS), AI_LOWPOLY_DEFAULTS)
        custom = dict(conditioningProfile='canonical_safe', inputSeed=42, seed=19, sampling=True)
        self.assertEqual(validate_parameters('ai_lowpoly', custom), custom)
        self.assertEqual(json.loads(json.dumps(custom)), custom)

    def test_frontend_parity_new_serialization_and_old_nodes(self):
        script = """
import assert from 'node:assert/strict';
import {AI_LOWPOLY_PRESET,NATIVE3D_PRESETS,nativeParameters,nativeLowpolyPresetLabel} from './src/native3d.js';
const expected=JSON.parse(process.argv[1]), properties=JSON.parse(process.argv[2]);
assert.deepEqual(AI_LOWPOLY_PRESET,expected);
const adapter={operation:'ai_lowpoly',parameters:{properties}};
const a={...NATIVE3D_PRESETS.model_lowpoly[1]}, b={...NATIVE3D_PRESETS.model_lowpoly[1]};
assert.notEqual(a.nativeParameters,b.nativeParameters);
assert.deepEqual(JSON.parse(JSON.stringify(a)).nativeParameters,expected.parameters);
assert.deepEqual(nativeParameters(adapter,a.nativeParameters),expected.parameters);
assert.equal(nativeLowpolyPresetLabel(a),expected.label);
a.nativeParameters.inputSeed=9;
assert.equal(b.nativeParameters.inputSeed,0);
assert.deepEqual(nativeParameters(adapter,{}),{conditioningProfile:'canonical_safe',inputSeed:42,seed:0,sampling:false});
const custom={conditioningProfile:'canonical_safe',inputSeed:23,seed:17,sampling:true};
assert.deepEqual(nativeParameters(adapter,JSON.parse(JSON.stringify(custom))),custom);
"""
        subprocess.run(['node', '--input-type=module', '-e', script,
                        json.dumps(AI_LOWPOLY_PRESET), json.dumps(SCHEMAS['ai_lowpoly'])],
                       cwd=Path(__file__).parent, check=True, capture_output=True, text=True)

if __name__ == '__main__':
    unittest.main()
