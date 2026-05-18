import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requestedPort = Number.parseInt(process.env.PORT || "4173", 10);
const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".sf2", "application/octet-stream"]
]);

function createServer(port) {
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url, `http://127.0.0.1:${port}`);
    const safePath = path.normalize(decodeURIComponent(requestUrl.pathname)).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(root, safePath === "/" ? "demo/index.html" : safePath);

    if (!filePath.startsWith(root)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    fs.readFile(filePath, (error, data) => {
      if (error) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }

      response.writeHead(200, {
        "content-type": mimeTypes.get(path.extname(filePath)) || "application/octet-stream"
      });
      response.end(data);
    });
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE" && port < requestedPort + 20) {
      createServer(port + 1);
      return;
    }
    throw error;
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`Demo: http://127.0.0.1:${port}/demo/index.html`);
  });
}

createServer(requestedPort);
