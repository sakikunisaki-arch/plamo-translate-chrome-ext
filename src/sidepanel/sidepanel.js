import { DEFAULT_SETTINGS, PORT_NAME, normalizeBaseUrl } from '../shared/constants.js';
import {
  addHistoryItem,
  clearHistory,
  getHistory,
  getSettings,
  saveSettings
} from '../shared/storage.js';

const CUSTOM_MODEL_VALUE = '__custom__';

const els = {
  // Header
  headerModelLabel: document.getElementById('headerModelLabel'),
  connectionPill: document.getElementById('connectionPill'),
  connectionPillText: document.getElementById('connectionPillText'),
  refreshConnectionBtn: document.getElementById('refreshConnectionBtn'),

  // Tabs
  tabButtons: Array.from(document.querySelectorAll('.tab-btn')),
  panels: {
    text: document.getElementById('panelText'),
    page: document.getElementById('panelPage'),
    settings: document.getElementById('panelSettings')
  },

  // Tab 1: Text Translation
  sourceTextarea: document.getElementById('sourceTextarea'),
  getSelectionBtn: document.getElementById('getSelectionBtn'),
  clearTextBtn: document.getElementById('clearTextBtn'),
  textFormSelect: document.getElementById('textFormSelect'),
  translateBtn: document.getElementById('translateBtn'),
  elapsedBadge: document.getElementById('elapsedBadge'),
  copyOutputBtn: document.getElementById('copyOutputBtn'),
  textErrorBanner: document.getElementById('textErrorBanner'),
  translationOutput: document.getElementById('translationOutput'),
  clearHistoryBtn: document.getElementById('clearHistoryBtn'),
  historyList: document.getElementById('historyList'),

  // Tab 2: Page Translation
  activeTabTitle: document.getElementById('activeTabTitle'),
  activeTabHost: document.getElementById('activeTabHost'),
  modeBilingualRadio: document.getElementById('modeBilingualRadio'),
  modeReplaceRadio: document.getElementById('modeReplaceRadio'),
  pageStartBtn: document.getElementById('pageStartBtn'),
  pageStopBtn: document.getElementById('pageStopBtn'),
  pageRestoreBtn: document.getElementById('pageRestoreBtn'),
  pageStatusBadge: document.getElementById('pageStatusBadge'),
  pageProgressTrack: document.getElementById('pageProgressTrack'),
  pageProgressBar: document.getElementById('pageProgressBar'),
  pageCountProgress: document.getElementById('pageCountProgress'),
  pageCountSkipped: document.getElementById('pageCountSkipped'),
  pageCountFailed: document.getElementById('pageCountFailed'),
  pageErrorBox: document.getElementById('pageErrorBox'),

  // Tab 3: Settings
  settingsForm: document.getElementById('settingsForm'),
  settingBaseUrl: document.getElementById('settingBaseUrl'),
  settingModelSelect: document.getElementById('settingModelSelect'),
  settingModelInput: document.getElementById('settingModelInput'),
  testConnectionBtn: document.getElementById('testConnectionBtn'),
  connectionTestResult: document.getElementById('connectionTestResult'),
  settingForm: document.getElementById('settingForm'),
  settingConcurrency: document.getElementById('settingConcurrency'),
  settingDisplayMode: document.getElementById('settingDisplayMode'),
  settingTemperature: document.getElementById('settingTemperature'),
  settingSkipJapanese: document.getElementById('settingSkipJapanese'),
  settingGlossary: document.getElementById('settingGlossary'),
  settingsSavedBanner: document.getElementById('settingsSavedBanner'),
  saveSettingsBtn: document.getElementById('saveSettingsBtn')
};

const state = {
  currentSettings: { ...DEFAULT_SETTINGS },
  loadedModels: [],
  streamPort: null,
  activeRequestId: null,
  activeRequestSource: '',
  activeRequestForm: 'polite',
  cancelledRequestIds: new Set(),
  currentTranslation: '',
  activeTabId: null,
  copyFeedbackTimer: null,
  savedBannerTimer: null
};

/* =========================================================
 * タブ切り替え
 * ======================================================= */
function switchTab(tabKey) {
  for (const btn of els.tabButtons) {
    const isActive = btn.dataset.tab === tabKey;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  }
  for (const [key, panel] of Object.entries(els.panels)) {
    const isActive = key === tabKey;
    panel.classList.toggle('active', isActive);
    panel.classList.toggle('hidden', !isActive);
  }
}

