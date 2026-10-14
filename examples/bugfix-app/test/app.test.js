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

test("GET / says hello", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "hello\n");
});

test("unknown paths are 404", async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
});
