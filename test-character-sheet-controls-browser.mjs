import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from './test-browser.mjs';

// A component-only fixture: no canvas, project store or production API access.
const html = `<!doctype html><html><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;
window.__vite_plugin_react_preamble_installed__=true;
import React from 'react';
import {createRoot} from 'react-dom/client';
import Controls from '/src/CharacterSheetControls.jsx';
function Fixture(){const [data,setData]=React.useState({});return React.createElement(React.Fragment,null,
React.createElement(Controls,{data,disabled:false,onChange:patch=>setData(old=>({...old,...patch}))}),
React.createElement('pre',{id:'state'},JSON.stringify(data)));}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));
</script></body></html>`;
const server = await createServer({ configFile: false, plugins: [react(), {
  name: 'isolated-sheet-controls', configureServer(vite) {
    vite.middlewares.use('/__sheet_controls', async (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(await vite.transformIndexHtml('/__sheet_controls', html));
    });
  } }], server: {host:'127.0.0.1',port:0}, optimizeDeps: {include:['react','react-dom/client']} });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({headless:true});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__sheet_controls`);
  await page.getByLabel('角色比例预设').selectOption('heroic_nine_head');
  await page.getByLabel('角色头身比').fill('9');
  await page.getByLabel('腿部比例',{exact:true}).fill('修长，关节自然');
  await page.getByLabel('角色生成阶段').selectOption('front_portrait');
  assert.equal(await page.getByLabel('角色比例预设').count(),0);
  assert.equal(await page.getByLabel('腿部比例',{exact:true}).count(),0);
  await page.getByLabel('头像身份 / 风格要求',{exact:true}).fill('保持原脸和肤色');
  await page.getByLabel('角色生成阶段').selectOption('front_body');
  assert.equal(await page.getByLabel('头像身份 / 风格要求',{exact:true}).count(),0);
  assert.equal(await page.getByLabel('角色头身比').inputValue(),'9');
  assert.equal(await page.getByLabel('腿部比例',{exact:true}).inputValue(),'修长，关节自然');
  await page.getByLabel('角色头身比').fill('');
  const state=JSON.parse(await page.locator('#state').innerText());
  assert.equal(state.characterSheetHeadRatio,'auto');
  assert.equal(state.characterSheetPortraitBrief,'保持原脸和肤色');
  assert.deepEqual(errors,[]);
  console.log('CHARACTER_SHEET_CONTROLS_BROWSER_OK stage visibility, typed values, retained settings; isolated fixture only');
} finally {
  await browser?.close();
  await server.close();
}
