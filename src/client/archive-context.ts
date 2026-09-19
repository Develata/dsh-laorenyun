/** Per-request archive is captured before async work; never infer ownership from late UI selection. */
let selected: string | null = null;
const memberships = new Map<string, string>();
export function setMemberships(
  archives: { id: string; sessionIds: string[] }[],
) {
  memberships.clear();
  for (const archive of archives)
    for (const session of archive.sessionIds)
      memberships.set(session, archive.id);
}
const listeners = new Set<() => void>();
export const archiveSelection = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  getSnapshot: () => selected,
};
export const setArchive = (id: string) => {
  if (selected === id) return;
  selected = id;
  listeners.forEach((fn) => fn());
};
export const archiveHeaders = (sessionId?: string): Record<string, string> => {
  const id = sessionId ? (memberships.get(sessionId) ?? selected) : selected;
  return id ? { "X-Laorenyun-Archive": id } : {};
};
export const archiveUrl = (url: string) =>
  selected
    ? url +
      (url.includes("?") ? "&" : "?") +
      "archive=" +
      encodeURIComponent(selected)
    : url;
