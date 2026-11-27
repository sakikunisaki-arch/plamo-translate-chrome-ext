import { PORT_NAME, STORAGE_KEYS, normalizeBaseUrl } from '../shared/constants.js';
import { getSettings } from '../shared/storage.js';
import { fetchModels, streamTranslate, translateText } from '../shared/lmstudio.js';

const MENU_TRANSLATE_SELECTION = 'plamo-translate-selection';
const MENU_TRANSLATE_PAGE = 'plamo-translate-page';

/** タブIDごとの進行中翻訳 AbortController セット */
const tabAbortControllers = new Map();

/** ストリーム要求ごとの AbortController */
const streamControllers = new Map();

/** コンテキストメニュー等から渡された未処理選択テキスト（メモリキャッシュ） */
let pendingSelectionCache = { text: null, autoTranslate: false };

/**
 * コンテキストメニューを初期化する。
 */
function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_TRANSLATE_SELECTION,
      title: 'PLaMoで選択テキストを翻訳（サイドパネル）',
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: MENU_TRANSLATE_PAGE,
      title: 'PLaMoでページ全体を翻訳',
      contexts: ['page']
    });
  });
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  setupContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  setupContextMenus();
});

/**
 * URLがContent Script注入可能な通常ページか判定する。
 * @param {string | undefined} url
 * @returns {{ supported: boolean, reason?: string }}
 */
function checkSupportedTabUrl(url) {
  if (!url) {
    return { supported: false, reason: 'アクティブなタブの URL を取得できませんでした。' };
  }
  const lower = url.toLowerCase();
  if (
    lower.startsWith('chrome://') ||
    lower.startsWith('chrome-extension://') ||
    lower.startsWith('edge://') ||
    lower.startsWith('about:') ||
    lower.startsWith('view-source:') ||
    lower.startsWith('https://chromewebstore.google.com/') ||
    lower.startsWith('https://chrome.google.com/webstore')
  ) {
    return {
      supported: false,
      reason: 'Chrome の内部ページや拡張機能ストアではページ翻訳を利用できません。通常の Web ページでお試しください。'
    };
  }
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
    return {
      supported: false,
      reason: 'このページ（file:// や特殊スキーム）ではページ翻訳が制限されている場合があります。http:// または https:// ページでお試しください。'
    };
  }
  return { supported: true };
}

/**
 * 指定タブに Content Script へメッセージを送り、未注入なら動的注入してリトライする。
 * @param {chrome.tabs.Tab} tab
 * @param {object} payload
 * @returns {Promise<any>}
 */
async function sendToTabWithEnsure(tab, payload) {
  if (tab?.url) {
    const urlCheck = checkSupportedTabUrl(tab.url);
    if (!urlCheck.supported) {
      return { ok: false, error: urlCheck.reason };
    }
  }

  try {
    return await chrome.tabs.sendMessage(tab.id, payload);
  } catch {
    if (!tab?.url) {
      return {
        ok: false,
        error: 'このページとは通信できませんでした。通常の Web ページを再読み込みしてからお試しください（chrome:// 等の内部ページでは動作しません）。'
      };
    }
    // 未注入（拡張機能インストール直後に既に開いていたタブ等）の場合に動的注入して再試行
    try {
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['src/content/content.css']
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['src/content/content.js']
      });
      return await chrome.tabs.sendMessage(tab.id, payload);
    } catch (injectErr) {
      return {
        ok: false,
        error: `ページとの通信に失敗しました: ${injectErr?.message || 'ページを再読み込みしてからお試しください。'}`
      };
    }
  }
}

/**
 * タブごとの並列制御セマフォ
 */
const tabQueues = new Map();

function getTabQueue(tabId, concurrency) {
  let state = tabQueues.get(tabId);
  if (!state) {
    state = { active: 0, waiters: [], limit: concurrency };
    tabQueues.set(tabId, state);
  }
  state.limit = Math.max(1, Math.min(4, Number(concurrency) || 1));
  return state;
}

