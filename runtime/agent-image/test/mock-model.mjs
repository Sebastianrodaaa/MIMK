import http from "node:http";

const steps = [
  { action: "launch", url: "https://en.wikipedia.org/wiki/Main_Page" },
  { action: "note", sourceUrl: "https://en.wikipedia.org/wiki/Main_Page", summary: "Opened Wikipedia — reachable and rendering." },
  { action: "note", sourceUrl: "https://news.ycombinator.com", summary: "Hacker News front page loads; subject has no obvious presence." },
  { action: "note", sourceUrl: "https://github.com/explore", summary: "GitHub explore reachable; no matching profile found." },
  { action: "done", summary: "Smoke test complete: launch + 3 notes + done executed." },
];
let i = 0;
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const action = steps[Math.min(i++, steps.length - 1)];
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: JSON.stringify(action) } }],
    }));
  });
}).listen(8899, () => console.log("mock model on :8899"));
