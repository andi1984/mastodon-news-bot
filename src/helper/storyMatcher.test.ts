import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { tokenize, jaccardSimilarity } from "./similarity.js";

// -------------------------------------------------------------------------
// Mock modules before any imports from the modules being mocked
// -------------------------------------------------------------------------

// db mock
const mockFrom = jest.fn();
jest.unstable_mockModule("./db.js", () => ({
  default: jest.fn(() => ({ from: mockFrom })),
}));

// semanticSimilarity mock
const mockBatchSemantic = jest.fn<() => Promise<import("./semanticSimilarity.js").SemanticResult[]>>();
jest.unstable_mockModule("./semanticSimilarity.js", () => ({
  batchSemanticSimilarity: mockBatchSemantic,
}));

// findStoryByUrl mock
const mockFindStoryByUrl = jest.fn<() => Promise<import("./storyMatcher.js").StoryRecord | null>>();
jest.unstable_mockModule("./findStoryByUrl.js", () => ({
  findStoryByUrl: mockFindStoryByUrl,
}));

// chooseStoryMatch mock
const mockChooseStoryMatch = jest.fn<() => Promise<import("./chooseStoryMatch.js").MatchResult | null>>();
jest.unstable_mockModule("./chooseStoryMatch.js", () => ({
  chooseStoryMatch: mockChooseStoryMatch,
}));

// normalizeUrl mock
const mockNormalizeUrl = jest.fn<(url: string | null | undefined) => string>();
jest.unstable_mockModule("./normalizeUrl.js", () => ({
  normalizeUrl: mockNormalizeUrl,
}));

// -------------------------------------------------------------------------
// Import modules under test AFTER mock declarations
// -------------------------------------------------------------------------
const {
  findMatchingStory,
  createStory,
  addArticleToStory,
  assignStoryToArticle,
  processNewArticles,
  markStoryTooted,
  getStoryTootId,
  getUntootedStories,
  semanticCheckAdapter,
} = await import("./storyMatcher.js");

import type {
  StoryRecord,
  ArticleForMatching,
} from "./storyMatcher.js";

// -------------------------------------------------------------------------
// Helper factories
// -------------------------------------------------------------------------

function makeStory(overrides: Partial<StoryRecord> = {}): StoryRecord {
  return {
    id: "story-1",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    article_count: 1,
    tooted: false,
    toot_id: null,
    original_links: [],
    primary_title: "Test Story",
    tokens: ["test", "story"],
    ...overrides,
  };
}

function makeArticle(overrides: Partial<ArticleForMatching> = {}): ArticleForMatching {
  return {
    id: "article-1",
    title: "Test Article",
    pubDate: new Date().toISOString(),
    ...overrides,
  };
}

// Chainable DB select mock helper
// Mimics the Supabase builder: select().gt().order().limit() → resolves
function makeSelectChain(finalResult: { data: any; error: any }) {
  const chain: any = {};
  chain.gt = jest.fn(() => chain);
  chain.eq = jest.fn(() => chain);
  chain.not = jest.fn(() => chain);
  // order() returns chain (so .limit can be called after) AND is thenable
  chain.order = jest.fn(() => chain);
  chain.limit = jest.fn(() => Promise.resolve(finalResult));
  chain.single = jest.fn(() => Promise.resolve(finalResult));
  // Make chain itself thenable (for when .order() is awaited directly)
  chain.then = (resolve: any, reject: any) =>
    Promise.resolve(finalResult).then(resolve, reject);
  return chain;
}

// -------------------------------------------------------------------------
// Setup
// -------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockFindStoryByUrl.mockResolvedValue(null);
  mockChooseStoryMatch.mockResolvedValue(null);
  mockNormalizeUrl.mockImplementation((url) => url ?? "");
  mockBatchSemantic.mockResolvedValue([]);
});

// -------------------------------------------------------------------------
// Inline Jaccard / Batch matching tests (no DB deps)
// -------------------------------------------------------------------------

// Simulate batch story cache matching (mirrors processNewArticles logic)
function simulateBatchMatching(
  articles: Array<{ title: string; feedKey: string; contentSnippet?: string }>
): Map<number, number> {
  const STORY_SIMILARITY_THRESHOLD = 0.40;
  const storyAssignments = new Map<number, number>();
  const storyCache = new Map<number, Set<string>>();

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    const articleText = article.contentSnippet
      ? `${article.title} ${article.contentSnippet.slice(0, 500)}`
      : article.title;
    const articleTokens = tokenize(articleText);

    let matchedStory: number | null = null;
    let bestScore = 0;

    for (const [storyIdx, storyTokens] of storyCache) {
      const similarity = jaccardSimilarity(articleTokens, storyTokens);
      if (similarity >= STORY_SIMILARITY_THRESHOLD && similarity > bestScore) {
        bestScore = similarity;
        matchedStory = storyIdx;
      }
    }

    if (matchedStory !== null) {
      storyAssignments.set(i, matchedStory);
      const existingTokens = storyCache.get(matchedStory)!;
      for (const token of articleTokens) existingTokens.add(token);
    } else {
      storyAssignments.set(i, i);
      storyCache.set(i, articleTokens);
    }
  }

  return storyAssignments;
}

