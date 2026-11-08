import { describe, expect, it, vi } from "vitest";
import {
  searchPerson, fetchTexts, nameMatches, verifyProfiles, isPrivateUrl,
} from "../src/index.js";

const json = (o: any, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const html = (s: string, status = 200) => new Response(s, { status });

const wikiSearch = (titles: string[]) =>
  json({ query: { search: titles.map((title) => ({ title })) } });
const wikiSummary = (extract: string, title = "Linus_Torvalds") =>
  json({ extract, content_urls: { desktop: { page: `https://en.wikipedia.org/wiki/${title}` } } });

function fetchMap(map: Record<string, (u: string) => Promise<Response>>): typeof fetch {
  return (async (url: any) => {
    const u = String(url);
    for (const k of Object.keys(map)) if (u.includes(k)) return map[k](u);
    return json({});
  }) as any;
}

const wdSearch = json({ search: [{ id: "Q2205" }] });
const wdPerson = json({
  entities: {
    Q2205: {
      id: "Q2205",
      labels: { en: { value: "Linus Torvalds" } },
      claims: {
        P31: [{ mainsnak: { datavalue: { value: { id: "Q5" } } } }],
        P106: [{ mainsnak: { datavalue: { value: { id: "Q81096" } } } }],
        P2037: [{ mainsnak: { datavalue: { value: "torvalds" } } }],
        P2002: [{ mainsnak: { datavalue: { value: "LinusTorvalds" } } }],
        P569: [{ mainsnak: { datavalue: { value: { time: "+1969-12-28T00:00:00Z" } } } }],
        P26: [{ mainsnak: { datavalue: { value: { id: "Q999" } } } }],
      },
    },
  },
});
const wdLabels = json({ entities: { Q81096: { labels: { en: { value: "software engineer" } } } } });

const happyFetch = fetchMap({
  "wikipedia.org/w/api.php?action=query&list=search": async () => wikiSearch(["Linus Torvalds"]),
  "rest_v1/page/summary": async () => wikiSummary("Linus Benedict Torvalds is a Finnish-American software engineer. He created Linux."),
  wbsearchentities: async () => wdSearch,
  "wbgetentities&ids=Q2205&props=claims": async () => wdPerson,
  wbgetentities: async () => wdLabels,
  "api.github.com/search/users": async () =>
    json({ items: [{ login: "torvalds" }] }),
  "api.github.com/users/torvalds": async () =>
    json({ login: "torvalds", name: "Linus Torvalds", bio: "Kernel guy", company: "Linux Foundation",
      location: "Portland, OR", public_repos: 7, followers: 331000,
      html_url: "https://github.com/torvalds", blog: "https://kernel.org",
      twitter_username: null, email: "secret@example.com" }),
  "api.openalex.org": async () =>
    json({ results: [{ display_name: "Linus Torvalds", works_count: 5, cited_by_count: 50, id: "A1" }] }),
  "hn.algolia.com": async () =>
    json({ hits: [{ title: "Linus Torvalds on git", points: 100, objectID: "1", url: "https://x" }] }),
});

describe("searchPerson", () => {
  it("aggregates facts, handles, timings; never emits email", async () => {
    const r = await searchPerson("Linus Torvalds", { fetchFn: happyFetch });
    expect(r.facts.length).toBeGreaterThanOrEqual(4);
    expect(r.handles.github).toBe("torvalds");
    expect(r.handles.twitter).toBe("LinusTorvalds");
    expect(r.timings).toHaveLength(5);
    const all = JSON.stringify(r);
    expect(all).not.toContain("secret@example.com");
    expect(all).not.toContain("1969-12-28");
    expect(all).not.toContain("P26");
    expect(r.facts.some((f) => f.summary.includes("Occupation: software engineer"))).toBe(true);
  });

  it("rejects wrong-person Wikipedia hits", async () => {
    const f = fetchMap({
      "wikipedia.org/w/api.php?action=query&list=search": async () =>
        wikiSearch(["Torvalds (crater)", "Some Other Person"]),
      wbsearchentities: async () => json({ search: [] }),
      "api.github.com/search/users": async () => json({ items: [] }),
      "api.openalex.org": async () => json({ results: [] }),
      "hn.algolia.com": async () => json({ hits: [] }),
    });
    const r = await searchPerson("Linus Torvalds", { fetchFn: f });
    expect(r.facts.find((x) => x.source === "wikipedia")).toBeUndefined();
  });

  it("wikidata filters non-humans", async () => {
    const f = fetchMap({
      wbsearchentities: async () => json({ search: [{ id: "Q1" }] }),
      "wbgetentities&ids=Q1&props=claims": async () =>
        json({
          entities: {
            Q1: {
              id: "Q1",
              labels: { en: { value: "Linus Torvalds" } },
              claims: { P31: [{ mainsnak: { datavalue: { value: { id: "Q101352" } } } }] },
            },
          },
        }),
      "api.github.com/search/users": async () => json({ items: [] }),
      "api.openalex.org": async () => json({ results: [] }),
      "hn.algolia.com": async () => json({ hits: [] }),
    });
    const r = await searchPerson("Linus Torvalds", { fetchFn: f });
    expect(r.facts.find((x) => x.source === "wikidata")).toBeUndefined();
  });

  it("retries once on 429 then succeeds", async () => {
    let calls = 0;
    const f = (async (url: any) => {
      if (String(url).includes("list=search") && calls++ === 0)
        return json({}, 429);
      return json({ query: { search: [{ title: "Linus Torvalds" }] } });
    }) as any;
    const base = fetchMap({
      "wikipedia.org/w/api.php": f,
      "rest_v1/page/summary": async () => wikiSummary("He made Linux."),
      wbsearchentities: async () => json({ search: [] }),
      "api.github.com/search/users": async () => json({ items: [] }),
      "api.openalex.org": async () => json({ results: [] }),
      "hn.algolia.com": async () => json({ hits: [] }),
    });
    const r = await searchPerson("Linus Torvalds", { fetchFn: base });
    expect(r.facts.length).toBeGreaterThan(0);
    expect(calls).toBe(2);
  });

  it("overall deadline drops a slow source", async () => {
    const slow = fetchMap({
      "wikipedia.org": async () => { await new Promise((r) => setTimeout(r, 5000)); return json({}); },
      wbsearchentities: async () => json({ search: [] }),
      "api.github.com/search/users": async () => json({ items: [] }),
      "api.openalex.org": async () => json({ results: [] }),
      "hn.algolia.com": async () => json({ hits: [{ title: "Linus Torvalds day", points: 5, objectID: "x", url: "u" }] }),
    });
    const r = await searchPerson("Linus Torvalds", { deadlineMs: 800, fetchFn: slow });
    expect(r.ms).toBeLessThan(1600);
    expect(r.facts.some((f) => f.source === "hackernews")).toBe(true);
  });

  it("caps and dedupes facts, applies sensitive filter", async () => {
    const f = fetchMap({
      "wikipedia.org/w/api.php": async () => wikiSearch(["Linus Torvalds"]),
      "rest_v1/page/summary": async () => wikiSummary("Contact him at linus@kernel.org today. He made Linux."),
      wbsearchentities: async () => json({ search: [] }),
      "api.github.com/search/users": async () => json({ items: [{ login: "t" }] }),
      "api.github.com/users/t": async () => json({ login: "t", name: "Linus Torvalds", bio: "x", html_url: "u" }),
      "api.openalex.org": async () => json({ results: [] }),
      "hn.algolia.com": async () => json({ hits: [] }),
    });
    const r = await searchPerson("Linus Torvalds", { fetchFn: f });
    expect(r.facts.length).toBeLessThanOrEqual(12);
    expect(JSON.stringify(r)).toContain("[redacted-email]");
    expect(JSON.stringify(r)).not.toContain("linus@kernel.org");
  });
});

describe("fetchTexts + nameMatches", () => {
  it("SSRF guard rejects private hosts", async () => {
    for (const u of ["http://127.0.0.1/x", "http://10.0.0.1", "http://192.168.1.1",
      "http://172.16.0.1", "http://169.254.169.254/meta", "http://localhost", "file:///etc/passwd"])
      expect(isPrivateUrl(u)).toBe(true);
    expect(isPrivateUrl("https://en.wikipedia.org/wiki/x")).toBe(false);
    const r = await fetchTexts(["http://192.168.0.5/secret"], { fetchFn: (() => { throw new Error("should not fetch"); }) as any });
    expect(r[0].ok).toBe(false);
  });

  it("strips html and extracts title", async () => {
    const f = (async () => html("<html><head><title>Linus Torvalds - x</title></head><body><script>var a=1</script><p>Finnish engineer &amp; creator of Linux.</p></body></html>")) as any;
    const [r] = await fetchTexts(["https://example.com/p"], { fetchFn: f });
    expect(r.ok).toBe(true);
    expect(r.title).toBe("Linus Torvalds - x");
    expect(r.text).toBe("Finnish engineer & creator of Linux.");
    expect(r.text).not.toContain("var a=1");
  });

  it("nameMatches handles diacritics and window", () => {
    expect(nameMatches("Linus Torvalds", "Linus B. Torvalds is a Finnish-American engineer").matched).toBe(true);
    expect(nameMatches("Guido van Rossum", "Guido van Rossum, a Dutch programmer.").matched).toBe(true);
    expect(nameMatches("Linus Torvalds", "Torvalds is a crater on the moon").matched).toBe(false);
    expect(nameMatches("Linus Torvalds", "Linus " + "x".repeat(300) + " Torvalds").matched).toBe(false);
    expect(nameMatches("José García", "Jose Garcia presented the award").matched).toBe(true);
  });

  it("verifyProfiles splits verified vs unverified", async () => {
    const f = (async (url: any) =>
      String(url).includes("github.com/torvalds")
        ? html("<title>Linus Torvalds</title><p>Developer of Linux</p>")
        : html("<title>torvalds fan club</title><p>chess player profile</p>")) as any;
    const r = await verifyProfiles("Linus Torvalds", ["https://github.com/torvalds", "https://chess.com/torvalds"], { fetchFn: f });
    expect(r.verified.map((v) => v.url)).toEqual(["https://github.com/torvalds"]);
    expect(r.unverified).toEqual(["https://chess.com/torvalds"]);
  });
});

it("drops family-related website handles from wikidata", async () => {
  const wd = JSON.stringify(wdPerson);
  const fam = JSON.parse(wd.replace('"P2037"', '"P856"').replace('"torvalds"', '"https://torvalds-family.blogspot.com"'));
  const f = fetchMap({
    wbsearchentities: async () => wdSearch,
    "wbgetentities&ids=Q2205&props=claims": async () => fam,
    wbgetentities: async () => wdLabels,
    "api.github.com/search/users": async () => json({ items: [] }),
    "api.openalex.org": async () => json({ results: [] }),
    "hn.algolia.com": async () => json({ hits: [] }),
  });
  const r = await searchPerson("Linus Torvalds", { fetchFn: f });
  expect(r.handles.website).toBeUndefined();
});

it("sensitive filter keeps year ranges, redacts phones", async () => {
  const { filterSensitive } = await import("../src/sensitive.js");
  expect(filterSensitive("(2008-2022)")).toContain("(2008-2022)");
  expect(filterSensitive("1991–present")).toContain("1991");
  expect(filterSensitive("+1 (415) 555-0132")).toContain("[redacted-phone]");
  expect(filterSensitive("415-555-0132")).toContain("[redacted-phone]");
});
