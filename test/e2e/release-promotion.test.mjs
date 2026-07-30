import assert from "node:assert/strict";
import test from "node:test";

import { planReleasePromotion } from "../../scripts/release-promotion.mjs";

test("release promotion starts a root commit when release is absent", () => {
	assert.deepEqual(
		planReleasePromotion({
			expectedRemote: null,
			actualRemote: null,
			generatedTree: "tree-a",
			remoteTree: null,
		}),
		{ action: "create", parent: null },
	);
});

test("release promotion advances from the fetched remote parent", () => {
	assert.deepEqual(
		planReleasePromotion({
			expectedRemote: "abc",
			actualRemote: "abc",
			generatedTree: "tree-b",
			remoteTree: "tree-a",
		}),
		{ action: "create", parent: "abc" },
	);
});

test("release promotion is a deterministic no-op for an identical tree", () => {
	assert.deepEqual(
		planReleasePromotion({
			expectedRemote: "abc",
			actualRemote: "abc",
			generatedTree: "tree-a",
			remoteTree: "tree-a",
		}),
		{ action: "noop", parent: "abc" },
	);
});

test("release promotion refuses a remote OID race", () => {
	assert.throws(
		() =>
			planReleasePromotion({
				expectedRemote: "abc",
				actualRemote: "def",
				generatedTree: "tree-b",
				remoteTree: "tree-a",
			}),
		/remote release changed/i,
	);
});