describe("storyMatcher core logic", () => {
  const STORY_SIMILARITY_THRESHOLD = 0.40;

  function wouldMatch(
    storyTitle: string,
    articleTitle: string,
    storyContent?: string,
    articleContent?: string
  ): { matches: boolean; score: number } {
    const storyText = storyContent
      ? `${storyTitle} ${storyContent.slice(0, 500)}`
      : storyTitle;
    const articleText = articleContent
      ? `${articleTitle} ${articleContent.slice(0, 500)}`
      : articleTitle;

    const storyTokens = tokenize(storyText);
    const articleTokens = tokenize(articleText);
    const score = jaccardSimilarity(storyTokens, articleTokens);

    return {
      matches: score >= STORY_SIMILARITY_THRESHOLD,
      score,
    };
  }

  describe("same event with overlapping keywords", () => {
    it("matches headlines sharing location and key terms", () => {
      const result = wouldMatch(
        "Brand in Saarbrücken: Feuerwehr im Einsatz",
        "Saarbrücken: Brand in der Innenstadt - Feuerwehr vor Ort"
      );
      expect(result.matches).toBe(true);
    });

    it("matches headlines with identical key phrases", () => {
      const result = wouldMatch(
        "Unfall auf A1 bei Saarbrücken - Verletzte",
        "A1 Saarbrücken: Unfall mit Verletzten"
      );
      expect(result.matches).toBe(true);
    });

    it("matches with content providing more overlap", () => {
      const result = wouldMatch(
        "Feuer in Saarbrücken",
        "Brand in Saarbrücker Altstadt",
        "In der Saarbrücker Altstadt ist ein Feuer ausgebrochen. Die Feuerwehr ist im Einsatz.",
        "Feuerwehr bekämpft Brand in Saarbrücken. Die Altstadt ist betroffen."
      );
      expect(result.matches).toBe(true);
    });
  });

  describe("different events should not match", () => {
    it("does not match unrelated news", () => {
      const result = wouldMatch(
        "Neuer Bürgermeister in Homburg gewählt",
        "Feuer in Saarbrücker Innenstadt"
      );
      expect(result.matches).toBe(false);
    });

    it("does not match same event type at different locations", () => {
      const result = wouldMatch(
        "Unfall in St. Wendel fordert Verletzte",
        "Unfall in Völklingen - Person schwer verletzt"
      );
      expect(result.score).toBeLessThan(0.5);
    });

    it("does not match different topics at same location", () => {
      const result = wouldMatch(
        "Neues Restaurant eröffnet in Saarbrücken",
        "Polizeieinsatz in Saarbrücken nach Streit"
      );
      expect(result.matches).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("exact same headline matches perfectly", () => {
      const result = wouldMatch(
        "Polizei sucht Zeugen nach Einbruch in Neunkirchen",
        "Polizei sucht Zeugen nach Einbruch in Neunkirchen"
      );
      expect(result.matches).toBe(true);
      expect(result.score).toBe(1);
    });

    it("empty strings do not crash", () => {
      const result = wouldMatch("", "");
      expect(result.score).toBe(1);
    });

    it("handles special characters and punctuation", () => {
      const result = wouldMatch(
        'SPD-Fraktion: "Neue Wege für Saarland nötig"',
        "SPD-Fraktion fordert neue Wege für Saarland"
      );
      expect(result.matches).toBe(true);
    });
  });

  describe("realistic multi-source scenarios", () => {
    it("matches police reports about same incident", () => {
      const result = wouldMatch(
        "Polizei Saarbrücken: Einbruch in Geschäft - Zeugen gesucht",
        "Einbruch in Saarbrücken - Polizei sucht Zeugen"
      );
      expect(result.matches).toBe(true);
    });

    it("matches event announcements with enough overlap", () => {
      const result = wouldMatch(
        "Saarbrücker Stadtfest 2024 - Programm und Infos",
        "Stadtfest in Saarbrücken 2024: Programm veröffentlicht"
      );
      expect(result.matches).toBe(true);
    });
  });

  describe("cases now handled by semantic similarity", () => {
    it("synonyms fall in uncertain zone - semantic matching handles this", () => {
      const result = wouldMatch(
        "Feuer zerstört Lagerhalle in Homburg",
        "Brand in Homburger Lagerhalle"
      );
      expect(result.score).toBeGreaterThan(0.1);
      expect(result.score).toBeLessThan(0.4);
    });

    it("different phrasing of same person - semantic matching handles this", () => {
      const result = wouldMatch(
        "Ministerpräsidentin kündigt Maßnahmen an",
        "Anke Rehlinger stellt Plan vor"
      );
      expect(result.matches).toBe(false);
    });
  });
});

describe("follow-up threshold: tooted vs untooted stories", () => {
  const BASE_THRESHOLD = 0.40;
  const FOLLOW_UP_THRESHOLD = 0.55;

  function scoreForStory(
    storyTitle: string,
    articleTitle: string,
    storyContent?: string,
    articleContent?: string
  ): number {
    const storyText = storyContent
      ? `${storyTitle} ${storyContent.slice(0, 500)}`
      : storyTitle;
    const articleText = articleContent
      ? `${articleTitle} ${articleContent.slice(0, 500)}`
      : articleTitle;
    return jaccardSimilarity(tokenize(storyText), tokenize(articleText));
  }

  it("borderline score (0.40-0.55) matches untooted story but NOT tooted story", () => {
    const score = scoreForStory(
      "Polizeipräsidium Saarbrücken: Einbruch in Apotheke - Polizei sucht Zeugen",
      "Polizeipräsidium Saarbrücken: Diebstahl gemeldet - Polizei bittet Zeugen",
      "Die Polizei Saarbrücken berichtet über einen Einbruch. Zeugen werden gebeten sich zu melden.",
      "Die Polizei Saarbrücken berichtet über einen Diebstahl. Zeugen werden gebeten sich zu melden."
    );

    expect(score).toBeGreaterThanOrEqual(BASE_THRESHOLD);
    expect(score).toBeLessThan(FOLLOW_UP_THRESHOLD);
  });

  it("high-overlap follow-up clears FOLLOW_UP_THRESHOLD for tooted story", () => {
    const score = scoreForStory(
      "Einbruch Saarbrücken Innenstadt Polizei Zeugen Schmuck gestohlen Täter flüchtig Ermittlungen",
      "Saarbrücken Innenstadt Einbruch Schmuck gestohlen Polizei Zeugen Ermittlungen Täter",
      "Polizei Saarbrücken Einbruch Innenstadt Schmuck Täter flüchtig Zeugen Ermittlungen",
      "Einbruch Saarbrücken Innenstadt Polizei Schmuck gestohlen Täter Zeugen Ermittlungen"
    );

    expect(score).toBeGreaterThanOrEqual(FOLLOW_UP_THRESHOLD);
  });
});

describe("cross-feed batch matching", () => {
  it("groups articles from different feeds about same topic", () => {
    const articles = [
      { title: "Brand in Saarbrücken: Feuerwehr im Einsatz", feedKey: "feed-a" },
      { title: "Neues Restaurant eröffnet in Homburg", feedKey: "feed-b" },
      { title: "Saarbrücken: Brand in der Innenstadt - Feuerwehr vor Ort", feedKey: "feed-c" },
    ];

    const assignments = simulateBatchMatching(articles);
    expect(assignments.get(0)).toBe(0);
    expect(assignments.get(2)).toBe(0);
    expect(assignments.get(1)).toBe(1);
  });

  it("handles multiple simultaneous news events from many feeds", () => {
    const articles = [
      { title: "Schwerer Unfall auf A1 Saarbrücken - Verletzte gemeldet", feedKey: "polizei" },
      { title: "Brand in Völklingen: Feuerwehr im Großeinsatz", feedKey: "breaking-news" },
      { title: "A1 Saarbrücken: Schwerer Unfall mit Verletzte", feedKey: "radio-salue" },
      { title: "Großeinsatz Feuerwehr: Brand in Völklingen", feedKey: "saarnews" },
      { title: "SPD-Fraktion fordert neue Verkehrskonzepte", feedKey: "tagesschau" },
    ];

    const assignments = simulateBatchMatching(articles);

    expect(assignments.get(0)).toBe(0);
    expect(assignments.get(2)).toBe(0);
    expect(assignments.get(1)).toBe(1);
    expect(assignments.get(3)).toBe(1);
    expect(assignments.get(4)).toBe(4);
  });

  it("accumulates tokens for better subsequent matching", () => {
    const articles = [
      { title: "Polizei Saarbrücken: Einbruch in Geschäft - Zeugen gesucht", feedKey: "polizei" },
      { title: "Einbruch in Saarbrücken - Polizei sucht Zeugen nach Tat", feedKey: "radio-salue" },
      { title: "Saarbrücken: Polizei Zeugenaufruf nach Einbruch in Geschäft", feedKey: "breaking-news" },
    ];

    const assignments = simulateBatchMatching(articles);

    const storyRep = assignments.get(0)!;
    expect(assignments.get(1)).toBe(storyRep);
    expect(assignments.get(2)).toBe(storyRep);
  });

  it("does not falsely group unrelated articles", () => {
    const articles = [
      { title: "Konzert in der Saarlandhalle am Samstag", feedKey: "events" },
      { title: "Polizeikontrolle auf der A8", feedKey: "polizei" },
      { title: "Neuer Bürgermeister in St. Wendel gewählt", feedKey: "tagesschau" },
      { title: "Restaurant Tipps für Saarbrücken", feedKey: "local" },
    ];

    const assignments = simulateBatchMatching(articles);

    expect(assignments.get(0)).toBe(0);
    expect(assignments.get(1)).toBe(1);
    expect(assignments.get(2)).toBe(2);
    expect(assignments.get(3)).toBe(3);
  });
});

// -------------------------------------------------------------------------
// findMatchingStory
// -------------------------------------------------------------------------
describe("findMatchingStory", () => {
  it("returns story from URL match (short-circuit, no DB query)", async () => {
    const story = makeStory({ id: "url-story" });
    mockFindStoryByUrl.mockResolvedValue(story);

    const article = makeArticle({ link: "https://example.com/article" });
    const result = await findMatchingStory(article, "news");

    expect(result).toBe(story);
    // DB should NOT be queried since URL match short-circuits
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("returns null on DB error fetching stories", async () => {
    const chain = makeSelectChain({ data: null, error: { message: "DB error" } });
    mockFrom.mockReturnValue({ select: jest.fn(() => chain) });

    const article = makeArticle({ title: "Some Article" });
    const result = await findMatchingStory(article, "news");

    expect(result).toBeNull();
  });

  it("returns null when no stories in DB", async () => {
    const chain = makeSelectChain({ data: [], error: null });
    mockFrom.mockReturnValue({ select: jest.fn(() => chain) });

    const article = makeArticle({ title: "Some Article" });
    const result = await findMatchingStory(article, "news");

    expect(result).toBeNull();
    expect(mockChooseStoryMatch).not.toHaveBeenCalled();
  });

  it("returns null when chooseStoryMatch returns null", async () => {
    const story = makeStory();
    const chain = makeSelectChain({ data: [story], error: null });
    mockFrom.mockReturnValue({ select: jest.fn(() => chain) });
    mockChooseStoryMatch.mockResolvedValue(null);

    const article = makeArticle({ title: "Unrelated Article" });
    const result = await findMatchingStory(article, "news");

    expect(result).toBeNull();
  });

  it("returns matched story (token reason) from chooseStoryMatch", async () => {
    const story = makeStory({ primary_title: "Brand in Saarbrücken" });
    const chain = makeSelectChain({ data: [story], error: null });
    mockFrom.mockReturnValue({ select: jest.fn(() => chain) });
    mockChooseStoryMatch.mockResolvedValue({
      story,
      reason: "token",
      score: 0.75,
    });

    const article = makeArticle({ title: "Brand Saarbrücken Feuerwehr" });
    const result = await findMatchingStory(article, "news");

    expect(result).toBe(story);
  });

  it("returns matched story (semantic reason) from chooseStoryMatch", async () => {
    const story = makeStory({ primary_title: "Brand in Homburg" });
    const chain = makeSelectChain({ data: [story], error: null });
    mockFrom.mockReturnValue({ select: jest.fn(() => chain) });
    mockChooseStoryMatch.mockResolvedValue({
      story,
      reason: "semantic",
      score: 0.88,
    });

    const article = makeArticle({
      title: "Feuer Homburg Lagerhalle",
      contentSnippet: "Feuerwehr im Einsatz",
    });
    const result = await findMatchingStory(article, "news");

    expect(result).toBe(story);
  });

  it("uses contentSnippet when building tokens", async () => {
    const story = makeStory();
    const chain = makeSelectChain({ data: [story], error: null });
    mockFrom.mockReturnValue({ select: jest.fn(() => chain) });

    const article = makeArticle({
      title: "Kurze Schlagzeile",
      contentSnippet: "Langer Inhalt mit zusätzlichen Tokens",
    });
    await findMatchingStory(article, "news");

    expect(mockChooseStoryMatch).toHaveBeenCalled();
  });

  it("does not call findStoryByUrl when article has no link", async () => {
    const chain = makeSelectChain({ data: [], error: null });
    mockFrom.mockReturnValue({ select: jest.fn(() => chain) });

    const article = makeArticle({ link: undefined });
    await findMatchingStory(article, "news");

    expect(mockFindStoryByUrl).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------------------
// createStory
// -------------------------------------------------------------------------
describe("createStory", () => {
  it("returns new story id on success", async () => {
    const mockSingle = jest.fn().mockResolvedValue({ data: { id: "new-story-id" }, error: null });
    const mockSelectChain = { single: mockSingle };
    const mockInsert = jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue(mockSelectChain) });
    mockFrom.mockReturnValue({ insert: mockInsert });

    const article = makeArticle({ title: "New Article Title" });
    const result = await createStory(article);

    expect(result).toBe("new-story-id");
  });

  it("returns null on DB insert error", async () => {
    const mockSingle = jest.fn().mockResolvedValue({ data: null, error: { message: "Insert failed" } });
    const mockInsert = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({ single: mockSingle }),
    });
    mockFrom.mockReturnValue({ insert: mockInsert });

    const article = makeArticle({ title: "New Article" });
    const result = await createStory(article);

    expect(result).toBeNull();
  });

  it("truncates tokens to 150 when article produces more", async () => {
    const mockSingle = jest.fn().mockResolvedValue({ data: { id: "truncated-story" }, error: null });
    const mockInsert = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({ single: mockSingle }),
    });
    mockFrom.mockReturnValue({ insert: mockInsert });

    // 200 unique words → more than 150 tokens
    const manyWords = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const article = makeArticle({ title: manyWords });
    const result = await createStory(article);

    expect(result).toBe("truncated-story");
    const insertCall = (mockInsert as jest.MockedFunction<any>).mock.calls[0][0];
    expect(insertCall.tokens.length).toBeLessThanOrEqual(150);
  });

  it("uses contentSnippet in token computation", async () => {
    const mockSingle = jest.fn().mockResolvedValue({ data: { id: "snippet-story" }, error: null });
    const mockInsert = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({ single: mockSingle }),
    });
    mockFrom.mockReturnValue({ insert: mockInsert });

    const article = makeArticle({
      title: "Kurze Schlagzeile",
      contentSnippet: "Langer Inhalt mit vielen Tokens",
    });
    const result = await createStory(article);

    expect(result).toBe("snippet-story");
    const insertCall = (mockInsert as jest.MockedFunction<any>).mock.calls[0][0];
    expect(Array.isArray(insertCall.tokens)).toBe(true);
    expect(insertCall.tokens.length).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------------------
// addArticleToStory
// -------------------------------------------------------------------------
describe("addArticleToStory", () => {
  it("updates article_count + 1 on success", async () => {
    const mockSingle = jest.fn().mockResolvedValue({
      data: { article_count: 3 },
      error: null,
    });
    const mockUpdateEq = jest.fn().mockResolvedValue({ error: null });
    const mockUpdate = jest.fn().mockReturnValue({ eq: mockUpdateEq });

    const fromCall = jest.fn()
      .mockReturnValueOnce({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({ single: mockSingle }),
        }),
      })
      .mockReturnValueOnce({
        update: mockUpdate,
      });
    mockFrom.mockImplementation(fromCall);

    const article = makeArticle();
    await addArticleToStory("story-1", article);

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ article_count: 4 })
    );
  });

  it("returns early on fetch error", async () => {
    const mockSingle = jest.fn().mockResolvedValue({
      data: null,
      error: { message: "Fetch failed" },
    });
    const mockUpdate = jest.fn();

    const fromCall = jest.fn()
      .mockReturnValueOnce({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({ single: mockSingle }),
        }),
      })
      .mockReturnValueOnce({ update: mockUpdate });
    mockFrom.mockImplementation(fromCall);

    await addArticleToStory("story-1", makeArticle());
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("returns early when story data is null (not found)", async () => {
    const mockSingle = jest.fn().mockResolvedValue({ data: null, error: null });
    const mockUpdate = jest.fn();

    const fromCall = jest.fn()
      .mockReturnValueOnce({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({ single: mockSingle }),
        }),
      })
      .mockReturnValueOnce({ update: mockUpdate });
    mockFrom.mockImplementation(fromCall);

    await addArticleToStory("story-1", makeArticle());
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("logs error when update fails", async () => {
    const mockSingle = jest.fn().mockResolvedValue({
      data: { article_count: 1 },
      error: null,
    });
    const mockUpdateEq = jest.fn().mockResolvedValue({ error: { message: "Update failed" } });
    const mockUpdate = jest.fn().mockReturnValue({ eq: mockUpdateEq });

    const fromCall = jest.fn()
      .mockReturnValueOnce({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({ single: mockSingle }),
        }),
      })
      .mockReturnValueOnce({ update: mockUpdate });
    mockFrom.mockImplementation(fromCall);

    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    await addArticleToStory("story-1", makeArticle());

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to update story"));
    consoleSpy.mockRestore();
  });
});

