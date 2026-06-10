import { describe, test, expect } from "@jest/globals";
import {
  isUpdatePost,
  parseTootContent,
  clusterToots,
  type ClusterableToot,
} from "./tootClustering.js";

function makeToot(
  opts: Partial<ClusterableToot> & { id: string; tokens: string[] }
): ClusterableToot {
  return {
    id: opts.id,
    plainText: opts.plainText ?? `Toot ${opts.id}`,
    tokens: new Set(opts.tokens),
    createdAt: opts.createdAt ?? new Date("2026-06-01T10:00:00Z"),
    hasInteractions: opts.hasInteractions ?? false,
  };
}

const DEFAULT_OPTS = {
  threshold: 0.4,
  timeWindowHours: 24,
  maxClusterSize: 4,
};

describe("isUpdatePost", () => {
  test("detects feed-tooter quote post prefix", () => {
    expect(isUpdatePost("🔗 Update: Brand in Saarbrücken unter Kontrolle")).toBe(
      true
    );
  });

  test("detects multi-source quote post prefix", () => {
    expect(
      isUpdatePost("🔗 Update (📍2 Quellen): Brand in Saarbrücken")
    ).toBe(true);
  });

  test("detects legacy fixer reply prefix", () => {
    expect(isUpdatePost("Update:\nhttps://example.com/artikel")).toBe(true);
  });

  test("does not flag headlines merely containing 'Update'", () => {
    expect(isUpdatePost("Updates für Saarbahn-App geplant")).toBe(false);
    expect(isUpdatePost("Stadt kündigt Update der Webseite an")).toBe(false);
  });

  test("does not flag normal headlines", () => {
    expect(isUpdatePost("Brand in Saarbrücken: Feuerwehr im Einsatz")).toBe(
      false
    );
  });
});

describe("parseTootContent", () => {
  test("strips html, extracts headline tokens and links", () => {
    const parsed = parseTootContent(
      '<p>Unfall auf der A8 bei Neunkirchen</p><p>Quellen:<br>saarnews: <a href="https://saarnews.com/unfall-a8">https://saarnews.com/unfall-a8</a></p>'
    );
    expect(parsed.headline).toBe("Unfall auf der A8 bei Neunkirchen");
    expect(parsed.tokens.has("unfall")).toBe(true);
    expect(parsed.tokens.has("neunkirchen")).toBe(true);
    expect(parsed.links).toContain("https://saarnews.com/unfall-a8");
  });

  test("headline excludes hashtags and urls", () => {
    const parsed = parseTootContent(
      "<p>Brand in Völklingen #SaarlandNews https://example.com/brand</p>"
    );
    expect(parsed.headline).toBe("Brand in Völklingen");
  });

  test("strips nested obfuscated tags", () => {
    const parsed = parseTootContent(
      "<p>Brand <scr<script>ipt>alert(1)</scr</script>ipt> in Saarlouis</p>"
    );
    expect(parsed.plainText).not.toContain("<script");
    expect(parsed.plainText).not.toContain("</script");
  });

  test("strips tags that only appear after entity unescaping", () => {
    const parsed = parseTootContent(
      "<p>Brand in Saarlouis &lt;script&gt;alert(1)&lt;/script&gt; gelöscht</p>"
    );
    expect(parsed.plainText).not.toContain("<script");
    expect(parsed.plainText).not.toContain("</script>");
    expect(parsed.headline).toContain("Brand in Saarlouis");
  });

  test("links exclude mastodon status urls", () => {
    const parsed = parseTootContent(
      "<p>Test https://mastodon.social/@bot/123 https://news.example.com/a</p>"
    );
    expect(parsed.links).toEqual(["https://news.example.com/a"]);
  });
});

