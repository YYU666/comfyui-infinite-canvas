import { readFile } from 'node:fs/promises';
import { buildReferenceWorkflow, buildWorkflow } from '../src/workbench-api.js';

const fixtureUrl = new URL('../fixtures/video-workflow-contract.json', import.meta.url);
const cases = JSON.parse(await readFile(fixtureUrl, 'utf8'));
const graphs = cases.map((testCase) => ({
  name: testCase.name,
  graph: testCase.mode === 'reference'
    ? buildReferenceWorkflow({ ...testCase.options, references: testCase.references })
    : buildWorkflow(testCase.options),
}));
process.stdout.write(JSON.stringify(graphs));
