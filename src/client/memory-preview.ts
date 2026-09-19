import type { RiverNode } from "../river/types.ts";
import { archiveSelection } from "./archive-context.ts";
let value: {
  archive: string | null;
  node: RiverNode;
  branchCount: number;
  full: boolean;
} | null = null;
const listeners = new Set<() => void>();
export const memoryPreview = {
  getSnapshot: () => value,
  subscribe: (fn: () => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  show(node: RiverNode, branchCount: number, full = false) {
    value = {
      archive: archiveSelection.getSnapshot(),
      node,
      branchCount,
      full,
    };
    listeners.forEach((fn) => fn());
  },
  clear() {
    value = null;
    listeners.forEach((fn) => fn());
  },
};
