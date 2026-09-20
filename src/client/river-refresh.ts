import type { RiverSnapshot } from "../river/types.ts";
export function retainProjection(
  old: RiverSnapshot | null,
  next: RiverSnapshot,
) {
  return old?.projectionRevision === next.projectionRevision ? old : next;
}
/** One in-flight local read, only during mounted/visible lifetime. */
export function pollRiver(
  load: (signal: AbortSignal) => Promise<RiverSnapshot>,
  receive: (snapshot: RiverSnapshot) => void,
  failed: () => void,
  visible: () => boolean = () => !document.hidden,
  interval = 5000,
) {
  const controller = new AbortController();
  let pending = false;
  const refresh = async () => {
    if (pending || !visible() || controller.signal.aborted) return;
    pending = true;
    try {
      const snapshot = await load(controller.signal);
      if (!controller.signal.aborted) receive(snapshot);
    } catch {
      if (!controller.signal.aborted) failed();
    } finally {
      pending = false;
    }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), interval);
  return () => {
    clearInterval(timer);
    controller.abort();
  };
}
