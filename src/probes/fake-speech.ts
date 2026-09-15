import { checkOperation, type SpeechToTextProvider } from "../domain/types.ts";
/** Explicit dev-only fixture; never registered as a cloud provider. */
export const fakeSpeech: SpeechToTextProvider = {
  async transcribe(_media, op) {
    checkOperation(op);
    return { text: "我那个时候去了合肥一中", provider: "phase1-fixture" };
  },
};