async function withConcurrencySlot(tabId, concurrency, signal, fn) {
  const queue = getTabQueue(tabId, concurrency);
  if (queue.active < queue.limit) {
    queue.active += 1;
  } else {
    await new Promise((resolve, reject) => {
      const onAbort = () => {
        const idx = queue.waiters.indexOf(entry);
        if (idx >= 0) queue.waiters.splice(idx, 1);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      const entry = { resolve, onAbort, signal };
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      queue.waiters.push(entry);
    });
  }

  try {
    return await fn();
  } finally {
    const next = queue.waiters.shift();
    if (next) {
      next.signal?.removeEventListener('abort', next.onAbort);
      next.resolve();
    } else {
      queue.active = Math.max(0, queue.active - 1);
    }
  }
}

function abortTabRequests(tabId) {
  const set = tabAbortControllers.get(tabId);
  if (set) {
    for (const controller of set) {
      controller.abort();
    }
    set.clear();
  }
  const queue = tabQueues.get(tabId);
  if (queue) {
    while (queue.waiters.length > 0) {
      const waiter = queue.waiters.shift();
      waiter.onAbort();
    }
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  abortTabRequests(tabId);
  tabAbortControllers.delete(tabId);
  tabQueues.delete(tabId);
});

/**
 * コンテキストメニュークリック処理
 * 重要: chrome.sidePanel.open() はユーザージェスチャー維持のため await 前に同期呼び出しする。
 */
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;

  if (info.menuItemId === MENU_TRANSLATE_SELECTION) {
    // 先に同期で sidePanel.open を呼ぶ
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});

    const selectedText = String(info.selectionText || '').trim();
    if (selectedText) {
      pendingSelectionCache = { text: selectedText, autoTranslate: true };
      chrome.storage.session
        ?.set({ [STORAGE_KEYS.PENDING_SELECTION]: pendingSelectionCache })
        .catch(() => {});

      chrome.runtime
        .sendMessage({
          type: 'SELECTION_FOR_SIDEPANEL',
          text: selectedText,
          autoTranslate: true
        })
        .catch(() => {});
    }
    return;
  }

  if (info.menuItemId === MENU_TRANSLATE_PAGE) {
    getSettings().then((settings) => {
      sendToTabWithEnsure(tab, {
        type: 'CONTENT_PAGE_ACTION',
        action: 'START',
        displayMode: settings.displayMode,
        settings
      });
    });
  }
});

