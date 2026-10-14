import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "../src/app.js";

let server;
let base;
before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

// Shows the bug: /sum?a=1&b=2 answers {"sum":"12"}.
test("GET /sum adds two numbers", async () => {
  const res = await fetch(`${base}/sum?a=1&b=2`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { sum: 3 });
});
