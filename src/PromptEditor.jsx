import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Film, Image as ImageIcon, Music2, Plus, Search } from 'lucide-react';

const KIND_LABEL = { image: '图片', video: '视频', audio: '音频' };
const KIND_ICON = { image: ImageIcon, video: Film, audio: Music2 };

function MediaThumb({ node }) {
  const kind = node.data.kind || 'image';
  const Icon = KIND_ICON[kind] || Film;
  return <span className={`mention-thumb ${kind}`}>
    {node.data.url && kind === 'image' && <img src={node.data.url} alt="" draggable={false} />}
    {node.data.url && kind === 'video' && <video src={node.data.url} muted playsInline preload="metadata" />}
    {(!node.data.url || kind === 'audio') && <Icon size={13} />}
  </span>;
}

function createMentionChip(node) {
  const kind = node.data.kind || 'image';
  const chip = document.createElement('span');
  chip.className = `prompt-mention ${kind} nodrag`;
  chip.contentEditable = 'false';
  chip.dataset.nodeId = node.id;
  chip.dataset.mentionTitle = node.data.title;
  chip.title = `${KIND_LABEL[kind] || '素材'} · ${node.data.title}`;

  const thumb = document.createElement('span');
  thumb.className = `mention-thumb ${kind}`;
  if (node.data.url && kind === 'image') {
    const image = document.createElement('img');
    image.src = node.data.url;
    image.alt = '';
    image.draggable = false;
    thumb.append(image);
  } else if (node.data.url && kind === 'video') {
    const video = document.createElement('video');
    video.src = node.data.url;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    thumb.append(video);
  } else {
    thumb.textContent = kind === 'audio' ? '♪' : kind === 'video' ? '▶' : '▧';
  }

  const label = document.createElement('span');
  label.className = 'prompt-mention-name';
  label.textContent = node.data.title;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.tabIndex = -1;
  remove.className = 'prompt-mention-remove';
  remove.setAttribute('aria-label', `删除引用 ${node.data.title}`);
  remove.title = '删除引用';
  remove.textContent = '×';
  chip.append(thumb, label, remove);
  return chip;
}

function readPrompt(root) {
  let output = '';
  const visit = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      output += node.nodeValue.replace(/\u00a0/g, ' ');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.dataset?.mentionTitle) {
      output += `@${node.dataset.mentionTitle}`;
      return;
    }
    if (node.tagName === 'BR') {
      output += '\n';
      return;
    }
    const block = ['DIV', 'P'].includes(node.tagName);
    if (block && output && !output.endsWith('\n')) output += '\n';
    node.childNodes.forEach((child) => visit(child));
    if (block && !output.endsWith('\n')) output += '\n';
  };
  root.childNodes.forEach((node) => visit(node));
  return output.replace(/\n$/, '');
}

function appendPlainText(root, text) {
  text.split('\n').forEach((part, index, parts) => {
    if (part) root.append(document.createTextNode(part));
    if (index < parts.length - 1) root.append(document.createElement('br'));
  });
}

function renderPrompt(root, value, items) {
  root.textContent = '';
  const sorted = [...items].filter((node) => node.data.title).sort((a, b) => b.data.title.length - a.data.title.length);
  let plainStart = 0;
  let cursor = 0;
  while (cursor < value.length) {
    if (value[cursor] !== '@') { cursor += 1; continue; }
    const match = sorted.find((node) => value.startsWith(node.data.title, cursor + 1));
    if (!match) { cursor += 1; continue; }
    appendPlainText(root, value.slice(plainStart, cursor));
    root.append(createMentionChip(match));
    cursor += match.data.title.length + 1;
    plainStart = cursor;
  }
  appendPlainText(root, value.slice(plainStart));
}

