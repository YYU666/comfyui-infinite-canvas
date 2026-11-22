/** Reference-derived MikkTSpace corner frames from the installed Three.js dependency.
 * Input UVs use raw glTF convention. Negating w exactly once matches glTF.
 * JSON stdin/stdout keeps subprocess invocation independent of shell quoting.
 */
import { generateTangents } from '../node_modules/three/examples/jsm/libs/mikktspace.module.js';
let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const data = JSON.parse(input);
  const positions = new Float32Array(data.positions);
  const normals = new Float32Array(data.normals);
  const uv = new Float32Array(data.uv);
  if (!positions.length || positions.length % 9 || normals.length !== positions.length || uv.length !== positions.length / 3 * 2 ||
      ![positions, normals, uv].every(a => a.every(Number.isFinite))) {
    throw new Error('MikkTSpace requires finite unindexed triangle position, normal and UV arrays');
  }
  const tangents = generateTangents(positions, normals, uv);
  for (let i = 3; i < tangents.length; i += 4) tangents[i] *= -1;
  if (!tangents.every(Number.isFinite)) throw new Error('MikkTSpace returned nonfinite tangents');
  process.stdout.write(JSON.stringify({ tangents: Array.from(tangents) }));
} catch (error) {
  console.error(`Native MikkTSpace failed: ${error.message}`);
  process.exitCode = 1;
}
