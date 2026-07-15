import assert from "node:assert/strict";
import test from "node:test";
import type { GitRef } from "./gitApi";
import { partitionRefs } from "./GraphView";

const refs: GitRef[] = Array.from({ length: 9 }, (_, index) => ({
  kind: "branch",
  name: `branch-${index}`,
}));

test("collapsed graph rows expose five refs and summarize the rest", () => {
  const result = partitionRefs(refs, false);
  assert.equal(result.visible.length, 5);
  assert.equal(result.hidden, 4);
});

test("expanded graph rows expose every ref", () => {
  const result = partitionRefs(refs, true);
  assert.equal(result.visible.length, 9);
  assert.equal(result.hidden, 0);
});