/* =========================================================
 * ヘッダー接続ステータス & モデル一覧取得
 * ======================================================= */
function renderConnectionPill({ ok, hasTargetModel, checking = false }) {
  els.connectionPill.classList.remove('status-ready', 'status-partial', 'status-disconnected');
  if (checking) {
    els.connectionPillText.textContent = '確認中...';
    return;
  }
  if (ok && hasTargetModel) {
    els.connectionPill.classList.add('status-ready');
    els.connectionPillText.textContent = '接続済み';
  } else if (ok) {
    els.connectionPill.classList.add('status-partial');
    els.connectionPillText.textContent = 'モデル未ロード';
  } else {
    els.connectionPill.classList.add('status-disconnected');
    els.connectionPillText.textContent = '未接続';
  }
}

async function checkConnection({ baseUrl, model } = {}) {
  els.refreshConnectionBtn.classList.add('spinning');
  els.refreshConnectionBtn.disabled = true;
  renderConnectionPill({ ok: false, hasTargetModel: false, checking: true });

  const targetUrl = normalizeBaseUrl(baseUrl || state.currentSettings.baseUrl);
  const targetModel = String(model || state.currentSettings.model || DEFAULT_SETTINGS.model).trim();

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'CHECK_CONNECTION',
      baseUrl: targetUrl,
      model: targetModel
    });
    const ok = Boolean(res?.ok);
    const models = Array.isArray(res?.models) ? res.models : [];
    const hasTargetModel = Boolean(res?.hasTargetModel);

    state.loadedModels = models;
    populateModelSelect(models, els.settingModelInput.value.trim() || targetModel);
    renderConnectionPill({ ok, hasTargetModel });

    return {
      ok,
      models,
      hasTargetModel,
      error: res?.error || '',
      targetModel,
      baseUrl: targetUrl
    };
  } catch (err) {
    renderConnectionPill({ ok: false, hasTargetModel: false });
    return {
      ok: false,
      models: [],
      hasTargetModel: false,
      error: err instanceof Error ? err.message : '接続状態の確認に失敗しました。',
      targetModel,
      baseUrl: targetUrl
    };
  } finally {
    els.refreshConnectionBtn.classList.remove('spinning');
    els.refreshConnectionBtn.disabled = false;
  }
}

/* =========================================================
 * Tab 1: テキスト翻訳 & ストリーミングポート
 * ======================================================= */
function ensureStreamPort() {
  if (state.streamPort) {
    return state.streamPort;
  }
  const port = chrome.runtime.connect({ name: PORT_NAME });
  port.onMessage.addListener(handlePortMessage);
  port.onDisconnect.addListener(() => {
    if (state.streamPort === port) {
      state.streamPort = null;
    }
    if (state.activeRequestId) {
      const lostId = state.activeRequestId;
      state.activeRequestId = null;
      setStreamingUI(false);
      if (!state.cancelledRequestIds.has(lostId)) {
        showTextError('バックグラウンドとの接続が切断されました。もう一度お試しください。');
      }
    }
  });
  state.streamPort = port;
  return port;
}

function setStreamingUI(isStreaming) {
  els.translateBtn.classList.toggle('is-streaming', isStreaming);
  els.translateBtn.textContent = isStreaming ? '中止' : '翻訳する';
  els.translationOutput.classList.toggle('streaming', isStreaming);
}

function showTextError(message) {
  if (!message) {
    els.textErrorBanner.textContent = '';
    els.textErrorBanner.classList.add('hidden');
    return;
  }
  els.textErrorBanner.textContent = message;
  els.textErrorBanner.classList.remove('hidden');
}

function setOutputText(text, { isPlaceholder = false } = {}) {
  state.currentTranslation = isPlaceholder ? '' : text;
  els.translationOutput.classList.toggle('empty', isPlaceholder || !text);
  els.translationOutput.textContent = text || (isPlaceholder ? 'ここに翻訳結果が表示されます。' : '');
  els.copyOutputBtn.disabled = !state.currentTranslation;
}

function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  return `${(ms / 1000).toFixed(1)}秒`;
}

