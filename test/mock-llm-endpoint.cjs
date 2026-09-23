// 手动验证用 mock OpenAI 兼容端点：/models + /chat/completions（SSE 流式）。
// 第一次 chat 调用返回 write 工具调用（让 pi 真实执行建文件），之后返回文本。
// 运行：node test/mock-llm-endpoint.cjs [port]   （默认 3501）
const http = require("node:http");
const port = Number(process.argv[2]) || 3501;
const models = [
  { id: "mock-mini", name: "Mock Mini", context_length: 65536, max_tokens: 8192 },
  { id: "mock-pro", context_window: 200000, max_output_tokens: 32768 },
  "mock-plain",
];
let chatPhase = 0; // 0 = 回工具调用（建 diff-test.txt），之后 = 回文本

http.createServer((req, res) => {
  if (req.method === "GET" && req.url.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: models }));
    return;
  }
  if (req.method === "POST" && req.url.endsWith("/chat/completions")) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    let chunks;
    if (chatPhase === 0) {
      chatPhase = 1;
      const args = JSON.stringify({
        path: "D:/dshpi/config/.pi-web/diff-test.txt",
        content: "hello diff\nsecond line\n",
      });
      chunks = [
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "write", arguments: "" } }] } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: {} }),
      ];
    } else {
      chunks = ["已完成：diff-test.txt 已创建。"];
    }
    let i = 0;
    const timer = setInterval(() => {
      if (i < chunks.length) {
        res.write(`data: ${JSON.stringify({ id: "mock", choices: [{ delta: chunks[i].includes("tool_calls") ? JSON.parse(chunks[i]).choices[0].delta : { content: chunks[i] } }] })}\n\n`);
        i += 1;
        return;
      }
      res.write(`data: ${JSON.stringify({ id: "mock", choices: [{ delta: {}, finish_reason: chatPhase === 1 ? "tool_calls" : "stop" }], usage: {} })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      clearInterval(timer);
    }, 120);
    req.on("close", () => clearInterval(timer));
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(port, "127.0.0.1", () => console.log(`mock llm endpoint → http://127.0.0.1:${port}/v1`));
