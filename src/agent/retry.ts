export function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message || '';

  // 当前先从错误消息里兜底识别 HTTP 状态码。
  // 以后如果直接接 AI SDK 结构化错误，优先看 statusCode / isRetryable。
  const statusMatch = message.match(/(\d{3})/);
  if (statusMatch) {
    const status = parseInt(statusMatch[1]);
    if ([429, 529, 408].includes(status)) return true;
    if (status >= 500 && status < 600) return true;
    if (status >= 400 && status < 500) return false;
  }
  if (message.includes('ECONNRESET') || message.includes('EPIPE')) return true;
  if (message.includes('ETIMEDOUT') || message.includes('timeout')) return true;
  if (message.includes('fetch failed') || message.includes('network')) return true;
  if (message.includes('No output generated')) return true;

  return false;
}

export function calculateDelay(attempt: number, baseMs = 500, maxMs = 30000): number {
  // 指数退避加少量随机抖动，避免连续失败时所有请求按固定节奏一起重试。
  const exponential = baseMs * Math.pow(2, attempt - 1);
  const capped = Math.min(exponential, maxMs);
  const jitter = capped * 0.25;

  return Math.max(0, Math.round(capped + (Math.random() * 2 - 1) * jitter));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
