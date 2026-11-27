import {
  STOP_SEQUENCES,
  buildSystemPrompt,
  normalizeBaseUrl,
  sanitizeTranslation
} from './constants.js';

/**
 * エラーやHTTPステータスを日本語の分かりやすいメッセージに分類する。
 * @param {unknown} err
 * @param {number | undefined} status
 * @param {string} baseUrl
 * @param {string} model
 * @returns {string}
 */
export function classifyError(err, status, baseUrl, model) {
  if (err && typeof err === 'object' && err.name === 'AbortError') {
    return '翻訳をキャンセルしました。';
  }

  if (typeof status === 'number') {
    if (status === 403) {
      return `LM Studio (${baseUrl}) からアクセスが拒否されました (403)。LM Studio の Server Settings で「Enable CORS」が ON か確認してください。`;
    }
    if (status === 404) {
      return `モデル "${model}" または API エンドポイントが見つかりません (404)。LM Studio でモデルがロードされているか確認してください。`;
    }
    if (status === 400) {
      return `LM Studio へのリクエストが不正です (400)。モデル "${model}" の設定や入力テキスト長を確認してください。`;
    }
    if (status >= 500) {
      return `LM Studio サーバー側でエラーが発生しました (HTTP ${status})。LM Studio のログを確認してください。`;
    }
    return `LM Studio からエラー応答が返されました (HTTP ${status})。`;
  }

  const msg = err instanceof Error ? err.message : String(err || '');
  if (/failed to fetch|networkerror|err_connection_refused|load failed/i.test(msg)) {
    return `LM Studio (${baseUrl}) に接続できません。Local Server が起動しているか確認してください。`;
  }
  return msg || '不明な通信エラーが発生しました。';
}

/**
 * LM Studio の /v1/models からロード済みモデルID一覧を取得する。
 * @param {string} baseUrl
 * @param {AbortSignal} [signal]
 * @returns {Promise<string[]>}
 */
export async function fetchModels(baseUrl, signal) {
  const url = `${normalizeBaseUrl(baseUrl)}/v1/models`;
  let res;
  try {
    res = await fetch(url, { method: 'GET', signal });
  } catch (err) {
    throw new Error(classifyError(err, undefined, baseUrl, ''));
  }

  if (!res.ok) {
    throw new Error(classifyError(null, res.status, baseUrl, ''));
  }

  const json = await res.json();
  const list = Array.isArray(json?.data) ? json.data : [];
  return list.map((item) => item?.id).filter((id) => typeof id === 'string' && id.length > 0);
}

/**
 * リクエストペイロードを作成する。
 */
function buildChatPayload({ model, text, targetLang, form, glossaryText, temperature, maxTokens, stream }) {
  return {
    model,
    messages: [
      {
        role: 'system',
        content: buildSystemPrompt({ targetLang, form, glossaryText })
      },
      {
        role: 'user',
        content: text
      }
    ],
    temperature: typeof temperature === 'number' ? temperature : 0.0,
    max_tokens: typeof maxTokens === 'number' ? maxTokens : 2048,
    stop: STOP_SEQUENCES,
    stream
  };
}

/**
 * 非ストリーミングでテキストを翻訳する（ページ一括翻訳向け）。
 * @param {object} params
 * @returns {Promise<string>}
 */
export async function translateText({
  baseUrl,
  model,
  text,
  targetLang = 'ja',
  form = 'polite',
  glossaryText = '',
  temperature = 0.0,
  maxTokens = 2048,
  signal
}) {
  const normalizedUrl = normalizeBaseUrl(baseUrl);
  const endpoint = `${normalizedUrl}/v1/chat/completions`;
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        buildChatPayload({
          model,
          text,
          targetLang,
          form,
          glossaryText,
          temperature,
          maxTokens,
          stream: false
        })
      ),
      signal
    });
  } catch (err) {
    throw new Error(classifyError(err, undefined, normalizedUrl, model));
  }

  if (!res.ok) {
    throw new Error(classifyError(null, res.status, normalizedUrl, model));
  }

  const data = await res.json();
  const rawContent = data?.choices?.[0]?.message?.content ?? '';
  return sanitizeTranslation(rawContent);
}

/**
 * ストリーミング（SSE）でテキストを翻訳する（サイドパネル向け）。
 * @param {object} params
 * @param {(delta: string) => void} [params.onChunk]
 * @returns {Promise<string>}
 */
export async function streamTranslate({
  baseUrl,
  model,
  text,
  targetLang = 'ja',
  form = 'polite',
  glossaryText = '',
  temperature = 0.0,
  maxTokens = 2048,
  onChunk,
  signal
}) {
  const normalizedUrl = normalizeBaseUrl(baseUrl);
  const endpoint = `${normalizedUrl}/v1/chat/completions`;
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        buildChatPayload({
          model,
          text,
          targetLang,
          form,
          glossaryText,
          temperature,
          maxTokens,
          stream: true
        })
      ),
      signal
    });
  } catch (err) {
    throw new Error(classifyError(err, undefined, normalizedUrl, model));
  }

  if (!res.ok) {
    throw new Error(classifyError(null, res.status, normalizedUrl, model));
  }

  if (!res.body) {
    // まれにストリーム非対応環境へのフォールバック
    const data = await res.json();
    const fallbackText = sanitizeTranslation(data?.choices?.[0]?.message?.content ?? '');
    if (fallbackText && onChunk) {
      onChunk(fallbackText);
    }
    return fallbackText;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let fullText = '';

  const processLine = (rawLine) => {
    const line = rawLine.trim();
    if (!line || !line.startsWith('data:')) {
      return false;
    }
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') {
      return true;
    }
    try {
      const parsed = JSON.parse(payload);
      const delta = parsed?.choices?.[0]?.delta?.content ?? parsed?.choices?.[0]?.message?.content ?? '';
      if (typeof delta === 'string' && delta.length > 0) {
        // 特殊トークンそのものが紛れ込んだ場合はフィルタ
        const cleanDelta = delta.replace(/<\|plamo:[^>]*\|>/g, '');
        if (cleanDelta.length > 0) {
          fullText += cleanDelta;
          if (onChunk) {
            onChunk(cleanDelta);
          }
        }
      }
    } catch {
      // 不完全JSONやコメント行は無視
    }
    return false;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (processLine(line)) {
          return sanitizeTranslation(fullText);
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      processLine(buffer);
    }
    return sanitizeTranslation(fullText);
  } catch (err) {
    if (err && typeof err === 'object' && err.name === 'AbortError') {
      throw new Error('翻訳をキャンセルしました。');
    }
    throw new Error(classifyError(err, undefined, normalizedUrl, model));
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}
