import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GitRef } from "./gitApi";
import { GraphView, partitionRefs } from "./GraphView";

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

test("worktree row owns no Git refs and the HEAD commit owns each ref once", () => {
  const html = renderToStaticMarkup(
    createElement(GraphView, {
      commits: [{
        sha: "abc1234",
        parents: [],
        author: "Ann",
        date: "2026-08-02T00:00:00Z",
        subject: "release",
        refs: [
          { kind: "head", name: "HEAD" },
          { kind: "branch", name: "release-1.7.8" },
          { kind: "remote", name: "origin/release-1.7.8" },
        ],
      }],
      selectedSha: null,
      onSelect: () => undefined,
      hasMore: false,
      loadingMore: false,
      onLoadMore: () => undefined,
      dirty: true,
      headSha: "abc1234",
      branch: "release-1.7.8",
    }),
  );
  assert.equal((html.match(/>HEAD</g) ?? []).length, 1);
  assert.equal((html.match(/>release-1\.7\.8</g) ?? []).length, 1);
  assert.equal((html.match(/>origin\/release-1\.7\.8</g) ?? []).length, 1);
  assert.doesNotMatch(html, />heads\/release-1\.7\.8</);
});