async function handlePortMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { type, requestId } = msg;
  if (!requestId) return;

  if (type === 'STREAM_DONE' || type === 'STREAM_ERROR') {
    if (requestId !== state.activeRequestId) {
      state.cancelledRequestIds.delete(requestId);
      return;
    }
  } else if (requestId !== state.activeRequestId) {
    return;
  }

  if (type === 'STREAM_CHUNK') {
    const delta = typeof msg.delta === 'string' ? msg.delta : '';
    if (!delta) return;
    if (els.translationOutput.classList.contains('empty')) {
      setOutputText(delta);
    } else {
      setOutputText(state.currentTranslation + delta);
    }
    els.translationOutput.scrollTop = els.translationOutput.scrollHeight;
    return;
  }

  if (type === 'STREAM_DONE') {
    const finalText = typeof msg.text === 'string' ? msg.text : state.currentTranslation;
    const sourceText = state.activeRequestSource;
    const usedForm = state.activeRequestForm;
    state.activeRequestId = null;
    setStreamingUI(false);

    setOutputText(finalText, { isPlaceholder: !finalText });
    if (typeof msg.elapsedMs === 'number') {
      els.elapsedBadge.textContent = formatElapsed(msg.elapsedMs);
      els.elapsedBadge.classList.remove('hidden');
    }

    if (sourceText && finalText) {
      await addHistoryItem({
        source: sourceText,
        translation: finalText,
        form: usedForm
      });
      await renderHistory();
    }
    return;
  }

  if (type === 'STREAM_ERROR') {
    const wasCancelled = state.cancelledRequestIds.has(requestId);
    state.cancelledRequestIds.delete(requestId);
    state.activeRequestId = null;
    setStreamingUI(false);

    if (!wasCancelled) {
      showTextError(msg.error || '翻訳中にエラーが発生しました。');
      if (!state.currentTranslation) {
        setOutputText('', { isPlaceholder: true });
      }
    }
  }
}

function cancelActiveStream() {
  if (!state.activeRequestId) return;
  const reqId = state.activeRequestId;
  state.cancelledRequestIds.add(reqId);
  try {
    const port = ensureStreamPort();
    port.postMessage({ type: 'CANCEL_STREAM', requestId: reqId });
  } catch {
    // ignore
  }
  state.activeRequestId = null;
  setStreamingUI(false);
  if (!state.currentTranslation) {
    setOutputText('', { isPlaceholder: true });
  }
}

function startTextTranslation() {
  if (state.activeRequestId) {
    cancelActiveStream();
    return;
  }

  const text = els.sourceTextarea.value.trim();
  if (!text) {
    showTextError('翻訳するテキストを入力してください。');
    els.sourceTextarea.focus();
    return;
  }

  showTextError('');
  els.elapsedBadge.textContent = '';
  els.elapsedBadge.classList.add('hidden');
  setOutputText('', { isPlaceholder: false });
  els.translationOutput.textContent = '';
  els.translationOutput.classList.remove('empty');

  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const form = els.textFormSelect.value === 'plain' ? 'plain' : 'polite';

  state.activeRequestId = requestId;
  state.activeRequestSource = text;
  state.activeRequestForm = form;
  setStreamingUI(true);

  try {
    const port = ensureStreamPort();
    port.postMessage({
      type: 'TRANSLATE_STREAM',
      requestId,
      text,
      overrides: { form }
    });
  } catch (err) {
    state.activeRequestId = null;
    setStreamingUI(false);
    showTextError(
      err instanceof Error ? err.message : 'ストリーミング接続を開始できませんでした。'
    );
  }
}

async function fetchSelectionFromActiveTab() {
  showTextError('');
  els.getSelectionBtn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'PAGE_ACTION',
      action: 'GET_SELECTION'
    });
    if (!res?.ok) {
      showTextError(res?.error || 'ページから選択テキストを取得できませんでした。');
      return;
    }
    const selected = String(res.text || '').trim();
    if (!selected) {
      showTextError('ページ上でテキストが選択されていません。');
      return;
    }
    els.sourceTextarea.value = selected;
    els.sourceTextarea.focus();
  } catch (err) {
    showTextError(err instanceof Error ? err.message : '選択テキストの取得に失敗しました。');
  } finally {
    els.getSelectionBtn.disabled = false;
  }
}

function clearTextEditor() {
  if (state.activeRequestId) {
    cancelActiveStream();
  }
  els.sourceTextarea.value = '';
  showTextError('');
  els.elapsedBadge.textContent = '';
  els.elapsedBadge.classList.add('hidden');
  setOutputText('', { isPlaceholder: true });
  els.sourceTextarea.focus();
}

