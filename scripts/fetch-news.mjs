// Fetches Delhi/NCR property + property-law news from all configured sources,
// dedupes and sorts them, and writes the result to docs/news.json.
// Runs server-side (Node, via GitHub Actions cron) — no browser, no CORS proxy needed.

import { XMLParser } from "fast-xml-parser";
import { writeFile, mkdir } from "fs/promises";
import path from "path";

const parser = new XMLParser({ ignoreAttributes: false });

function gnews(q) {
  return "https://news.google.com/rss/search?q=" + encodeURIComponent(q) + "&hl=en-IN&gl=IN&ceid=IN:en";
}

// LAYER 1 — every single item, from every source, must contain at least one of these.
// This is what actually stops crime/politics/sport stories that merely mention "Delhi"
// from getting through: a bare place name is never enough on its own.
const PROPERTY_KEYWORDS = [
  "property", "real estate", "realty", "flat", "apartment", "housing scheme",
  "builder", "plot", "land parcel", "lease deed", "rent agreement",
  "tenant", "landlord", "sale deed", "conveyance", "mutation",
  "freehold", "leasehold", "rera", "immovable property", "possession of flat",
  "residential project", "commercial project", "circle rate", "stamp duty",
  "sub-registrar", "sub registrar", "transfer duty", "transfer of property",
  "tds", "gpra", "7gpra", "redevelopment", "registry office", "allotment of flat",
  "dda housing", "dda flat", "dda scheme",
];

// LAYER 2 — for categories that are specifically meant to be Delhi/NCR-located
// (as opposed to national legal doctrine or national market commentary), the item
// must ALSO contain an actual Delhi/NCR place name. This is what stops a Mumbai or
// Bangalore story from being mislabeled as "Delhi" just because Google's search
// loosely matched it.
const LOCATION_KEYWORDS = [
  "delhi", "ncr", "noida", "gurugram", "gurgaon", "ghaziabad", "faridabad",
  "dda", "l&do", "mcd", "dwarka", "rohini", "saket", "dlf",
  "greater noida", "yeida", "new gurgaon",
];

// Categories where a Delhi/NCR place name is mandatory, not just a bonus.
const LOCATION_REQUIRED_CATEGORIES = new Set(["delhi", "ncr", "registry", "policy"]);

function hasAny(hay, list) {
  return list.some((k) => hay.includes(k));
}

function isRelevant(text, category) {
  const hay = text.toLowerCase();
  if (!hasAny(hay, PROPERTY_KEYWORDS)) return false;
  if (LOCATION_REQUIRED_CATEGORIES.has(category) && !hasAny(hay, LOCATION_KEYWORDS)) return false;
  return true;
}