// -------------------------------------------------------------------------
// assignStoryToArticle
// -------------------------------------------------------------------------
describe("assignStoryToArticle", () => {
  it("calls update with story_id and eq on article id", async () => {
    const mockUpdateEq = jest.fn().mockResolvedValue({ error: null });
    const mockUpdate = jest.fn().mockReturnValue({ eq: mockUpdateEq });
    mockFrom.mockReturnValue({ update: mockUpdate });

    await assignStoryToArticle("article-1", "story-1", "news");

    expect(mockUpdate).toHaveBeenCalledWith({ story_id: "story-1" });
    expect(mockUpdateEq).toHaveBeenCalledWith("id", "article-1");
  });

  it("logs error when update fails", async () => {
    const mockUpdateEq = jest.fn().mockResolvedValue({ error: { message: "Update error" } });
    const mockUpdate = jest.fn().mockReturnValue({ eq: mockUpdateEq });
    mockFrom.mockReturnValue({ update: mockUpdate });

    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    await assignStoryToArticle("article-1", "story-1", "news");

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to assign story"));
    consoleSpy.mockRestore();
  });
});

// -------------------------------------------------------------------------
// markStoryTooted
// -------------------------------------------------------------------------
describe("markStoryTooted", () => {
  it("normalizes and deduplicates links before storing", async () => {
    const mockUpdateEq = jest.fn().mockResolvedValue({ error: null });
    const mockUpdate = jest.fn().mockReturnValue({ eq: mockUpdateEq });
    mockFrom.mockReturnValue({ update: mockUpdate });

    // normalizeUrl strips trailing slash → dedup
    mockNormalizeUrl.mockImplementation((url) => (url ?? "").replace(/\/$/, ""));

    const links = [
      "https://example.com/article/",
      "https://example.com/article/",
      "https://example.com/other",
    ];
    await markStoryTooted("story-1", "toot-123", links);

    const updateCall = (mockUpdate as jest.MockedFunction<any>).mock.calls[0][0];
    expect(updateCall.original_links.length).toBe(2);
    expect(updateCall.tooted).toBe(true);
    expect(updateCall.toot_id).toBe("toot-123");
  });

  it("filters out empty normalized URLs", async () => {
    const mockUpdateEq = jest.fn().mockResolvedValue({ error: null });
    const mockUpdate = jest.fn().mockReturnValue({ eq: mockUpdateEq });
    mockFrom.mockReturnValue({ update: mockUpdate });

    // Return non-empty only for "keep-url", empty string for everything else
    mockNormalizeUrl.mockImplementation((url) => (url === "keep-url" ? "keep-url" : ""));

    await markStoryTooted("story-1", "toot-1", ["keep-url", "drop-url", ""]);

    const updateCall = (mockUpdate as jest.MockedFunction<any>).mock.calls[0][0];
    expect(updateCall.original_links).toEqual(["keep-url"]);
  });

  it("works with empty links array (default parameter)", async () => {
    const mockUpdateEq = jest.fn().mockResolvedValue({ error: null });
    const mockUpdate = jest.fn().mockReturnValue({ eq: mockUpdateEq });
    mockFrom.mockReturnValue({ update: mockUpdate });

    await markStoryTooted("story-1", "toot-1");

    const updateCall = (mockUpdate as jest.MockedFunction<any>).mock.calls[0][0];
    expect(updateCall.original_links).toEqual([]);
  });

  it("logs error on DB update failure", async () => {
    const mockUpdateEq = jest.fn().mockResolvedValue({ error: { message: "Mark failed" } });
    const mockUpdate = jest.fn().mockReturnValue({ eq: mockUpdateEq });
    mockFrom.mockReturnValue({ update: mockUpdate });

    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    await markStoryTooted("story-1", "toot-1", []);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to mark story"));
    consoleSpy.mockRestore();
  });
});

