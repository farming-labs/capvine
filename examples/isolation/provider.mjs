import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const { token } = JSON.parse(await readFile("/provider/config.json", "utf8"));
const server = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end();
    return;
  }
  if (request.method !== "GET" || request.url !== "/records/fixed") {
    response.writeHead(404).end();
    return;
  }
  response
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ id: "fixed", title: "Isolated provider result" }));
});
server.listen(8080, "0.0.0.0");
process.once("SIGTERM", () => server.close());