async function copyTranslationOutput() {
  if (!state.currentTranslation) return;
  try {
    await navigator.clipboard.writeText(state.currentTranslation);
    els.copyOutputBtn.textContent = 'コピーしました';
    if (state.copyFeedbackTimer) {
      clearTimeout(state.copyFeedbackTimer);
    }
    state.copyFeedbackTimer = setTimeout(() => {
      els.copyOutputBtn.textContent = 'コピー';
      state.copyFeedbackTimer = null;
    }, 1600);
  } catch {
    showTextError('クリップボードへのコピーに失敗しました。');
  }
}

function formatHistoryTimestamp(ts) {
  if (!Number.isFinite(ts)) return '';
  try {
    return new Date(ts).toLocaleString('ja-JP', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return '';
  }
}

async function renderHistory() {
  const items = await getHistory();
  els.historyList.textContent = '';

  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-note';
    empty.textContent = '翻訳履歴はまだありません。';
    els.historyList.appendChild(empty);
    els.clearHistoryBtn.disabled = true;
    return;
  }

  els.clearHistoryBtn.disabled = false;
  for (const item of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'history-item';

    const topRow = document.createElement('div');
    topRow.className = 'history-item-top';

    const formTag = document.createElement('span');
    formTag.className = 'history-form-tag';
    formTag.textContent = item.form === 'plain' ? '常体' : '敬体';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'history-time';
    timeSpan.textContent = formatHistoryTimestamp(item.timestamp);

    topRow.appendChild(formTag);
    topRow.appendChild(timeSpan);

    const srcDiv = document.createElement('div');
    srcDiv.className = 'history-source';
    srcDiv.textContent = item.source;

    const trDiv = document.createElement('div');
    trDiv.className = 'history-translation';
    trDiv.textContent = item.translation;

    btn.appendChild(topRow);
    btn.appendChild(srcDiv);
    btn.appendChild(trDiv);

    btn.addEventListener('click', () => {
      if (state.activeRequestId) {
        cancelActiveStream();
      }
      showTextError('');
      els.elapsedBadge.textContent = '';
      els.elapsedBadge.classList.add('hidden');
      els.sourceTextarea.value = item.source || '';
      els.textFormSelect.value = item.form === 'plain' ? 'plain' : 'polite';
      setOutputText(item.translation || '', { isPlaceholder: !item.translation });
    });

    els.historyList.appendChild(btn);
  }
}

function applyIncomingSelection({ text, autoTranslate }) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return;
  if (state.activeRequestId) {
    cancelActiveStream();
  }
  switchTab('text');
  els.sourceTextarea.value = cleaned;
  showTextError('');
  if (autoTranslate) {
    startTextTranslation();
  }
}

/* =========================================================
 * Tab 2: ページ翻訳
 * ======================================================= */