/**
 * サイドパネル向けのストリーミング長寿命ポート
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;

  const portRequestIds = new Set();

  port.onMessage.addListener(async (msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'CANCEL_STREAM' && msg.requestId) {
      const controller = streamControllers.get(msg.requestId);
      if (controller) {
        controller.abort();
        streamControllers.delete(msg.requestId);
      }
      portRequestIds.delete(msg.requestId);
      return;
    }

    if (msg.type === 'TRANSLATE_STREAM' && msg.requestId) {
      const { requestId, text, overrides } = msg;
      const controller = new AbortController();
      streamControllers.set(requestId, controller);
      portRequestIds.add(requestId);

      const startedAt = Date.now();
      try {
        const settings = await getSettings();
        const merged = {
          ...settings,
          ...(overrides && typeof overrides === 'object' ? overrides : {})
        };

        const translated = await streamTranslate({
          baseUrl: merged.baseUrl,
          model: merged.model,
          text: String(text || ''),
          targetLang: merged.targetLang,
          form: merged.form,
          glossaryText: merged.glossaryText,
          temperature: merged.temperature,
          maxTokens: merged.maxTokens,
          signal: controller.signal,
          onChunk: (delta) => {
            try {
              port.postMessage({ type: 'STREAM_CHUNK', requestId, delta });
            } catch {
              controller.abort();
            }
          }
        });

        try {
          port.postMessage({
            type: 'STREAM_DONE',
            requestId,
            text: translated,
            elapsedMs: Date.now() - startedAt
          });
        } catch {
          // ポート切断済み
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'ストリーミング翻訳中にエラーが発生しました。';
        try {
          port.postMessage({
            type: 'STREAM_ERROR',
            requestId,
            error: message
          });
        } catch {
          // ポート切断済み
        }
      } finally {
        streamControllers.delete(requestId);
        portRequestIds.delete(requestId);
      }
    }
  });

  port.onDisconnect.addListener(() => {
    for (const requestId of portRequestIds) {
      const controller = streamControllers.get(requestId);
      if (controller) {
        controller.abort();
        streamControllers.delete(requestId);
      }
    }
    portRequestIds.clear();
  });
});

/**
 * ワンショットメッセージハンドラ
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.type === 'CHECK_CONNECTION') {
    (async () => {
      const settings = await getSettings();
      const baseUrl = normalizeBaseUrl(message.baseUrl || settings.baseUrl);
      const targetModel = String(message.model || settings.model || '').trim();
      try {
        const models = await fetchModels(baseUrl);
        const hasTargetModel = targetModel ? models.includes(targetModel) : models.length > 0;
        sendResponse({ ok: true, models, hasTargetModel });
      } catch (err) {
        sendResponse({
          ok: false,
          models: [],
          hasTargetModel: false,
          error: err instanceof Error ? err.message : '接続テストに失敗しました。'
        });
      }
    })();
    return true;
  }

  if (message.type === 'GET_PENDING_SELECTION') {
    (async () => {
      if (pendingSelectionCache.text) {
        const payload = { ...pendingSelectionCache };
        pendingSelectionCache = { text: null, autoTranslate: false };
        await chrome.storage.session?.remove(STORAGE_KEYS.PENDING_SELECTION).catch(() => {});
        sendResponse(payload);
        return;
      }
      try {
        const stored = await chrome.storage.session?.get(STORAGE_KEYS.PENDING_SELECTION);
        const val = stored?.[STORAGE_KEYS.PENDING_SELECTION];
        if (val?.text) {
          await chrome.storage.session?.remove(STORAGE_KEYS.PENDING_SELECTION).catch(() => {});
          sendResponse({ text: val.text, autoTranslate: Boolean(val.autoTranslate) });
          return;
        }
      } catch {
        // session storage unavailable
      }
      sendResponse({ text: null, autoTranslate: false });
    })();
    return true;
  }

  if (message.type === 'PAGE_ACTION') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        sendResponse({ ok: false, error: 'アクティブなタブが見つかりませんでした。' });
        return;
      }

      if (message.action === 'STOP' || message.action === 'RESTORE' || message.action === 'START') {
        abortTabRequests(tab.id);
      }

      const settings = await getSettings();
      const res = await sendToTabWithEnsure(tab, {
        type: 'CONTENT_PAGE_ACTION',
        action: message.action,
        displayMode: message.displayMode || settings.displayMode,
        settings
      });
      sendResponse({ ...res, tabId: tab.id });
    })();
    return true;
  }

  if (message.type === 'TRANSLATE_TEXT') {
    (async () => {
      const tabId = sender?.tab?.id ?? -1;
      const controller = new AbortController();
      let set = tabAbortControllers.get(tabId);
      if (!set) {
        set = new Set();
        tabAbortControllers.set(tabId, set);
      }
      set.add(controller);

      try {
        const settings = await getSettings();
        const translated = await withConcurrencySlot(
          tabId,
          settings.concurrency,
          controller.signal,
          () =>
            translateText({
              baseUrl: settings.baseUrl,
              model: settings.model,
              text: String(message.text || ''),
              targetLang: settings.targetLang,
              form: settings.form,
              glossaryText: settings.glossaryText,
              temperature: settings.temperature,
              maxTokens: settings.maxTokens,
              signal: controller.signal
            })
        );
        sendResponse({ ok: true, text: translated });
      } catch (err) {
        const aborted =
          (err && typeof err === 'object' && err.name === 'AbortError') ||
          controller.signal.aborted;
        sendResponse({
          ok: false,
          aborted,
          error: aborted
            ? '翻訳を中止しました。'
            : err instanceof Error
              ? err.message
              : '翻訳に失敗しました。'
        });
      } finally {
        set.delete(controller);
      }
    })();
    return true;
  }

  if (message.type === 'ABORT_TAB_TRANSLATION') {
    const tabId = sender?.tab?.id;
    if (typeof tabId === 'number') {
      abortTabRequests(tabId);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'PAGE_PROGRESS') {
    const tabId = sender?.tab?.id;
    if (typeof tabId === 'number') {
      chrome.runtime
        .sendMessage({
          type: 'PAGE_PROGRESS_UPDATE',
          tabId,
          status: message.status,
          completed: message.completed,
          total: message.total,
          skipped: message.skipped,
          failed: message.failed,
          displayMode: message.displayMode,
          error: message.error
        })
        .catch(() => {});
    }
    return false;
  }

  return false;
});