const PromptEditor = forwardRef(function PromptEditor({ value, onChange, items, disabled, placeholder }, ref) {
  const editorRef = useRef(null);
  const savedMentionRange = useRef(null);
  const blurTimer = useRef(null);
  const composingRef = useRef(false);
  const onChangeRef = useRef(onChange);
  const itemsRef = useRef(items);
  const [mention, setMention] = useState({ open: false, query: '' });
  const [empty, setEmpty] = useState(!value);
  onChangeRef.current = onChange;
  itemsRef.current = items;
  const itemSignature = items.map((node) => `${node.id}:${node.data.title}:${node.data.kind}:${node.data.url}`).join('|');
  const filteredItems = items.filter((node) => node.data.title?.toLowerCase().includes(mention.query.toLowerCase()));
  const closeMention = () => setMention((old) => old.open || old.query ? { open: false, query: '' } : old);

  const emitChange = () => {
    const next = readPrompt(editorRef.current);
    setEmpty(!next);
    onChangeRef.current(next);
  };

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || composingRef.current) return;
    if (readPrompt(editor) !== value) renderPrompt(editor, value, itemsRef.current);
    else {
      editor.querySelectorAll('.prompt-mention').forEach((chip) => {
        const item = itemsRef.current.find((node) => node.id === chip.dataset.nodeId);
        if (!item) return;
        const current = `${item.data.title}:${item.data.kind}:${item.data.url}`;
        if (chip.dataset.mediaSignature !== current) {
          const replacement = createMentionChip(item);
          replacement.dataset.mediaSignature = current;
          chip.replaceWith(replacement);
        }
      });
    }
    editor.querySelectorAll('.prompt-mention').forEach((chip) => {
      const item = itemsRef.current.find((node) => node.id === chip.dataset.nodeId);
      if (item) chip.dataset.mediaSignature = `${item.data.title}:${item.data.kind}:${item.data.url}`;
    });
    setEmpty(!value);
  }, [value, itemSignature]);

  const updateMention = () => {
    if (composingRef.current) return;
    const selection = window.getSelection();
    const editor = editorRef.current;
    if (!selection?.rangeCount || !selection.isCollapsed || !editor?.contains(selection.anchorNode)) {
      closeMention();
      return;
    }
    const range = selection.getRangeAt(0);
    if (range.startContainer.nodeType !== Node.TEXT_NODE) {
      closeMention();
      return;
    }
    const before = range.startContainer.nodeValue.slice(0, range.startOffset);
    const match = before.match(/@([^\s@]*)$/);
    if (!match) {
      closeMention();
      return;
    }
    const mentionRange = range.cloneRange();
    mentionRange.setStart(range.startContainer, range.startOffset - match[0].length);
    savedMentionRange.current = mentionRange;
    setMention((old) => old.open && old.query === match[1] ? old : { open: true, query: match[1] });
  };

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return undefined;
    const compositionStart = () => { composingRef.current = true; closeMention(); };
    const compositionEnd = () => {
      composingRef.current = false;
      emitChange();
      updateMention();
    };
    editor.addEventListener('compositionstart', compositionStart);
    editor.addEventListener('compositionend', compositionEnd);
    return () => {
      editor.removeEventListener('compositionstart', compositionStart);
      editor.removeEventListener('compositionend', compositionEnd);
    };
  }, []);

  const insertReference = (node) => {
    const editor = editorRef.current;
    if (!editor || disabled || !node?.data.title) return;
    let range = mention.open ? savedMentionRange.current : null;
    const selection = window.getSelection();
    if (!range && selection?.rangeCount && editor.contains(selection.anchorNode)) range = selection.getRangeAt(0).cloneRange();
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    range.deleteContents();
    const spacer = document.createTextNode('\u00a0');
    const fragment = document.createDocumentFragment();
    fragment.append(createMentionChip(node), spacer);
    range.insertNode(fragment);
    range.setStart(spacer, 1);
    range.collapse(true);
    editor.focus();
    selection.removeAllRanges();
    selection.addRange(range);
    savedMentionRange.current = null;
    setMention({ open: false, query: '' });
    emitChange();
  };

  useImperativeHandle(ref, () => ({
    insertReference,
    focus: () => editorRef.current?.focus(),
  }));

  const clickEditor = (event) => {
    const remove = event.target.closest('.prompt-mention-remove');
    if (remove) {
      event.preventDefault();
      remove.closest('.prompt-mention')?.remove();
      emitChange();
      editorRef.current?.focus();
      return;
    }
    updateMention();
  };

  return <div className="prompt-editor-wrap">
    <div
      ref={editorRef}
      className={`h3-prompt rich-prompt nodrag nowheel ${empty ? 'is-empty' : ''}`}
      contentEditable={!disabled}
      suppressContentEditableWarning
      role="textbox"
      aria-label="视频提示词"
      aria-multiline="true"
      aria-disabled={disabled}
      data-placeholder={placeholder}
      spellCheck={false}
      onInput={(event) => {
        if (event.nativeEvent.isComposing) return;
        composingRef.current = false;
        emitChange();
        updateMention();
      }}
      onKeyUp={updateMention}
      onSelect={updateMention}
      onClick={clickEditor}
      onMouseDown={(event) => { if (event.target.closest('.prompt-mention-remove')) event.preventDefault(); }}
      onKeyDown={(event) => { if (event.key === 'Escape' && !composingRef.current) closeMention(); }}
      onPaste={(event) => {
        event.preventDefault();
        document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
      }}
      onBlur={() => {
        clearTimeout(blurTimer.current);
        blurTimer.current = setTimeout(() => setMention((old) => ({ ...old, open: false })), 180);
      }}
    />
    {mention.open && <div className="mention-menu">
      <div className="mention-heading"><Search size={12} />引用画布素材 <span>@ 检索</span></div>
      {filteredItems.map((node) => <button key={node.id} onMouseDown={(event) => event.preventDefault()} onClick={() => insertReference(node)}>
        <MediaThumb node={node} /><span>{node.data.title}<small>{KIND_LABEL[node.data.kind] || '视频'} · 点击引用</small></span><Plus size={13} />
      </button>)}
      {!filteredItems.length && <p>没有找到同名素材，可以先上传或添加节点。</p>}
    </div>}
  </div>;
});

export default PromptEditor;