function normalizePageStatus(rawStatus) {
  switch (rawStatus) {
    case 'translating':
    case 'running':
      return 'translating';
    case 'done':
    case 'completed':
      return 'done';
    case 'stopped':
    case 'cancelled':
    case 'canceled':
    case 'aborted':
      return 'stopped';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

function updatePageStatusUI(payload = {}) {
  const data =
    payload && typeof payload.status === 'object' && payload.status !== null
      ? payload.status
      : payload;

  if (payload?.pageTitle) {
    els.activeTabTitle.textContent = payload.pageTitle;
  }
  if (payload?.pageUrl) {
    els.activeTabHost.textContent = extractHostLabel(payload.pageUrl);
  }

  const status = normalizePageStatus(data.status);
  const completed = Math.max(0, Number(data.completed) || 0);
  const total = Math.max(0, Number(data.total) || 0);
  const skipped = Math.max(0, Number(data.skipped) || 0);
  const failed = Math.max(0, Number(data.failed) || 0);

  const statusMeta = {
    idle: { label: '待機中', cls: 'badge-idle' },
    translating: { label: '翻訳中', cls: 'badge-translating' },
    done: { label: '完了', cls: 'badge-done' },
    stopped: { label: '中止', cls: 'badge-stopped' },
    error: { label: 'エラー', cls: 'badge-error' }
  }[status];

  els.pageStatusBadge.className = `badge ${statusMeta.cls}`;
  els.pageStatusBadge.textContent = statusMeta.label;

  const pct = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : status === 'done' ? 100 : 0;
  els.pageProgressBar.style.width = `${pct}%`;
  els.pageProgressTrack.setAttribute('aria-valuenow', String(pct));

  els.pageCountProgress.textContent = `${completed} / ${total}`;
  els.pageCountSkipped.textContent = String(skipped);
  els.pageCountFailed.textContent = String(failed);

  const isTranslating = status === 'translating';
  els.pageStopBtn.disabled = !isTranslating;
  els.pageStartBtn.disabled = isTranslating;

  if (data.displayMode === 'replace' || data.displayMode === 'bilingual') {
    setPageDisplayModeRadios(data.displayMode);
  }

  if (data.error) {
    els.pageErrorBox.textContent = data.error;
    els.pageErrorBox.classList.remove('hidden');
  } else {
    els.pageErrorBox.textContent = '';
    els.pageErrorBox.classList.add('hidden');
  }
}

function setPageDisplayModeRadios(mode) {
  const isReplace = mode === 'replace';
  els.modeReplaceRadio.checked = isReplace;
  els.modeBilingualRadio.checked = !isReplace;
}

function extractHostLabel(url) {
  if (!url) return 'URL を取得できません';
  try {
    const parsed = new URL(url);
    return parsed.hostname || parsed.protocol.replace(/:$/, '') || url;
  } catch {
    return url;
  }
}

async function refreshActiveTabInfoAndStatus() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      state.activeTabId = null;
      els.activeTabTitle.textContent = 'アクティブなタブがありません';
      els.activeTabHost.textContent = '-';
      updatePageStatusUI({ status: 'idle', completed: 0, total: 0, skipped: 0, failed: 0 });
      return;
    }

    state.activeTabId = tab.id;
    els.activeTabTitle.textContent = tab.title || '無題のページ';
    els.activeTabHost.textContent = extractHostLabel(tab.url);

    const res = await chrome.runtime.sendMessage({
      type: 'PAGE_ACTION',
      action: 'GET_STATUS'
    });

    if (res && res.ok) {
      updatePageStatusUI(res);
    } else {
      updatePageStatusUI({
        status: res?.error ? 'error' : 'idle',
        completed: 0,
        total: 0,
        skipped: 0,
        failed: 0,
        error: res?.error || ''
      });
    }
  } catch (err) {
    updatePageStatusUI({
      status: 'error',
      completed: 0,
      total: 0,
      skipped: 0,
      failed: 0,
      error: err instanceof Error ? err.message : 'タブ情報の取得に失敗しました。'
    });
  }
}

async function sendPageAction(action, extra = {}) {
  els.pageErrorBox.textContent = '';
  els.pageErrorBox.classList.add('hidden');
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'PAGE_ACTION',
      action,
      ...extra
    });
    if (!res?.ok) {
      updatePageStatusUI({
        status: 'error',
        completed: Number(els.pageCountProgress.textContent.split('/')[0]) || 0,
        total: Number(els.pageCountProgress.textContent.split('/')[1]) || 0,
        skipped: Number(els.pageCountSkipped.textContent) || 0,
        failed: Number(els.pageCountFailed.textContent) || 0,
        error: res?.error || 'ページ操作に失敗しました。'
      });
      return res;
    }
    updatePageStatusUI(res);
    return res;
  } catch (err) {
    updatePageStatusUI({
      status: 'error',
      error: err instanceof Error ? err.message : 'ページとの通信に失敗しました。'
    });
    return { ok: false };
  }
}

/* =========================================================
 * Tab 3: 設定
 * ======================================================= */
function populateModelSelect(models, currentModel) {
  const select = els.settingModelSelect;
  select.textContent = '';

  const uniqueModels = Array.from(new Set(models.filter((m) => typeof m === 'string' && m.trim())));
  for (const modelId of uniqueModels) {
    const opt = document.createElement('option');
    opt.value = modelId;
    opt.textContent = modelId;
    select.appendChild(opt);
  }

  const customOpt = document.createElement('option');
  customOpt.value = CUSTOM_MODEL_VALUE;
  customOpt.textContent = uniqueModels.length
    ? '手動入力（カスタム）'
    : '手動入力（未取得）';
  select.appendChild(customOpt);

  if (currentModel && uniqueModels.includes(currentModel)) {
    select.value = currentModel;
  } else {
    select.value = CUSTOM_MODEL_VALUE;
  }
}