describe("clusterToots", () => {
  test("does NOT chain transitively: C similar to B but not to primary A stays out", () => {
    // sim(A,B) = 3/5 = 0.6, sim(B,C) = 3/5 = 0.6, sim(A,C) = 2/6 = 0.33
    // Old union-find clustered all three; primary-anchored must only keep A+B.
    const a = makeToot({
      id: "a",
      tokens: ["unfall", "autobahn", "neunkirchen", "lkw"],
      createdAt: new Date("2026-06-01T08:00:00Z"),
    });
    const b = makeToot({
      id: "b",
      tokens: ["unfall", "autobahn", "neunkirchen", "stau"],
      createdAt: new Date("2026-06-01T09:00:00Z"),
    });
    const c = makeToot({
      id: "c",
      tokens: ["stau", "autobahn", "neunkirchen", "sperrung"],
      createdAt: new Date("2026-06-01T10:00:00Z"),
    });

    const clusters = clusterToots([a, b, c], DEFAULT_OPTS);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].primary.id).toBe("a");
    expect(clusters[0].duplicates.map((d) => d.id)).toEqual(["b"]);
  });

  test("oldest toot becomes primary even when input is unsorted", () => {
    const newer = makeToot({
      id: "newer",
      tokens: ["brand", "feuerwehr", "saarlouis"],
      createdAt: new Date("2026-06-01T12:00:00Z"),
    });
    const older = makeToot({
      id: "older",
      tokens: ["brand", "feuerwehr", "saarlouis"],
      createdAt: new Date("2026-06-01T08:00:00Z"),
    });

    const clusters = clusterToots([newer, older], DEFAULT_OPTS);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].primary.id).toBe("older");
    expect(clusters[0].duplicates.map((d) => d.id)).toEqual(["newer"]);
  });

  test("update posts are never clustered (neither as primary nor duplicate)", () => {
    const original = makeToot({
      id: "orig",
      tokens: ["brand", "feuerwehr", "saarlouis"],
      plainText: "Brand in Saarlouis",
    });
    const updateQuote = makeToot({
      id: "upd",
      tokens: ["brand", "feuerwehr", "saarlouis"],
      plainText: "🔗 Update: Brand in Saarlouis gelöscht",
    });
    const legacyReply = makeToot({
      id: "legacy",
      tokens: ["brand", "feuerwehr", "saarlouis"],
      plainText: "Update:\nhttps://example.com/brand",
    });

    const clusters = clusterToots(
      [original, updateQuote, legacyReply],
      DEFAULT_OPTS
    );

    expect(clusters).toHaveLength(0);
  });

  test("respects maxClusterSize: overflow starts a new cluster", () => {
    const tokens = ["unwetter", "warnung", "saarland"];
    const toots = Array.from({ length: 4 }, (_, i) =>
      makeToot({
        id: `t${i}`,
        tokens,
        createdAt: new Date(`2026-06-01T0${i + 1}:00:00Z`),
      })
    );

    const clusters = clusterToots(toots, { ...DEFAULT_OPTS, maxClusterSize: 2 });

    expect(clusters).toHaveLength(2);
    for (const cluster of clusters) {
      expect(1 + cluster.duplicates.length).toBeLessThanOrEqual(2);
    }
  });

  test("respects time window relative to primary", () => {
    const a = makeToot({
      id: "a",
      tokens: ["brand", "feuerwehr", "saarlouis"],
      createdAt: new Date("2026-06-01T00:00:00Z"),
    });
    const b = makeToot({
      id: "b",
      tokens: ["brand", "feuerwehr", "saarlouis"],
      createdAt: new Date("2026-06-02T06:00:00Z"), // 30h later
    });

    const clusters = clusterToots([a, b], DEFAULT_OPTS);

    expect(clusters).toHaveLength(0);
  });

  test("skips clusters where any toot has interactions", () => {
    const a = makeToot({
      id: "a",
      tokens: ["brand", "feuerwehr", "saarlouis"],
    });
    const b = makeToot({
      id: "b",
      tokens: ["brand", "feuerwehr", "saarlouis"],
      hasInteractions: true,
    });

    const clusters = clusterToots([a, b], DEFAULT_OPTS);

    expect(clusters).toHaveLength(0);
  });

  test("sorts clusters by average similarity, highest first", () => {
    const looseA = makeToot({
      id: "looseA",
      tokens: ["polizei", "zeugen", "saarbrücken", "einbruch", "nacht"],
      createdAt: new Date("2026-06-01T08:00:00Z"),
    });
    const looseB = makeToot({
      id: "looseB",
      tokens: ["polizei", "zeugen", "saarbrücken", "diebstahl", "auto"],
      createdAt: new Date("2026-06-01T09:00:00Z"),
    });
    const tightA = makeToot({
      id: "tightA",
      tokens: ["brand", "feuerwehr", "saarlouis"],
      createdAt: new Date("2026-06-01T08:00:00Z"),
    });
    const tightB = makeToot({
      id: "tightB",
      tokens: ["brand", "feuerwehr", "saarlouis"],
      createdAt: new Date("2026-06-01T09:00:00Z"),
    });

    const clusters = clusterToots(
      [looseA, looseB, tightA, tightB],
      DEFAULT_OPTS
    );

    expect(clusters).toHaveLength(2);
    expect(clusters[0].primary.id).toBe("tightA");
    expect(clusters[0].avgSimilarity).toBeGreaterThan(
      clusters[1].avgSimilarity
    );
  });

  test("returns empty for empty input", () => {
    expect(clusterToots([], DEFAULT_OPTS)).toEqual([]);
  });
});