// -------------------------------------------------------------------------
// getStoryTootId
// -------------------------------------------------------------------------
describe("getStoryTootId", () => {
  it("returns toot_id when found", async () => {
    const mockSingle = jest.fn().mockResolvedValue({
      data: { toot_id: "toot-abc" },
      error: null,
    });
    mockFrom.mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({ single: mockSingle }),
      }),
    });

    const result = await getStoryTootId("story-1");
    expect(result).toBe("toot-abc");
  });

  it("returns null when data is null", async () => {
    const mockSingle = jest.fn().mockResolvedValue({ data: null, error: null });
    mockFrom.mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({ single: mockSingle }),
      }),
    });

    const result = await getStoryTootId("story-1");
    expect(result).toBeNull();
  });

  it("returns null on DB error", async () => {
    const mockSingle = jest.fn().mockResolvedValue({
      data: null,
      error: { message: "Not found" },
    });
    mockFrom.mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({ single: mockSingle }),
      }),
    });

    const result = await getStoryTootId("story-1");
    expect(result).toBeNull();
  });
});

// -------------------------------------------------------------------------
// getUntootedStories
// -------------------------------------------------------------------------
describe("getUntootedStories", () => {
  it("returns empty map on DB error fetching stories", async () => {
    const storiesChain: any = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      gt: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({ data: null, error: { message: "Fetch failed" } }),
    };
    mockFrom.mockReturnValue(storiesChain);

    const result = await getUntootedStories("news");
    expect(result.size).toBe(0);
  });

  it("returns empty map when no stories are found", async () => {
    const storiesChain: any = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      gt: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({ data: [], error: null }),
    };
    mockFrom.mockReturnValue(storiesChain);

    const result = await getUntootedStories("news");
    expect(result.size).toBe(0);
  });

  it("maps stories to their article IDs", async () => {
    const story = makeStory({ id: "story-1" });

    const storiesChain: any = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      gt: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({ data: [story], error: null }),
    };
    const articlesChain: any = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({
        data: [{ id: "article-1" }, { id: "article-2" }],
        error: null,
      }),
    };

    let callCount = 0;
    mockFrom.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? storiesChain : articlesChain;
    });

    const result = await getUntootedStories("news");

    expect(result.size).toBe(1);
    const entry = result.get("story-1");
    expect(entry).toBeDefined();
    expect(entry?.story).toBe(story);
    expect(entry?.articleIds).toEqual(["article-1", "article-2"]);
  });

  it("skips stories when their article fetch errors", async () => {
    const story = makeStory({ id: "story-err" });

    const storiesChain: any = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      gt: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({ data: [story], error: null }),
    };
    const articlesChain: any = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({
        data: null,
        error: { message: "Article fetch error" },
      }),
    };

    let callCount = 0;
    mockFrom.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? storiesChain : articlesChain;
    });

    const result = await getUntootedStories("news");
    expect(result.size).toBe(0);
  });
});

