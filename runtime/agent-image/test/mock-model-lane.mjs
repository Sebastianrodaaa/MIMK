import http from "node:http";
// Scripted: search_person -> GUI attempt (should be blocked) -> batched fetch+notes -> username -> note -> done
const steps = [
  { action: "search_person", name: "Linus Torvalds" },
  { action: "launch", url: "https://en.wikipedia.org" },          // GUI attempt — expect blocked
  { actions: [
    { action: "fetch", urls: ["https://en.wikipedia.org/wiki/Linus_Torvalds", "https://github.com/torvalds"] },
    { action: "note", sourceUrl: "https://en.wikipedia.org/wiki/Linus_Torvalds", summary: "Linus Torvalds is a Finnish-American software engineer who created the Linux kernel." },
  ]},
  { action: "username", handle: "torvalds", name: "Linus Torvalds" },
  { action: "note", sourceUrl: "https://github.com/torvalds", summary: "GitHub torvalds is Linus Torvalds's official account (Linux Foundation)." },
  { action: "done", summary: "Too early — should be rejected" },
  { action: "done", summary: "Lane test complete: lane + batched notes + structured done.", findings: [
    { sourceUrl: "https://en.wikipedia.org/wiki/Linus_Torvalds", summary: "Linus Torvalds created the Linux kernel in 1991." },
    { sourceUrl: "https://github.com/torvalds", summary: "His GitHub account is torvalds, employed by the Linux Foundation." },
    { sourceUrl: "https://en.wikipedia.org/wiki/Linus_Torvalds", summary: "He also created Git in 2005." },
    { sourceUrl: "https://kernel.org", summary: "He maintains the kernel at kernel.org." },
    { sourceUrl: "https://www.wikidata.org/wiki/Q34253", summary: "Occupation: programmer, software developer, writer, inventor." },
  ]},
];
let i = 0;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const action = steps[Math.min(i++, steps.length - 1)];
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: JSON.stringify(action) } }],
    }));
  });
});
server.listen(Number(process.env.MOCK_PORT ?? 8787), () => console.log("mock up"));
