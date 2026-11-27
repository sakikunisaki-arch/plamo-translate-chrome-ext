(() => {
  'use strict';

  if (window.__plamoTranslateLoaded) return;
  window.__plamoTranslateLoaded = true;

  const TARGET_BLOCK_TAGS = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'LI', 'TD', 'TH', 'BLOCKQUOTE', 'FIGCAPTION',
    'DT', 'DD', 'SUMMARY', 'CAPTION', 'LABEL'
  ]);

  const LEAF_CANDIDATE_TAGS = new Set(['DIV', 'SPAN', 'A']);

  const BLOCK_DESCENDANT_TAGS = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'LI', 'TD', 'TH', 'BLOCKQUOTE', 'FIGCAPTION',
    'DT', 'DD', 'SUMMARY', 'CAPTION', 'LABEL',
    'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER',
    'MAIN', 'ASIDE', 'NAV', 'UL', 'OL', 'DL',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR',
    'FIGURE', 'DETAILS', 'ADDRESS', 'FIELDSET', 'FORM',
    'PRE', 'HR'
  ]);

  const EXCLUDED_SUBTREE_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE',
    'CODE', 'PRE', 'KBD', 'SAMP', 'VAR',
    'SVG', 'MATH',
    'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'BUTTON',
    'CANVAS', 'IFRAME', 'VIDEO', 'AUDIO'
  ]);

  const INLINE_CODE_TAGS = new Set(['CODE', 'KBD', 'SAMP', 'VAR']);

  const MAX_CHUNK_CHARS = 2500;
  const HARD_SPLIT_CHARS = 2400;

  /**
   * 要素ごとの翻訳状態キャッシュ
   * Map<Element, { originalText: string, translatedText: string | null, originalNodes: Node[] | null, settingsKey: string }>
   */
  const elementStateMap = new Map();

  let currentRunId = 0;
  let currentStatus = 'idle'; // 'idle' | 'translating' | 'completed' | 'stopped' | 'error'
  let currentDisplayMode = 'bilingual'; // 'bilingual' | 'replace'
  let currentSettings = {};
  let completedCount = 0;
  let totalCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let lastError = null;
  let jobCounter = 0;

  // Floating mini-bar DOM references
  let floatingBarEl = null;
  let statusTextEl = null;
  let bilingualBtnEl = null;
  let replaceBtnEl = null;
  let restoreBtnEl = null;
  let stopBtnEl = null;

  function buildSettingsKey(settings) {
    const s = settings || {};
    return JSON.stringify({
      model: String(s.model || ''),
      targetLang: String(s.targetLang || 'ja'),
      form: s.form === 'plain' ? 'plain' : 'polite',
      glossaryText: String(s.glossaryText || '')
    });
  }

  function getStatusSnapshot() {
    const snapshot = {
      status: currentStatus,
      completed: completedCount,
      total: totalCount,
      skipped: skippedCount,
      failed: failedCount,
      displayMode: currentDisplayMode
    };
    if (lastError) {
      snapshot.error = lastError;
    }
    return snapshot;
  }

  function emitProgress() {
    const payload = {
      type: 'PAGE_PROGRESS',
      ...getStatusSnapshot()
    };
    try {
      const maybePromise = chrome.runtime.sendMessage(payload);
      if (maybePromise && typeof maybePromise.catch === 'function') {
        maybePromise.catch(() => {});
      }
    } catch {
      // Ignore runtime messaging failures when extension context is unavailable
    }
  }

  async function sendRuntimeMessage(payload) {
    try {
      const res = await chrome.runtime.sendMessage(payload);
      return res || { ok: false, error: '応答がありませんでした。' };
    } catch (err) {
      return {
        ok: false,
        error: err && err.message ? err.message : '拡張機能との通信に失敗しました。'
      };
    }
  }

  function isExcludedSubtree(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return true;
    if (EXCLUDED_SUBTREE_TAGS.has(el.tagName)) return true;
    if (el.hasAttribute('data-plamo-ui')) return true;
    if (el.getAttribute('translate') === 'no') return true;
    if (el.classList && el.classList.contains('notranslate')) return true;

    const ce = el.getAttribute('contenteditable');
    if (ce === '' || ce === 'true' || ce === 'plaintext-only') return true;

    if (el.hidden) return true;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.opacity === '0') return true;

    return false;
  }

  function isElementVisible(el) {
    const style = window.getComputedStyle(el);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      style.opacity === '0'
    ) {
      return false;
    }
    if (style.display === 'contents') {
      return true;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }
    return true;
  }

  function hasDescendantMatchingTags(root, tagSet) {
    const stack = Array.from(root.children);
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.hasAttribute('data-plamo-ui')) continue;
      if (tagSet.has(node.tagName)) {
        return true;
      }
      if (!EXCLUDED_SUBTREE_TAGS.has(node.tagName)) {
        for (let i = 0; i < node.children.length; i += 1) {
          stack.push(node.children[i]);
        }
      }
    }
    return false;
  }

  function hasDirectNonEmptyText(el) {
    for (let i = 0; i < el.childNodes.length; i += 1) {
      const child = el.childNodes[i];
      if (child.nodeType === Node.TEXT_NODE && child.nodeValue && child.nodeValue.trim().length > 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * 要素から翻訳用の正規化テキストを抽出する。
   * `[data-plamo-ui]` や除外要素のテキストは除外する。
   * また `CODE` 等のインラインコードのみで構成されるブロックを判定するため、非コード部分のテキストも返す。
   * @param {Element} el
   * @returns {{ fullText: string, proseText: string }}
   */
  function extractCleanText(el) {
    const fullParts = [];
    const proseParts = [];

    function walkText(node, inInlineCode) {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const val = node.nodeValue || '';
        if (val) {
          fullParts.push(val);
          if (!inInlineCode) {
            proseParts.push(val);
          }
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const tag = node.tagName;
      if (node.hasAttribute('data-plamo-ui')) return;
      if (
        tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' ||
        tag === 'TEMPLATE' || tag === 'PRE' || tag === 'SVG' || tag === 'MATH' ||
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION' ||
        tag === 'BUTTON' || tag === 'CANVAS' || tag === 'IFRAME' ||
        tag === 'VIDEO' || tag === 'AUDIO'
      ) {
        return;
      }
      if (tag === 'BR') {
        fullParts.push('\n');
        if (!inInlineCode) proseParts.push('\n');
        return;
      }

      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return;
      }

      const nextInInlineCode = inInlineCode || INLINE_CODE_TAGS.has(tag);
      for (let i = 0; i < node.childNodes.length; i += 1) {
        walkText(node.childNodes[i], nextInInlineCode);
      }
    }

    walkText(el, false);

    const normalize = (str) =>
      str
        .replace(/[ \t\r\f\v]+/g, ' ')
        .replace(/\n\s+/g, '\n')
        .replace(/\s+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return {
      fullText: normalize(fullParts.join('')),
      proseText: normalize(proseParts.join(''))
    };
  }

  /**
   * 言語判定: ASCII文字が2文字未満、または skipJapanese 有効時に日本語比率/文字数が基準以上ならスキップする。
   * @param {string} text
   * @param {boolean} skipJapanese
   * @returns {boolean} true の場合はスキップ
   */
  function shouldSkipText(text, skipJapanese) {
    if (!text) return true;
    const asciiMatches = text.match(/[A-Za-z]/g);
    const asciiCount = asciiMatches ? asciiMatches.length : 0;
    if (asciiCount < 2) {
      return true;
    }

    if (skipJapanese) {
      const nonWhitespace = text.replace(/\s+/g, '');
      const totalNonWs = nonWhitespace.length;
      if (totalNonWs === 0) return true;

      const jaMatches = nonWhitespace.match(/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/g);
      const jaCount = jaMatches ? jaMatches.length : 0;
      const jaRatio = jaCount / totalNonWs;

      if (jaRatio >= 0.25 || jaCount > asciiCount) {
        return true;
      }
    }

    return false;
  }

  /**
   * 翻訳対象候補の DOM 要素を走査して収集する。
   * @returns {Element[]}
   */
  function collectCandidateElements() {
    const candidates = [];
    const root = document.body || document.documentElement;
    if (!root) return candidates;

    function walk(el) {
      if (isExcludedSubtree(el)) return;

      // 既に翻訳済みの要素は中の [data-plamo-ui] 等へ降りず候補としてそのまま扱う
      if (el.getAttribute('data-plamo-translated') === 'true' && elementStateMap.has(el)) {
        candidates.push(el);
        return;
      }

      const tag = el.tagName;
      if (TARGET_BLOCK_TAGS.has(tag)) {
        if (hasDescendantMatchingTags(el, TARGET_BLOCK_TAGS)) {
          for (let i = 0; i < el.children.length; i += 1) {
            walk(el.children[i]);
          }
          return;
        }
        if (isElementVisible(el)) {
          candidates.push(el);
          return;
        }
        for (let i = 0; i < el.children.length; i += 1) {
          walk(el.children[i]);
        }
        return;
      }

      if (LEAF_CANDIDATE_TAGS.has(tag)) {
        if (
          hasDirectNonEmptyText(el) &&
          !hasDescendantMatchingTags(el, BLOCK_DESCENDANT_TAGS) &&
          isElementVisible(el)
        ) {
          candidates.push(el);
          return;
        }
      }

      for (let i = 0; i < el.children.length; i += 1) {
        walk(el.children[i]);
      }
    }

    walk(root);
    return candidates;
  }

  /**
   * ビューポート優先度で要素をソートする:
   * 1) 現在ビューポート内 (top < innerHeight && bottom > 0) -> 上から下
   * 2) ビューポートより下 (top >= innerHeight) -> 上から下
   * 3) ビューポートより上 (bottom <= 0) -> 下から上（ビューポートに近い順）
   * @param {Array<{ el: Element, rect: DOMRect }>} items
   */
  function sortByViewportPriority(items) {
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;

    function getBucket(rect) {
      if (rect.top < vh && rect.bottom > 0) return 0;
      if (rect.top >= vh) return 1;
      return 2;
    }

    items.sort((a, b) => {
      const bucketA = getBucket(a.rect);
      const bucketB = getBucket(b.rect);
      if (bucketA !== bucketB) {
        return bucketA - bucketB;
      }
      if (bucketA === 2) {
        // Above viewport: closest to viewport (largest bottom) first
        if (b.rect.bottom !== a.rect.bottom) {
          return b.rect.bottom - a.rect.bottom;
        }
        return a.rect.left - b.rect.left;
      }
      if (a.rect.top !== b.rect.top) {
        return a.rect.top - b.rect.top;
      }
      return a.rect.left - b.rect.left;
    });
  }

  /**
   * 長文テキストを 2500 文字以内のチャンクに分割する。
   * 各要素は `{ text, separator }` を持ち、翻訳後の結合時に改行/スペースを復元する。
   * @param {string} text
   * @returns {Array<{ text: string, joinWith: string }>}
   */
  function splitTextIntoChunks(text) {
    if (text.length <= MAX_CHUNK_CHARS) {
      return [{ text, joinWith: '' }];
    }

    const hardSplitPiece = (piece) => {
      const parts = [];
      let offset = 0;
      while (offset < piece.length) {
        if (piece.length - offset <= MAX_CHUNK_CHARS) {
          parts.push(piece.slice(offset));
          break;
        }
        let end = offset + HARD_SPLIT_CHARS;
        const slice = piece.slice(offset, end);
        const lastSpace = slice.lastIndexOf(' ');
        if (lastSpace > HARD_SPLIT_CHARS - 300) {
          end = offset + lastSpace;
        }
        parts.push(piece.slice(offset, end).trim());
        offset = end;
        while (offset < piece.length && piece[offset] === ' ') {
          offset += 1;
        }
      }
      return parts.filter(Boolean);
    };

    const chunks = [];
    const paragraphs = text.split(/\n+/);

    for (let pIdx = 0; pIdx < paragraphs.length; pIdx += 1) {
      const para = paragraphs[pIdx].trim();
      if (!para) continue;

      const paraPrefixJoin = chunks.length > 0 ? '\n' : '';
      const rawSentences = para.split(/(?<=[.!?])\s+/);
      const sentences = [];

      for (const s of rawSentences) {
        const trimmed = s.trim();
        if (!trimmed) continue;
        if (trimmed.length > MAX_CHUNK_CHARS) {
          sentences.push(...hardSplitPiece(trimmed));
        } else {
          sentences.push(trimmed);
        }
      }

      let currentChunk = '';
      let isFirstChunkInPara = true;

      for (const sentence of sentences) {
        const candidate = currentChunk ? `${currentChunk} ${sentence}` : sentence;
        if (candidate.length <= MAX_CHUNK_CHARS) {
          currentChunk = candidate;
        } else {
          if (currentChunk) {
            chunks.push({
              text: currentChunk,
              joinWith: isFirstChunkInPara ? paraPrefixJoin : ' '
            });
            isFirstChunkInPara = false;
          }
          currentChunk = sentence;
        }
      }

      if (currentChunk) {
        chunks.push({
          text: currentChunk,
          joinWith: isFirstChunkInPara ? paraPrefixJoin : ' '
        });
      }
    }

    return chunks.length > 0 ? chunks : [{ text: text.slice(0, HARD_SPLIT_CHARS), joinWith: '' }];
  }

  function removePlamoUiChildren(el) {
    const uiNodes = el.querySelectorAll('[data-plamo-ui="true"]');
    for (let i = 0; i < uiNodes.length; i += 1) {
      uiNodes[i].remove();
    }
  }

  function restoreOriginalNodesToElement(el, state) {
    removePlamoUiChildren(el);
    if (state && Array.isArray(state.originalNodes)) {
      for (let i = 0; i < state.originalNodes.length; i += 1) {
        const node = state.originalNodes[i];
        if (node && node.parentNode !== el) {
          el.appendChild(node);
        }
      }
      state.originalNodes = null;
    }
  }

  /**
   * 翻訳済みテキストを指定モードで DOM 要素に反映する。
   * @param {Element} el
   * @param {{ originalText: string, translatedText: string | null, originalNodes: Node[] | null, settingsKey: string }} state
   * @param {'bilingual' | 'replace'} mode
   */
  function applyTranslationToElement(el, state, mode) {
    if (!el || !el.isConnected || !state || !state.translatedText) return;

    if (mode === 'replace') {
      if (!Array.isArray(state.originalNodes)) {
        const saved = [];
        for (let i = 0; i < el.childNodes.length; i += 1) {
          const child = el.childNodes[i];
          if (child.nodeType === Node.ELEMENT_NODE && child.hasAttribute('data-plamo-ui')) {
            continue;
          }
          saved.push(child);
        }
        state.originalNodes = saved;
      }

      while (el.firstChild) {
        el.removeChild(el.firstChild);
      }

      const inlineSpan = document.createElement('span');
      inlineSpan.className = 'plamo-translation-inline';
      inlineSpan.setAttribute('data-plamo-ui', 'true');
      inlineSpan.textContent = state.translatedText;
      el.appendChild(inlineSpan);
      el.setAttribute('data-plamo-translated', 'true');
      return;
    }

    // bilingual mode
    restoreOriginalNodesToElement(el, state);

    const blockSpan = document.createElement('span');
    blockSpan.className = 'plamo-translation-block';
    blockSpan.setAttribute('data-plamo-ui', 'true');
    blockSpan.textContent = state.translatedText;
    el.appendChild(blockSpan);
    el.setAttribute('data-plamo-translated', 'true');
  }

  function restoreElement(el, state) {
    if (!el || !el.isConnected) return;
    restoreOriginalNodesToElement(el, state);
    el.removeAttribute('data-plamo-translated');
  }

  function ensureFloatingBar() {
    if (floatingBarEl && floatingBarEl.isConnected) {
      return floatingBarEl;
    }

    const bar = document.createElement('div');
    bar.className = 'plamo-floating-bar';
    bar.setAttribute('data-plamo-ui', 'true');
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'PLaMo ページ翻訳コントロール');

    const statusSpan = document.createElement('span');
    statusSpan.className = 'plamo-bar-status';
    statusSpan.setAttribute('data-plamo-ui', 'true');
    bar.appendChild(statusSpan);

    const actions = document.createElement('div');
    actions.className = 'plamo-bar-actions';
    actions.setAttribute('data-plamo-ui', 'true');

    const bilingualBtn = document.createElement('button');
    bilingualBtn.type = 'button';
    bilingualBtn.className = 'plamo-bar-btn';
    bilingualBtn.textContent = '併記';
    bilingualBtn.setAttribute('data-plamo-ui', 'true');
    bilingualBtn.addEventListener('click', () => {
      setDisplayMode('bilingual');
    });

    const replaceBtn = document.createElement('button');
    replaceBtn.type = 'button';
    replaceBtn.className = 'plamo-bar-btn';
    replaceBtn.textContent = '置換';
    replaceBtn.setAttribute('data-plamo-ui', 'true');
    replaceBtn.addEventListener('click', () => {
      setDisplayMode('replace');
    });

    const restoreBtn = document.createElement('button');
    restoreBtn.type = 'button';
    restoreBtn.className = 'plamo-bar-btn';
    restoreBtn.textContent = '原文に戻す';
    restoreBtn.setAttribute('data-plamo-ui', 'true');
    restoreBtn.addEventListener('click', () => {
      restoreAll();
    });

    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'plamo-bar-btn plamo-btn-danger';
    stopBtn.textContent = '中止';
    stopBtn.setAttribute('data-plamo-ui', 'true');
    stopBtn.addEventListener('click', () => {
      stopTranslation();
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'plamo-bar-close';
    closeBtn.textContent = '×';
    closeBtn.title = 'バーを閉じる（翻訳は保持されます）';
    closeBtn.setAttribute('aria-label', '閉じる');
    closeBtn.setAttribute('data-plamo-ui', 'true');
    closeBtn.addEventListener('click', () => {
      if (floatingBarEl) {
        floatingBarEl.classList.add('plamo-hidden');
      }
    });

    actions.appendChild(bilingualBtn);
    actions.appendChild(replaceBtn);
    actions.appendChild(restoreBtn);
    actions.appendChild(stopBtn);
    bar.appendChild(actions);
    bar.appendChild(closeBtn);

    const mountTarget = document.body || document.documentElement;
    if (mountTarget) {
      mountTarget.appendChild(bar);
    }

    floatingBarEl = bar;
    statusTextEl = statusSpan;
    bilingualBtnEl = bilingualBtn;
    replaceBtnEl = replaceBtn;
    restoreBtnEl = restoreBtn;
    stopBtnEl = stopBtn;

    return bar;
  }

  function showFloatingBar() {
    const bar = ensureFloatingBar();
    bar.classList.remove('plamo-hidden');
    updateFloatingBar();
  }

  function updateFloatingBar() {
    if (!floatingBarEl || !floatingBarEl.isConnected) return;

    statusTextEl.classList.remove('plamo-status-error');
    statusTextEl.title = '';

    if (currentStatus === 'translating') {
      statusTextEl.textContent = `PLaMo 翻訳中: ${completedCount} / ${totalCount}`;
    } else if (currentStatus === 'completed') {
      if (totalCount === 0) {
        statusTextEl.textContent = `PLaMo: 翻訳対象なし (スキップ ${skippedCount})`;
      } else if (failedCount > 0) {
        statusTextEl.textContent = `PLaMo 完了: ${completedCount} / ${totalCount} (失敗 ${failedCount})`;
      } else {
        statusTextEl.textContent = `PLaMo 完了: ${completedCount} / ${totalCount}`;
      }
    } else if (currentStatus === 'stopped') {
      statusTextEl.textContent = `PLaMo 中止: ${completedCount} / ${totalCount}`;
    } else if (currentStatus === 'error') {
      const errMsg = lastError || '翻訳に失敗しました';
      statusTextEl.textContent = `PLaMo エラー: ${errMsg}`;
      statusTextEl.title = errMsg;
      statusTextEl.classList.add('plamo-status-error');
    } else {
      statusTextEl.textContent = 'PLaMo: 原文表示';
    }

    bilingualBtnEl.classList.toggle('plamo-btn-active', currentDisplayMode === 'bilingual');
    replaceBtnEl.classList.toggle('plamo-btn-active', currentDisplayMode === 'replace');

    stopBtnEl.style.display = currentStatus === 'translating' ? '' : 'none';
    restoreBtnEl.disabled = currentStatus === 'idle';
  }

  async function translateBlockText(text, runId) {
    const chunks = splitTextIntoChunks(text);
    const translatedParts = [];

    for (let i = 0; i < chunks.length; i += 1) {
      if (runId !== currentRunId) {
        return { ok: false, aborted: true };
      }

      const chunk = chunks[i];
      jobCounter += 1;
      const jobId = `plamo-${runId}-${jobCounter}`;

      const res = await sendRuntimeMessage({
        type: 'TRANSLATE_TEXT',
        jobId,
        text: chunk.text
      });

      if (runId !== currentRunId) {
        return { ok: false, aborted: true };
      }

      if (!res || !res.ok) {
        return {
          ok: false,
          aborted: Boolean(res && res.aborted),
          error: (res && res.error) || '翻訳リクエストに失敗しました。'
        };
      }

      translatedParts.push((i === 0 ? '' : chunk.joinWith) + String(res.text || '').trim());
    }

    return { ok: true, text: translatedParts.join('') };
  }

  function startTranslation(displayMode, settings) {
    const wasTranslating = currentStatus === 'translating';
    currentRunId += 1;
    const myRunId = currentRunId;

    currentDisplayMode = displayMode === 'replace' ? 'replace' : 'bilingual';
    currentSettings = settings && typeof settings === 'object' ? { ...settings } : {};
    const skipJapanese = currentSettings.skipJapanese !== false;
    const settingsKey = buildSettingsKey(currentSettings);
    const concurrency = Math.min(4, Math.max(1, Number(currentSettings.concurrency) || 1));

    // 設定が変わっていた既翻訳要素は一旦復元して再翻訳対象にする
    for (const [el, state] of elementStateMap.entries()) {
      if (!el.isConnected) {
        elementStateMap.delete(el);
        continue;
      }
      if (el.getAttribute('data-plamo-translated') === 'true' && state.settingsKey !== settingsKey) {
        restoreElement(el, state);
      }
    }

    const candidates = collectCandidateElements();
    const pendingItems = [];
    let cachedApplied = 0;
    let skipped = 0;

    for (let i = 0; i < candidates.length; i += 1) {
      const el = candidates[i];
      const existing = elementStateMap.get(el);
      const isAlreadyApplied = el.getAttribute('data-plamo-translated') === 'true';

      if (existing && existing.translatedText && existing.settingsKey === settingsKey) {
        if (isAlreadyApplied) {
          applyTranslationToElement(el, existing, currentDisplayMode);
          cachedApplied += 1;
          continue;
        }
        const { fullText: currentText } = extractCleanText(el);
        if (currentText && currentText === existing.originalText) {
          applyTranslationToElement(el, existing, currentDisplayMode);
          cachedApplied += 1;
          continue;
        }
      }

      const { fullText, proseText } = extractCleanText(el);
      if (!fullText || shouldSkipText(proseText, skipJapanese)) {
        skipped += 1;
        continue;
      }

      pendingItems.push({
        el,
        text: fullText,
        rect: el.getBoundingClientRect()
      });
    }

    sortByViewportPriority(pendingItems);

    completedCount = cachedApplied;
    totalCount = cachedApplied + pendingItems.length;
    skippedCount = skipped;
    failedCount = 0;
    lastError = null;
    currentStatus = pendingItems.length > 0 ? 'translating' : 'completed';

    showFloatingBar();
    emitProgress();

    if (pendingItems.length === 0) {
      if (wasTranslating) {
        sendRuntimeMessage({ type: 'ABORT_TAB_TRANSLATION' });
      }
      return getStatusSnapshot();
    }

    // 非同期ワーカープールを開始
    (async () => {
      if (wasTranslating) {
        await sendRuntimeMessage({ type: 'ABORT_TAB_TRANSLATION' });
      }
      if (myRunId !== currentRunId) return;

      let nextIndex = 0;

      const worker = async () => {
        while (myRunId === currentRunId) {
          const idx = nextIndex;
          nextIndex += 1;
          if (idx >= pendingItems.length) return;

          const item = pendingItems[idx];
          if (!item.el.isConnected) {
            skippedCount += 1;
            totalCount = Math.max(0, totalCount - 1);
            updateFloatingBar();
            emitProgress();
            continue;
          }

          const result = await translateBlockText(item.text, myRunId);
          if (myRunId !== currentRunId) return;

          if (result.ok) {
            const state = {
              originalText: item.text,
              translatedText: result.text,
              originalNodes: null,
              settingsKey
            };
            elementStateMap.set(item.el, state);
            applyTranslationToElement(item.el, state, currentDisplayMode);
            completedCount += 1;
          } else if (result.aborted) {
            return;
          } else {
            failedCount += 1;
            if (result.error) {
              lastError = result.error;
            }
          }

          updateFloatingBar();
          emitProgress();
        }
      };

      const workers = [];
      const poolSize = Math.min(concurrency, pendingItems.length);
      for (let i = 0; i < poolSize; i += 1) {
        workers.push(worker());
      }
      await Promise.all(workers);

      if (myRunId !== currentRunId) return;

      if (completedCount === 0 && failedCount > 0) {
        currentStatus = 'error';
      } else {
        currentStatus = 'completed';
      }
      updateFloatingBar();
      emitProgress();
    })();

    return getStatusSnapshot();
  }

  function stopTranslation() {
    if (currentStatus === 'translating') {
      currentRunId += 1;
      currentStatus = 'stopped';
      sendRuntimeMessage({ type: 'ABORT_TAB_TRANSLATION' });
    } else if (currentStatus !== 'idle') {
      currentRunId += 1;
      currentStatus = 'stopped';
    }
    updateFloatingBar();
    emitProgress();
    return getStatusSnapshot();
  }

  function restoreAll() {
    if (currentStatus === 'translating') {
      currentRunId += 1;
      sendRuntimeMessage({ type: 'ABORT_TAB_TRANSLATION' });
    }

    for (const [el, state] of elementStateMap.entries()) {
      if (!el.isConnected) {
        elementStateMap.delete(el);
        continue;
      }
      restoreElement(el, state);
    }

    currentStatus = 'idle';
    completedCount = 0;
    totalCount = 0;
    skippedCount = 0;
    failedCount = 0;
    lastError = null;

    updateFloatingBar();
    emitProgress();
    return getStatusSnapshot();
  }

  function setDisplayMode(mode) {
    currentDisplayMode = mode === 'replace' ? 'replace' : 'bilingual';

    for (const [el, state] of elementStateMap.entries()) {
      if (!el.isConnected) {
        elementStateMap.delete(el);
        continue;
      }
      if (el.getAttribute('data-plamo-translated') === 'true' && state.translatedText) {
        applyTranslationToElement(el, state, currentDisplayMode);
      }
    }

    updateFloatingBar();
    emitProgress();
    return getStatusSnapshot();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;
    if (message.type !== 'CONTENT_PAGE_ACTION') return false;

    const action = message.action;

    if (action === 'START') {
      const snapshot = startTranslation(message.displayMode, message.settings);
      sendResponse({ ok: true, status: snapshot });
      return false;
    }

    if (action === 'STOP') {
      const snapshot = stopTranslation();
      sendResponse({ ok: true, status: snapshot });
      return false;
    }

    if (action === 'RESTORE') {
      const snapshot = restoreAll();
      sendResponse({ ok: true, status: snapshot });
      return false;
    }

    if (action === 'SET_MODE') {
      const snapshot = setDisplayMode(message.displayMode);
      sendResponse({ ok: true, status: snapshot });
      return false;
    }

    if (action === 'GET_STATUS') {
      sendResponse({
        ok: true,
        status: getStatusSnapshot(),
        pageTitle: document.title || '',
        pageUrl: window.location.href || ''
      });
      return false;
    }

    if (action === 'GET_SELECTION') {
      const text = window.getSelection ? window.getSelection().toString() : '';
      sendResponse({ ok: true, text: text || '' });
      return false;
    }

    sendResponse({ ok: false, error: `未知のアクション: ${String(action)}` });
    return false;
  });
})();