function applySettingsToUI(settings) {
  state.currentSettings = settings;
  els.headerModelLabel.textContent = settings.model || DEFAULT_SETTINGS.model;

  // Tab 1
  els.textFormSelect.value = settings.form === 'plain' ? 'plain' : 'polite';

  // Tab 2
  setPageDisplayModeRadios(settings.displayMode);

  // Tab 3
  els.settingBaseUrl.value = settings.baseUrl || DEFAULT_SETTINGS.baseUrl;
  els.settingModelInput.value = settings.model || DEFAULT_SETTINGS.model;
  populateModelSelect(state.loadedModels, els.settingModelInput.value);
  els.settingForm.value = settings.form === 'plain' ? 'plain' : 'polite';
  els.settingConcurrency.value = String(settings.concurrency ?? 1);
  els.settingDisplayMode.value = settings.displayMode === 'replace' ? 'replace' : 'bilingual';
  els.settingTemperature.value = String(settings.temperature ?? 0.0);
  els.settingSkipJapanese.checked = Boolean(settings.skipJapanese);
  els.settingGlossary.value = settings.glossaryText || '';
}

function renderConnectionTestBanner(result) {
  const box = els.connectionTestResult;
  box.textContent = '';
  box.className = 'banner';

  if (result.ok) {
    const summary = document.createElement('div');
    if (result.hasTargetModel) {
      box.classList.add('banner-success');
      summary.textContent = `LM Studio (${result.baseUrl}) に接続できました。対象モデル "${result.targetModel}" はロード済みです。`;
    } else if (result.models.length > 0) {
      box.classList.add('banner-warning');
      summary.textContent = `LM Studio に接続できましたが、指定モデル "${result.targetModel}" が見つかりません。`;
    } else {
      box.classList.add('banner-warning');
      summary.textContent = `LM Studio に接続できましたが、ロード済みのモデルがありません。`;
    }
    box.appendChild(summary);

    if (result.models.length > 0) {
      const listTitle = document.createElement('div');
      listTitle.className = 'mt-6';
      listTitle.textContent = `ロード済みモデル (${result.models.length}件):`;
      box.appendChild(listTitle);

      const ul = document.createElement('ul');
      ul.className = 'banner-detail-list';
      for (const modelId of result.models) {
        const li = document.createElement('li');
        li.textContent = modelId;
        ul.appendChild(li);
      }
      box.appendChild(ul);
    }
    return;
  }

  box.classList.add('banner-error');
  const errLine = document.createElement('div');
  errLine.textContent = result.error || `LM Studio (${result.baseUrl}) に接続できませんでした。`;
  box.appendChild(errLine);

  const tip = document.createElement('div');
  tip.className = 'mt-6';
  tip.textContent =
    'ヒント: LM Studio の Local Server が起動していること、および Server Settings の「Enable CORS」が ON になっていることを確認してください。';
  box.appendChild(tip);
}

async function handleSaveSettings(event) {
  event.preventDefault();
  const modelValue = els.settingModelInput.value.trim() || DEFAULT_SETTINGS.model;
  const tempValue = Number(els.settingTemperature.value);
  const clampedTemp = Number.isFinite(tempValue)
    ? Math.min(1, Math.max(0, Math.round(tempValue * 10) / 10))
    : 0.0;

  const saved = await saveSettings({
    baseUrl: normalizeBaseUrl(els.settingBaseUrl.value),
    model: modelValue,
    form: els.settingForm.value === 'plain' ? 'plain' : 'polite',
    concurrency: Number(els.settingConcurrency.value) || 1,
    displayMode: els.settingDisplayMode.value === 'replace' ? 'replace' : 'bilingual',
    temperature: clampedTemp,
    skipJapanese: els.settingSkipJapanese.checked,
    glossaryText: els.settingGlossary.value
  });

  applySettingsToUI(saved);

  els.settingsSavedBanner.classList.remove('hidden');
  if (state.savedBannerTimer) {
    clearTimeout(state.savedBannerTimer);
  }
  state.savedBannerTimer = setTimeout(() => {
    els.settingsSavedBanner.classList.add('hidden');
    state.savedBannerTimer = null;
  }, 2400);

  await checkConnection({ baseUrl: saved.baseUrl, model: saved.model });
}

/* =========================================================
 * イベント登録 & 初期化
 * ======================================================= */
