/** Calls use DSH's same-origin authenticated Fetch route; no credentials in client bundles. */
export async function api<T>(
  method: string,
  body: object,
  signal?: AbortSignal,
  timeoutMs = 10000,
): Promise<T> {
  const response = await fetch(`/api/laorenyun/${method}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
  });
  const result = (await response.json()) as {
    ok: boolean;
    value: T;
    error?: string;
  };
  if (!response.ok || !result.ok) throw new Error(result.error ?? "请求失败");
  return result.value;
}
