import http from "node:http";

export function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hello\n");
    return;
  }
  if (req.method === "GET" && url.pathname === "/sum") {
    const a = url.searchParams.get("a");
    const b = url.searchParams.get("b");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sum: a + b }));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found\n");
}

export const createServer = () => http.createServer(handle);