const SOURCES = [
  // --- Legal & courts: LiveLaw, Bar & Bench, Verdictum + property-law doctrine keywords ---
  // (national in scope on purpose — case law on TDS/transfer of property isn't Delhi-only)
  { name: "Legal press", url: gnews("(site:livelaw.in OR site:barandbench.com) property"), category: "legal" },
  { name: "Legal press", url: gnews("site:verdictum.in property"), category: "legal" },
  { name: "Legal press", url: gnews('"transfer of property"'), category: "legal" },
  { name: "Legal press", url: gnews("TDS property"), category: "legal" },
  { name: "Legal press", url: gnews('GPRA delhi OR "7GPRA"'), category: "legal" },
  { name: "Legal press", url: gnews("allotment of flats redevelopment delhi"), category: "legal" },

  // --- Circle rate, stamp duty, registry (Delhi-specific) ---
  { name: "Registry & duties", url: gnews('"circle rate" delhi'), category: "registry" },
  { name: "Registry & duties", url: gnews('"stamp duty" delhi'), category: "registry" },
  { name: "Registry & duties", url: gnews('"sub registrar" delhi'), category: "registry" },
  { name: "Registry & duties", url: gnews('"transfer duty" delhi'), category: "registry" },

  // --- Delhi property market ---
  { name: "Delhi property", url: gnews('"property" "delhi" ("buy" OR "sell")'), category: "delhi" },
  { name: "Delhi property", url: gnews('"residential project" delhi'), category: "delhi" },
  { name: "Delhi property", url: gnews('(site:timesofindia.indiatimes.com OR site:hindustantimes.com) "real estate" delhi'), category: "delhi" },
  { name: "Delhi property", url: gnews('site:thehindu.com "real estate" delhi'), category: "delhi" },

  // --- NCR: Noida, Gurugram, Ghaziabad, Faridabad, Yeida ---
  { name: "NCR property", url: gnews('yeida property OR housing OR plot'), category: "ncr" },
  { name: "NCR property", url: gnews('(site:magicbricks.com OR site:99acres.com) "delhi ncr" real estate'), category: "ncr" },
  { name: "NCR property", url: gnews('(site:housing.com OR site:cnbctv18.com) "delhi ncr" real estate'), category: "ncr" },
  { name: "NCR property", url: gnews('noida gurugram ghaziabad faridabad "real estate"'), category: "ncr" },

  // --- RERA & policy (Delhi/NCR specific) ---
  { name: "RERA & Policy", url: gnews("RERA delhi ncr"), category: "policy" },

  // --- Market & industry (business press — intentionally national in scope) ---
  { name: "Market & industry", url: gnews('(site:moneycontrol.com OR site:livemint.com) "real estate" india'), category: "market" },
  { name: "Market & industry", url: gnews('(site:financialexpress.com OR site:thehindubusinessline.com) "real estate" india'), category: "market" },
  { name: "Market & industry", url: gnews('(site:bloomberg.com OR site:outlookmoney.com) "real estate" india'), category: "market" },
  { name: "Market & industry", url: gnews('(site:rediff.com OR site:news24online.com) "real estate"'), category: "market" },
  { name: "Market & industry", url: gnews("site:economictimes.indiatimes.com property transactions"), category: "market" },
  { name: "Market & industry", url: gnews("site:realty.economictimes.indiatimes.com delhi ncr"), category: "market" },

  // --- ET Realty direct RSS feeds (national — filtered by the two-layer check like everything else) ---
  { name: "ET Realty · Residential", url: "https://realty.economictimes.indiatimes.com/rss/residential", category: "market" },
  { name: "ET Realty · Regulatory", url: "https://realty.economictimes.indiatimes.com/rss/regulatory", category: "policy" },
  { name: "ET Realty · Infrastructure", url: "https://realty.economictimes.indiatimes.com/rss/infrastructure", category: "ncr" },
  { name: "ET Realty · Commercial", url: "https://realty.economictimes.indiatimes.com/rss/commercial", category: "market" },
  { name: "ET Realty · Top Stories", url: "https://realty.economictimes.indiatimes.com/rss/topstories", category: "market" },
];

function toArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function stripHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function splitSource(title) {
  const idx = title.lastIndexOf(" - ");
  if (idx > title.length - 40 && idx > 0) {
    return { title: title.slice(0, idx).trim(), src: title.slice(idx + 3).trim() };
  }
  return { title: title.trim(), src: "" };
}

function extractLink(link) {
  if (typeof link === "string") return link;
  if (link && typeof link === "object") return link["#text"] || link["@_href"] || "#";
  return "#";
}

async function fetchOne(source) {
  try {
    const res = await fetch(source.url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; DelhiPropertyPulse/1.0; +https://github.com/)" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error("status " + res.status);
    const text = await res.text();
    const parsed = parser.parse(text);
    const items = toArray(parsed?.rss?.channel?.item);

    return items
      .map((item) => {
        const rawTitle = String(item.title ?? "").trim();
        const { title, src } = splitSource(rawTitle);
        const desc = stripHtml(item.description);
        return {
          title: title || rawTitle,
          link: extractLink(item.link),
          pubDate: item.pubDate || "",
          description: desc.length > 220 ? desc.slice(0, 217) + "…" : desc,
          sourceName: src || source.name,
          category: source.category,
        };
      })
      .filter((it) => isRelevant(it.title + " " + it.description, it.category));
  } catch (e) {
    console.warn("Feed failed:", source.name, "|", source.url, "|", e.message);
    return [];
  }
}

async function main() {
  console.log(`Fetching ${SOURCES.length} sources…`);
  const results = await Promise.allSettled(SOURCES.map(fetchOne));
  let items = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));

  const seen = new Set();
  items = items.filter((it) => {
    const key = it.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  items = items.slice(0, 150);

  const out = { generatedAt: new Date().toISOString(), count: items.length, items };
  await mkdir(path.dirname("docs/news.json"), { recursive: true });
  await writeFile("docs/news.json", JSON.stringify(out, null, 2));
  console.log(`Wrote ${items.length} items to docs/news.json`);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
