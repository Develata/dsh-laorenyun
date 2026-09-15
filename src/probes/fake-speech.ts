import {
  checkOperation,
  type Media,
  type OperationContext,
} from "../domain/types.ts";
/** Phase 1 deterministic source fixture, not a production provider contract. */
export const fakeSpeech = {
  async transcribe(_media: Media, op: OperationContext) {
    checkOperation(op);
    return { text: "我那个时候去了合肥一中", provider: "phase1-fixture" };
  },
};