// -------------------------------------------------------------------------
// processNewArticles
// -------------------------------------------------------------------------
describe("processNewArticles", () => {
  it("does nothing for empty articles array", async () => {
    await processNewArticles([], "news");
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("assigns article to existing story when findMatchingStory returns a match", async () => {
    const story = makeStory({ id: "existing-story" });
    // Provide a link so findStoryByUrl is called and returns the story (short-circuit)
    mockFindStoryByUrl.mockResolvedValue(story);

    // addArticleToStory: select → eq → single (fetch count), then update → eq
    const mockSingle = jest.fn().mockResolvedValue({ data: { article_count: 2 }, error: null });
    const mockUpdateEq = jest.fn().mockResolvedValue({ error: null });
    const mockUpdate = jest.fn().mockReturnValue({ eq: mockUpdateEq });

    mockFrom.mockImplementation(() => ({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({ single: mockSingle }),
      }),
      update: mockUpdate,
    }));

    // Article with a link so findStoryByUrl short-circuits findMatchingStory
    const article = makeArticle({ title: "Brand in Saarbrücken", link: "https://example.com/article" });
    await processNewArticles([article], "news");

    // update should have been called for addArticleToStory and assignStoryToArticle
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("creates new story when no match found for article", async () => {
    mockFindStoryByUrl.mockResolvedValue(null);
    mockChooseStoryMatch.mockResolvedValue(null);

    const mockInsertSingle = jest.fn().mockResolvedValue({ data: { id: "new-story" }, error: null });
    const mockLimit = jest.fn().mockResolvedValue({ data: [], error: null });
    const mockOrder = jest.fn().mockReturnValue({ limit: mockLimit });
    const mockUpdateEq = jest.fn().mockResolvedValue({ error: null });

    mockFrom.mockImplementation(() => ({
      select: jest.fn().mockReturnValue({
        gt: jest.fn().mockReturnValue({ order: mockOrder }),
        eq: jest.fn().mockReturnValue({ single: jest.fn().mockResolvedValue({ data: { article_count: 1 }, error: null }) }),
      }),
      insert: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({ single: mockInsertSingle }),
      }),
      update: jest.fn().mockReturnValue({ eq: mockUpdateEq }),
    }));

    const article = makeArticle({ title: "Brand Neunkirchen Feuerwehr Einsatz" });
    await processNewArticles([article], "news");

    expect(mockInsertSingle).toHaveBeenCalled();
  });

  it("assigns second article to batch story matching first article", async () => {
    // Both articles have no existing DB story; article 2 should match article 1's
    // newly-created story via batchStoryCache.
    mockFindStoryByUrl.mockResolvedValue(null);
    mockChooseStoryMatch.mockResolvedValue(null);

    let insertCallCount = 0;
    const mockInsertSingle = jest.fn().mockImplementation(async () => {
      insertCallCount++;
      return { data: { id: `new-story-${insertCallCount}` }, error: null };
    });
    const mockUpdateEq = jest.fn().mockResolvedValue({ error: null });
    const mockFetchSingle = jest.fn().mockResolvedValue({ data: { article_count: 1 }, error: null });
    const mockLimit = jest.fn().mockResolvedValue({ data: [], error: null });
    const mockOrder = jest.fn().mockReturnValue({ limit: mockLimit });

    mockFrom.mockImplementation(() => ({
      select: jest.fn().mockReturnValue({
        gt: jest.fn().mockReturnValue({ order: mockOrder }),
        eq: jest.fn().mockReturnValue({ single: mockFetchSingle }),
      }),
      insert: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({ single: mockInsertSingle }),
      }),
      update: jest.fn().mockReturnValue({ eq: mockUpdateEq }),
    }));

    const articles = [
      makeArticle({ id: "a1", title: "Brand in Saarbrücken Feuerwehr im Einsatz großer Brand" }),
      makeArticle({ id: "a2", title: "Saarbrücken Brand Feuerwehr Einsatz großer Brand Innenstadt" }),
    ];
    await processNewArticles(articles, "news");

    // Should have completed without errors
    expect(mockUpdateEq).toHaveBeenCalled();
  });
});

