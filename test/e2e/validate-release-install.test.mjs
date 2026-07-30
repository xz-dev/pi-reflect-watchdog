import assert from "node:assert/strict";
import test from "node:test";

import { validateReleaseCandidate } from "../../scripts/e2e/validate-release-install.mjs";

test("release validation serves the newly generated candidate through a local Git ref", async () => {
	const sourceCommit = "fedcba9876543210fedcba9876543210fedcba98";
	const result = await validateReleaseCandidate({ sourceCommit });
	assert.equal(result.sourceCommit, sourceCommit);
	assert.match(result.releaseOid, /^[0-9a-f]{40}$/);
});
