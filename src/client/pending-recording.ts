/** One durable browser recording per session until Host acknowledgement. Private local data. */
export interface PendingRecording {
  sessionId: string;
  sourceId: string;
  blob: Blob;
  durationMs: number;
  incomplete?: "size-limit" | "recorder-error" | "stop-timeout";
}
export async function pendingRecording(
  sessionId: string,
  value?: PendingRecording | null,
): Promise<PendingRecording | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("本机录音保存超时")), 5000);
    const opening = indexedDB.open("laorenyun-recordings", 1);
    opening.onupgradeneeded = () =>
      opening.result.createObjectStore("pending", { keyPath: "sessionId" });
    opening.onerror = () => {
      clearTimeout(timer);
      reject(new Error("无法保存浏览器录音，请保留页面"));
    };
    opening.onsuccess = () => {
      const db = opening.result;
      const tx = db.transaction(
        "pending",
        value === undefined ? "readonly" : "readwrite",
      );
      const store = tx.objectStore("pending");
      const request =
        value === undefined
          ? store.get(sessionId)
          : value === null
            ? store.delete(sessionId)
            : store.put(value);
      tx.oncomplete = () => {
        clearTimeout(timer);
        db.close();
        resolve(
          value === undefined ? (request.result ?? null) : (value ?? null),
        );
      };
      tx.onerror = () => {
        clearTimeout(timer);
        db.close();
        reject(new Error("浏览器录音保存失败，请保留页面"));
      };
    };
  });
}
