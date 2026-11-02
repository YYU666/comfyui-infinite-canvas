import React, { useRef } from 'react';
import { bindQwenPrompt, displayQwenPrompt } from './qwen-references';

export default function QwenReferenceEditor({ refs, prompt, disabled, onPrompt, onMove, onRemove }) {
  const input = useRef(null);
  const value = displayQwenPrompt(prompt, refs);
  const insert = (index) => {
    const field = input.current;
    const start = field?.selectionStart ?? value.length, end = field?.selectionEnd ?? start;
    const insertion = `图${index + 1} `;
    onPrompt(bindQwenPrompt(value.slice(0, start) + insertion + value.slice(end), refs));
    requestAnimationFrame(() => { field?.focus(); field?.setSelectionRange(start + insertion.length, start + insertion.length); });
  };
  return <div className="qwen-reference-editor nodrag nowheel">
    <div className="qwen-reference-heading"><b>参考图片</b><span>{refs.length} / 10 · 图1决定画幅</span></div>
    <div className="qwen-reference-list">
      {refs.map((node, index) => <div className="qwen-reference-item" key={node.id}>
        <button type="button" className="qwen-reference-thumb" disabled={disabled} onClick={() => insert(index)} aria-label={`插入图${index + 1}引用`} title={node.data.title}>
          {node.data.url ? <img src={node.data.url} alt="" draggable={false} /> : <span>图片</span>}<b>图{index + 1}</b>
        </button>
        <span className="qwen-reference-name" title={node.data.title}>{node.data.title}</span>
        <div className="qwen-reference-actions"><button disabled={disabled || index === 0} onClick={() => onMove(node.id, -1)} aria-label={`前移图${index + 1}`}>←</button><button disabled={disabled || index === refs.length - 1} onClick={() => onMove(node.id, 1)} aria-label={`后移图${index + 1}`}>→</button><button disabled={disabled} onClick={() => onRemove(node.id)} aria-label={`断开图${index + 1}`}>×</button></div>
      </div>)}
      {!refs.length && <p>把图片连到左侧「参考图片」接口，按提示词指定每张图的用途。</p>}
    </div>
    <textarea ref={input} aria-label="图片提示词" className="h3-prompt qwen-prompt nodrag nowheel" value={value} disabled={disabled} onChange={(event) => onPrompt(bindQwenPrompt(event.target.value, refs))} placeholder={'例如：保留图1的地形和路线，参考图2的场景氛围，使用图3的手绘笔触。\n点击缩略图插入编号；可自由说明每张图的用途。'} />
    {value.includes('【已断开的图片引用】') && <p className="generator-error" role="alert">有引用的图片已断开，请重新连接或删除对应引用。</p>}
    {value.includes('【无效的图片引用】') && <p className="generator-error" role="alert">图片引用格式无效，请删除后重新点击缩略图插入。</p>}
  </div>;
}
