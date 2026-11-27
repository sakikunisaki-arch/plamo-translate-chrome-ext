export const STORAGE_KEYS = {
  SETTINGS: 'plamoSettings',
  HISTORY: 'plamoHistory',
  PENDING_SELECTION: 'plamoPendingSelection'
};

export const PORT_NAME = 'plamo-stream';

export const STOP_SEQUENCES = ['<|plamo:tag|>', '<|plamo:bos|>'];

export const MAX_HISTORY_ITEMS = 10;

export const DEFAULT_SETTINGS = {
  baseUrl: 'http://localhost:1234',
  model: 'plamo-3-translate-2b',
  targetLang: 'ja',
  form: 'polite',            // 'polite' | 'plain'
  glossaryText: '',          // 1行1件: "source => target"
  concurrency: 1,            // 1..4
  displayMode: 'bilingual',  // 'bilingual' | 'replace'
  skipJapanese: true,        // 既に日本語のブロックをスキップ
  temperature: 0.0,
  maxTokens: 2048
};

/**
 * ベースURLを正規化する（末尾スラッシュ除去・プロトコル補完）。
 * @param {string} url
 * @returns {string}
 */
export function normalizeBaseUrl(url) {
  const trimmed = String(url ?? '').trim();
  if (!trimmed) {
    return DEFAULT_SETTINGS.baseUrl;
  }
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withProtocol.replace(/\/+$/, '');
}

/**
 * ローカルLM Studioサーバー向けの安全なURLかどうかを判定する。
 * @param {string} url
 * @returns {boolean}
 */
export function isLocalhostUrl(url) {
  try {
    const parsed = new URL(normalizeBaseUrl(url));
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  } catch {
    return false;
  }
}

/**
 * 用語集テキストをパースして `[source, target]` の配列を返す。
 * 区切り記号は `=>`, `->`, `:`, `：` を許容し、空行・`#` コメント行は無視する。
 * @param {string} glossaryText
 * @returns {Array<[string, string]>}
 */
export function parseGlossary(glossaryText) {
  if (!glossaryText || typeof glossaryText !== 'string') {
    return [];
  }
  const entries = [];
  const lines = glossaryText.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const match = line.match(/^(.+?)\s*(?:=>|->|:|：)\s*(.+)$/);
    if (match) {
      const source = match[1].trim();
      const target = match[2].trim();
      if (source && target) {
        entries.push([source, target]);
      }
    }
  }
  return entries;
}

/**
 * PLaMo-3-Translate 用の system プロンプトを構築する。
 * @param {{ targetLang?: string, form?: string, glossaryText?: string }} options
 * @returns {string}
 */
export function buildSystemPrompt({ targetLang = 'ja', form = 'polite', glossaryText = '' } = {}) {
  const safeForm = form === 'plain' ? 'plain' : 'polite';
  const safeLang = String(targetLang || 'ja').trim() || 'ja';
  const lines = [
    '[plamo-translate]',
    `target_lang=${safeLang}`,
    `form=${safeForm}`
  ];

  const glossaryEntries = parseGlossary(glossaryText);
  for (const [source, target] of glossaryEntries) {
    lines.push(`glossary=${source} => ${target}`);
  }

  return lines.join('\n');
}

/**
 * モデルの出力から末尾・先頭の特殊トークン残骸を除去する。
 * @param {string} text
 * @returns {string}
 */
export function sanitizeTranslation(text) {
  if (!text || typeof text !== 'string') {
    return '';
  }
  return text
    .replace(/<\|plamo:[^>]*\|>/g, '')
    .replace(/<\|plamo:[^>]*$/g, '')
    .trim();
}
