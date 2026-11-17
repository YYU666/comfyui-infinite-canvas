import React from 'react';
import { nodeModelLicenses } from './model-licenses.js';

export default function ModelLicenseNotice({ data }) {
  const records = nodeModelLicenses(data);
  const restrictions = [...new Set(records.map(row => row.restriction).filter(Boolean))];
  return <details className="model-license-notice nodrag nowheel">
    <summary>本地模型 · 权重许可证{restrictions.length ? ' · 含地域限制' : ''}</summary>
    {restrictions.map(text => <p key={text}>{text}</p>)}
    {records.map(row => <div key={row.path}><small>{row.path.split('/').at(-1)}</small>{row.licenseUrl ? <a href={row.licenseUrl} target="_blank" rel="noreferrer">{row.license}</a> : <span>{row.license}</span>}{row.territoryLicenseUrl && row.territoryLicenseUrl !== row.licenseUrl && <a href={row.territoryLicenseUrl} target="_blank" rel="noreferrer"> · 组合使用的 H3 地域条款</a>}{row.restrictions && <p>{row.restrictions}</p>}</div>)}
    <small>工作台代码许可不替代权重许可；使用前请查阅原文。</small>
  </details>;
}
