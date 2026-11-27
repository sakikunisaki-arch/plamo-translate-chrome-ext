import { DEFAULT_SETTINGS, MAX_HISTORY_ITEMS, STORAGE_KEYS, normalizeBaseUrl } from './constants.js';

/**
 * 設定を正規化して返す。
 * @param {Partial<typeof DEFAULT_SETTINGS>} raw
 * @returns {typeof DEFAULT_SETTINGS}
 */
function sanitizeSettings(raw = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...raw };
  const concurrencyNum = Number(merged.concurrency);
  const temperatureNum = Number(merged.temperature);
  const maxTokensNum = Number(merged.maxTokens);

  return {
    baseUrl: normalizeBaseUrl(merged.baseUrl),
    model: String(merged.model || DEFAULT_SETTINGS.model).trim() || DEFAULT_SETTINGS.model,
    targetLang: String(merged.targetLang || DEFAULT_SETTINGS.targetLang).trim() || 'ja',
    form: merged.form === 'plain' ? 'plain' : 'polite',
    glossaryText: typeof merged.glossaryText === 'string' ? merged.glossaryText : '',
    concurrency: Number.isFinite(concurrencyNum) ? Math.min(4, Math.max(1, Math.round(concurrencyNum))) : 1,
    displayMode: merged.displayMode === 'replace' ? 'replace' : 'bilingual',
    skipJapanese: Boolean(merged.skipJapanese),
    temperature: Number.isFinite(temperatureNum) ? Math.min(2, Math.max(0, temperatureNum)) : 0.0,
    maxTokens: Number.isFinite(maxTokensNum) ? Math.min(8192, Math.max(64, Math.round(maxTokensNum))) : 2048
  };
}

/**
 * 現在の設定を取得する。
 * @returns {Promise<typeof DEFAULT_SETTINGS>}
 */
export async function getSettings() {
  const res = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return sanitizeSettings(res[STORAGE_KEYS.SETTINGS]);
}

/**
 * 設定を部分更新して保存する。
 * @param {Partial<typeof DEFAULT_SETTINGS>} partial
 * @returns {Promise<typeof DEFAULT_SETTINGS>}
 */
export async function saveSettings(partial) {
  const current = await getSettings();
  const next = sanitizeSettings({ ...current, ...partial });
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: next });
  return next;
}

/**
 * 翻訳履歴一覧を取得する。
 * @returns {Promise<Array<{ id: string, source: string, translation: string, form: string, timestamp: number }>>}
 */
export async function getHistory() {
  const res = await chrome.storage.local.get(STORAGE_KEYS.HISTORY);
  const list = res[STORAGE_KEYS.HISTORY];
  return Array.isArray(list) ? list : [];
}

/**
 * 翻訳履歴に新しい項目を先頭追加し、最大10件に保つ。
 * @param {{ id?: string, source: string, translation: string, form?: string, timestamp?: number }} item
 * @returns {Promise<Array>}
 */
export async function addHistoryItem(item) {
  if (!item || !item.source || !item.translation) {
    return getHistory();
  }
  const current = await getHistory();
  const entry = {
    id: item.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    source: String(item.source),
    translation: String(item.translation),
    form: item.form === 'plain' ? 'plain' : 'polite',
    timestamp: Number(item.timestamp) || Date.now()
  };

  // 直前と同一原文・同文体の重複を整理
  const filtered = current.filter(
    (h) => !(h.source === entry.source && h.form === entry.form)
  );
  const next = [entry, ...filtered].slice(0, MAX_HISTORY_ITEMS);
  await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: next });
  return next;
}

/**
 * 翻訳履歴をすべて削除する。
 * @returns {Promise<void>}
 */
export async function clearHistory() {
  await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: [] });
}