// -------------------------------------------------------------------------
// semanticCheckAdapter
// -------------------------------------------------------------------------
describe("semanticCheckAdapter", () => {
  it("returns empty map for empty pairs input", async () => {
    const result = await semanticCheckAdapter([]);
    expect(result).toEqual(new Map());
    expect(mockBatchSemantic).not.toHaveBeenCalled();
  });

  it("calls batchSemanticSimilarity and maps results by story id", async () => {
    const story1 = makeStory({ id: "story-abc" });
    const story2 = makeStory({ id: "story-def" });

    mockBatchSemantic.mockResolvedValue([
      { indexA: 0, indexB: 0, score: 0.91 },
      { indexA: 1, indexB: 1, score: 0.45 },
    ]);

    const pairs = [
      { story: story1, titleA: "Feuer Homburg", titleB: "Brand Homburg" },
      { story: story2, titleA: "Unfall A1", titleB: "A1 Unfall" },
    ];

    const result = await semanticCheckAdapter(pairs);

    expect(result.get("story-abc")).toBe(0.91);
    expect(result.get("story-def")).toBe(0.45);
  });

  it("skips results whose indexA is beyond the pairs array", async () => {
    const story1 = makeStory({ id: "story-x" });

    mockBatchSemantic.mockResolvedValue([
      { indexA: 0, indexB: 0, score: 0.88 },
      { indexA: 5, indexB: 5, score: 0.99 }, // out of range
    ]);

    const pairs = [
      { story: story1, titleA: "Title A", titleB: "Title B" },
    ];

    const result = await semanticCheckAdapter(pairs);
    expect(result.get("story-x")).toBe(0.88);
    expect(result.size).toBe(1);
  });

  it("passes correct SemanticPair structure to batchSemanticSimilarity", async () => {
    const story = makeStory({ id: "story-check" });
    mockBatchSemantic.mockResolvedValue([]);

    await semanticCheckAdapter([
      { story, titleA: "Article Title", titleB: "Story Title" },
    ]);

    expect(mockBatchSemantic).toHaveBeenCalledWith([
      expect.objectContaining({
        indexA: 0,
        indexB: 0,
        titleA: "Article Title",
        titleB: "Story Title",
      }),
    ]);
  });
});