function bindEvents() {
  // タブ切り替え
  for (const btn of els.tabButtons) {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.tab;
      if (targetTab) {
        switchTab(targetTab);
        if (targetTab === 'page') {
          refreshActiveTabInfoAndStatus();
        }
      }
    });
  }

  // ヘッダー更新ボタン
  els.refreshConnectionBtn.addEventListener('click', () => {
    checkConnection();
  });

  // Tab 1: テキスト翻訳
  els.sourceTextarea.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!state.activeRequestId) {
        startTextTranslation();
      }
    }
  });
  els.getSelectionBtn.addEventListener('click', fetchSelectionFromActiveTab);
  els.clearTextBtn.addEventListener('click', clearTextEditor);
  els.translateBtn.addEventListener('click', startTextTranslation);
  els.copyOutputBtn.addEventListener('click', copyTranslationOutput);
  els.clearHistoryBtn.addEventListener('click', async () => {
    await clearHistory();
    await renderHistory();
  });

  // Tab 2: ページ翻訳
  const onDisplayModeChange = async (mode) => {
    const saved = await saveSettings({ displayMode: mode });
    state.currentSettings = saved;
    els.settingDisplayMode.value = saved.displayMode;
    await sendPageAction('SET_MODE', { displayMode: saved.displayMode });
  };
  els.modeBilingualRadio.addEventListener('change', () => {
    if (els.modeBilingualRadio.checked) {
      onDisplayModeChange('bilingual');
    }
  });
  els.modeReplaceRadio.addEventListener('change', () => {
    if (els.modeReplaceRadio.checked) {
      onDisplayModeChange('replace');
    }
  });

  els.pageStartBtn.addEventListener('click', () => {
    const displayMode = els.modeReplaceRadio.checked ? 'replace' : 'bilingual';
    sendPageAction('START', { displayMode });
  });
  els.pageStopBtn.addEventListener('click', () => {
    sendPageAction('STOP');
  });
  els.pageRestoreBtn.addEventListener('click', () => {
    sendPageAction('RESTORE');
  });

  // Tab 3: 設定
  els.settingModelSelect.addEventListener('change', () => {
    const val = els.settingModelSelect.value;
    if (val !== CUSTOM_MODEL_VALUE) {
      els.settingModelInput.value = val;
    }
  });
  els.settingModelInput.addEventListener('input', () => {
    const typed = els.settingModelInput.value.trim();
    if (state.loadedModels.includes(typed)) {
      els.settingModelSelect.value = typed;
    } else {
      els.settingModelSelect.value = CUSTOM_MODEL_VALUE;
    }
  });

  els.testConnectionBtn.addEventListener('click', async () => {
    els.testConnectionBtn.disabled = true;
    try {
      const result = await checkConnection({
        baseUrl: els.settingBaseUrl.value,
        model: els.settingModelInput.value
      });
      renderConnectionTestBanner(result);
    } finally {
      els.testConnectionBtn.disabled = false;
    }
  });

  els.settingsForm.addEventListener('submit', handleSaveSettings);

  // ランタイムメッセージ（選択テキスト即時反映 & ページ進捗）
  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'SELECTION_FOR_SIDEPANEL') {
      applyIncomingSelection({
        text: message.text,
        autoTranslate: Boolean(message.autoTranslate)
      });
      return;
    }

    if (message.type === 'PAGE_PROGRESS_UPDATE') {
      if (typeof message.tabId === 'number' && message.tabId === state.activeTabId) {
        updatePageStatusUI(message);
      }
    }
  });

  // タブ切り替え・遷移時の同期
  chrome.tabs.onActivated.addListener(() => {
    refreshActiveTabInfoAndStatus();
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId === state.activeTabId && changeInfo.status === 'complete') {
      refreshActiveTabInfoAndStatus();
    }
  });
}

async function init() {
  bindEvents();

  const settings = await getSettings();
  applySettingsToUI(settings);

  ensureStreamPort();

  const pendingPromise = chrome.runtime
    .sendMessage({ type: 'GET_PENDING_SELECTION' })
    .then((pending) => {
      if (pending?.text) {
        applyIncomingSelection({
          text: pending.text,
          autoTranslate: Boolean(pending.autoTranslate)
        });
      }
    })
    .catch(() => {});

  await Promise.all([
    pendingPromise,
    renderHistory(),
    checkConnection({ baseUrl: settings.baseUrl, model: settings.model }),
    refreshActiveTabInfoAndStatus()
  ]);
}

init();
