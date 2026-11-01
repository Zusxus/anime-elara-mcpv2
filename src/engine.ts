
/**
 * Anime Elara — Research & Publishing Engine
 * Version: 1.0.0
 *
 * Responsibilities:
 * - Search TMDB, AniList and Kitsu.
 * - Retrieve and normalize anime information.
 * - Classify TV / MOVIE / OVA.
 * - Detect conflicting or incomplete information.
 * - Collect and rank images.
 * - Prepare Arabic publication drafts.
 * - Store and manage drafts in Cloudflare D1.
 *
 * This module NEVER publishes to Telegram.
 */

import type {
  AniListHit,
  AniListSearchResult,
  AniListWork,
  AnimeResearchResult,
  AnimeSearchResult,
  ClassificationResult,
  ConfidenceLevel,
  DraftRecord,
  DraftStatus,
  FieldConfidence,
  ImageCandidate,
  ImageCollection,
  KitsuHit,
  KitsuSearchResult,
  KitsuWork,
  NormalizedWork,
  PreparePostResult,
  PreparedPost,
  SourceCall,
  SourceIds,
  SourceName,
  SourceResult,
  TmdbSearchHit,
  TmdbSearchResult,
  TmdbWork,
  WorkIssue,
  WorkKind,
  WorkStatus,
} from "./types";

// ============================================================
// CONFIGURATION
// ============================================================

const TMDB_API = "https://api.themoviedb.org/3";
const TMDB_IMAGE = "https://image.tmdb.org/t/p";

const ANILIST_API = "https://graphql.anilist.co";
const KITSU_API = "https://kitsu.io/api/edge";

const REQUEST_TIMEOUT = 15000;

const MAX_SEARCH_RESULTS = 8;
const MAX_IMAGES_PER_TYPE = 20;

const MAX_SYNOPSIS_LENGTH = 1024;
const MAX_CAPTION_LENGTH = 1024;

const CHANNEL_NAME = "@anime_elara";

type JsonObject = Record<string, unknown>;

type RequestOptions = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
};

type RequestResult<T> = {
  data: T | null;
  call: SourceCall;
};

// ============================================================
// GENERAL HELPERS
// ============================================================

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const result = value
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return result.length > 0 ? result : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return value;
}

function integerOrNull(value: unknown): number | null {
  const number = numberOrNull(value);

  return number !== null && Number.isInteger(number)
    ? number
    : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => cleanString(item))
    .filter((item): item is string => item !== null);
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function uniqueStrings(values: (string | null | undefined)[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => cleanString(value))
        .filter((value): value is string => value !== null),
    ),
  ];
}

function normalizeTitle(value: string | null): string {
  if (!value) return "";

  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function titleSimilarity(a: string | null, b: string | null): number {
  const first = normalizeTitle(a);
  const second = normalizeTitle(b);

  if (!first || !second) return 0;
  if (first === second) return 1;

  const firstWords = new Set(first.split(" "));
  const secondWords = new Set(second.split(" "));

  const intersection = [...firstWords].filter((word) =>
    secondWords.has(word),
  ).length;

  const union = new Set([...firstWords, ...secondWords]).size;

  return union === 0 ? 0 : intersection / union;
}

function yearFromDate(value: string | null): number | null {
  if (!value) return null;

  const match = /^(\d{4})/.exec(value);

  if (!match) return null;

  const year = Number(match[1]);

  return year >= 1900 && year <= 2200 ? year : null;
}

function safeUrl(value: unknown): string | null {
  const text = cleanString(value);

  if (!text) return null;

  try {
    const url = new URL(text);

    if (url.protocol !== "https:") return null;
    if (url.username || url.password) return null;

    return url.toString();
  } catch {
    return null;
  }
}

function newId(): string {
  return crypto.randomUUID();
}

function nowUtc(): string {
  return new Date().toISOString();
}

function formatBaghdadDate(date: string): string {
  const value = new Date(date);

  if (Number.isNaN(value.getTime())) {
    return "غير متوفر";
  }

  return new Intl.DateTimeFormat("ar-IQ", {
    timeZone: "Asia/Baghdad",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(value);
}

function clipText(value: string, maxLength: number): string {
  const normalized = value.trim();

  if (normalized.length <= maxLength) return normalized;

  return normalized.slice(0, maxLength - 1).trimEnd() + "…";
}

function statusFromAniList(value: string | null): WorkStatus {
  switch (value) {
    case "FINISHED":
      return "FINISHED";
    case "RELEASING":
      return "RELEASING";
    case "NOT_YET_RELEASED":
      return "NOT_YET_RELEASED";
    case "CANCELLED":
      return "CANCELLED";
    case "HIATUS":
      return "HIATUS";
    default:
      return "UNKNOWN";
  }
}

function statusFromKitsu(value: string | null): WorkStatus {
  switch (value?.toLowerCase()) {
    case "finished":
      return "FINISHED";
    case "current":
      return "RELEASING";
    case "unreleased":
    case "upcoming":
    case "tba":
      return "NOT_YET_RELEASED";
    default:
      return "UNKNOWN";
  }
}

function statusFromTmdb(
  status: string | null,
  inProduction: boolean | null,
  lastAirDate: string | null,
): WorkStatus {
  const value = status?.toLowerCase();

  if (value === "canceled" || value === "cancelled") {
    return "CANCELLED";
  }

  if (value === "ended") {
    return "FINISHED";
  }

  if (value === "returning series" || inProduction === true) {
    return "RELEASING";
  }

  if (value === "planned" || value === "in production") {
    return "NOT_YET_RELEASED";
  }

  if (lastAirDate && !inProduction) {
    return "FINISHED";
  }

  return "UNKNOWN";
}

function statusArabic(status: WorkStatus): string {
  switch (status) {
    case "FINISHED":
      return "مكتمل";
    case "RELEASING":
      return "مستمر";
    case "NOT_YET_RELEASED":
      return "لم يبدأ عرضه";
    case "CANCELLED":
      return "ملغي";
    case "HIATUS":
      return "متوقف مؤقتاً";
    default:
      return "الحالة غير مؤكدة";
  }
}

function sourceNames(
  ...values: (SourceName | null | undefined)[]
): SourceName[] {
  return [...new Set(values.filter(
    (value): value is SourceName => Boolean(value),
  ))];
}

// ============================================================
// HTTP CLIENT
// One request per call. No automatic retries.
// ============================================================

async function requestJson<T>(
  source: SourceName,
  endpoint: string,
  options: RequestOptions = {},
): Promise<RequestResult<T>> {
  const started = Date.now();

  try {
    const response = await fetch(endpoint, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...options.headers,
      },
      body: options.body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });

    const elapsedMs = Date.now() - started;
    const raw = await response.text();

    let data: T | null = null;
    let error: string | null = null;

    try {
      data = JSON.parse(raw) as T;
    } catch {
      error = "Invalid JSON response";
    }

    if (!response.ok) {
      const parsed = data as JsonObject | null;

      error =
        cleanString(parsed?.status_message) ??
        cleanString(parsed?.errors) ??
        cleanString(parsed?.error) ??
        `HTTP ${response.status}`;

      data = null;
    }

    const call: SourceCall = {
      source,
      endpoint: endpoint.split("?")[0],
      httpStatus: response.status,
      elapsedMs,
      success: response.ok && data !== null,
      error,
    };

    return {
      data,
      call,
    };
  } catch (error) {
    return {
      data: null,
      call: {
        source,
        endpoint: endpoint.split("?")[0],
        httpStatus: null,
        elapsedMs: Date.now() - started,
        success: false,
        error: error instanceof Error
          ? error.message
          : "Network error",
      },
    };
  }
}

// ============================================================
// TMDB SOURCE
// ============================================================

function tmdbHeaders(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${env.TMDB_READ_TOKEN}`,
  };
}

function tmdbImageUrl(
  path: string | null,
  size: "w342" | "w500" | "w780" | "w1280" | "original",
): string | null {
  if (!path || !path.startsWith("/")) return null;

  return `${TMDB_IMAGE}/${size}${path}`;
}

function parseTmdbImage(
  item: JsonObject,
  kind: "poster" | "backdrop",
): ImageCandidate | null {
  const path = cleanString(item.file_path);

  if (!path || !path.startsWith("/")) return null;

  const width = integerOrNull(item.width);
  const height = integerOrNull(item.height);

  const url = tmdbImageUrl(
    path,
    kind === "poster" ? "w780" : "w1280",
  );

  const originalUrl = tmdbImageUrl(path, "original");

  if (!url || !originalUrl) return null;

  return {
    id: `tmdb:${kind}:${path}`,
    source: "tmdb",
    kind,
    url,
    originalUrl,
    language: cleanString(item.iso_639_1),
    width,
    height,
    aspectRatio:
      width && height && height > 0
        ? width / height
        : null,
    voteAverage: numberOrNull(item.vote_average),
    voteCount: integerOrNull(item.vote_count),
    reviewed: false,
    selected: false,
  };
}

function parseTmdbImages(data: JsonObject): ImageCollection {
  const rawPosters = Array.isArray(data.posters)
    ? data.posters as JsonObject[]
    : [];

  const rawBackdrops = Array.isArray(data.backdrops)
    ? data.backdrops as JsonObject[]
    : [];

  const posters = rawPosters
    .map((item) => parseTmdbImage(item, "poster"))
    .filter((item): item is ImageCandidate => item !== null)
    .slice(0, MAX_IMAGES_PER_TYPE);

  const backdrops = rawBackdrops
    .map((item) => parseTmdbImage(item, "backdrop"))
    .filter((item): item is ImageCandidate => item !== null)
    .slice(0, MAX_IMAGES_PER_TYPE);

  return { posters, backdrops };
}

function parseTmdbTranslation(
  translations: JsonObject[],
  language: string,
): {
  available: boolean;
  name: string | null;
  overview: string | null;
} {
  const match = translations.find((item) =>
    cleanString(item.iso_639_1) === language,
  );

  const data = match?.data as JsonObject | undefined;

  return {
    available: Boolean(match),
    name: cleanString(data?.name),
    overview: cleanString(data?.overview),
  };
}

function parseTmdbSeasons(data: JsonObject): TmdbWork["seasonReport"] {
  const raw = Array.isArray(data.seasons)
    ? data.seasons as JsonObject[]
    : [];

  if (!Array.isArray(data.seasons)) {
    return null;
  }

  const seasons = raw
    .map((item) => ({
      seasonNumber: integerOrNull(item.season_number),
      name: cleanString(item.name),
      episodeCount: integerOrNull(item.episode_count),
      airDate: cleanString(item.air_date),
    }))
    .filter((item) =>
      item.seasonNumber !== null && item.seasonNumber >= 0,
    );

  const main = seasons.filter((item) => item.seasonNumber > 0);
  const specials = seasons.filter((item) => item.seasonNumber === 0);

  const hasMissingMain = main.some((item) => item.episodeCount === null);
  const hasMissingSpecials = specials.some((item) => item.episodeCount === null);

  const mainCount = hasMissingMain
    ? null
    : main.reduce((sum, item) => sum + (item.episodeCount ?? 0), 0);

  const specialCount = hasMissingSpecials
    ? null
    : specials.reduce((sum, item) => sum + (item.episodeCount ?? 0), 0);

  const allCount =
    mainCount !== null && specialCount !== null
      ? mainCount + specialCount
      : null;

  const reported = integerOrNull(data.number_of_episodes);

  let comparison: NonNullable<TmdbWork["seasonReport"]>["comparison"];

  if (reported === null) {
    comparison = "unavailable";
  } else if (mainCount === null) {
    comparison = "incomplete";
  } else if (reported === mainCount) {
    comparison = "match";
  } else if (allCount !== null && reported === allCount) {
    comparison = "match_with_specials";
  } else if (allCount === null && hasMissingSpecials) {
    comparison = "incomplete";
  } else {
    comparison = "mismatch";
  }

  return {
    available: true,
    reportedSeasonCount: integerOrNull(data.number_of_seasons) ?? main.length,
    seasons: seasons.map((item) => ({
      seasonNumber: item.seasonNumber!,
      name: item.name,
      episodeCount: item.episodeCount,
      airDate: item.airDate,
    })),
    mainEpisodeCount: mainCount,
    specialEpisodeCount: specialCount,
    totalEpisodeCount: allCount,
    reportedEpisodeCount: reported,
    comparison,
  };
}

function parseTmdbWork(data: JsonObject): TmdbWork | null {
  const id = integerOrNull(data.id);

  if (!id) return null;

  const mediaType =
    cleanString(data.media_type) === "movie" ||
    "title" in data && !("name" in data)
      ? "movie"
      : "tv";

  const rawTranslations = data.translations as JsonObject | undefined;

  const translations = Array.isArray(rawTranslations?.translations)
    ? rawTranslations.translations as JsonObject[]
    : [];

  const rawExternal = data.external_ids as JsonObject | undefined;

  const rawGenres = Array.isArray(data.genres)
    ? data.genres as JsonObject[]
    : [];

  const genres = uniqueStrings(
    rawGenres.map((item) => cleanString(item.name)),
  );

  const rawImages = data.images as JsonObject | undefined;

  const images = rawImages
    ? parseTmdbImages(rawImages)
    : { posters: [], backdrops: [] };

  const firstAirDate = cleanString(data.first_air_date);
  const lastAirDate = cleanString(data.last_air_date);
  const releaseDate = cleanString(data.release_date);

  return {
    id,
    mediaType,
    title: cleanString(data.name) ?? cleanString(data.title),
    originalTitle:
      cleanString(data.original_name) ??
      cleanString(data.original_title),
    originalLanguage: cleanString(data.original_language),
    overview: cleanString(data.overview),
    firstAirDate,
    lastAirDate,
    releaseDate,
    status: cleanString(data.status),
    inProduction: booleanOrNull(data.in_production),
    numberOfSeasons: integerOrNull(data.number_of_seasons),
    numberOfEpisodes: integerOrNull(data.number_of_episodes),
    runtimeMinutes: integerOrNull(data.runtime),
    voteAverage: numberOrNull(data.vote_average),
    voteCount: integerOrNull(data.vote_count),
    genres,
    adult: data.adult === true,
    homepage: safeUrl(data.homepage),
    externalIds: {
      imdbId: cleanString(rawExternal?.imdb_id),
      tvdbId: integerOrNull(rawExternal?.tvdb_id),
      wikidataId: cleanString(rawExternal?.wikidata_id),
    },
    translations: {
      english: parseTmdbTranslation(translations, "en"),
      arabic: parseTmdbTranslation(translations, "ar"),
      japanese: parseTmdbTranslation(translations, "ja"),
    },
    seasonReport:
      mediaType === "tv" ? parseTmdbSeasons(data) : null,
    images,
  };
}

async function searchTmdb(
  env: Env,
  query: string,
): Promise<SourceResult<TmdbSearchResult[]>> {
  const params = new URLSearchParams({
    query,
    include_adult: "false",
    language: "en-US",
    page: "1",
  });

  const endpoint = `${TMDB_API}/search/multi?${params}`;

  const response = await requestJson<JsonObject>(
    "tmdb",
    endpoint,
    { headers: tmdbHeaders(env) },
  );

  const raw = Array.isArray(response.data?.results)
    ? response.data.results as JsonObject[]
    : [];

  const results: TmdbSearchResult[] = raw
    .filter((item) =>
      item.media_type === "tv" || item.media_type === "movie",
    )
    .map((item) => {
      const mediaType = item.media_type as "tv" | "movie";

      const title =
        cleanString(item.name) ??
        cleanString(item.title);

      const originalTitle =
        cleanString(item.original_name) ??
        cleanString(item.original_title);

      const date =
        cleanString(item.first_air_date) ??
        cleanString(item.release_date);

      const genreIds = Array.isArray(item.genre_ids)
        ? item.genre_ids as number[]
        : [];

      return {
        id: integerOrNull(item.id) ?? 0,
        mediaType,
        title,
        originalTitle,
        originalLanguage: cleanString(item.original_language),
        releaseYear: yearFromDate(date),
        isAnimation: genreIds.includes(16),
        overview: cleanString(item.overview),
        posterUrl: tmdbImageUrl(
          cleanString(item.poster_path),
          "w500",
        ),
      };
    })
    .filter((item) => item.id > 0);

  return {
    source: "tmdb",
    success: response.call.success,
    data: response.call.success ? results : null,
    call: response.call,
    error: response.call.error,
  };
}

async function getTmdbWork(
  env: Env,
  id: number,
  kind: "tv" | "movie",
): Promise<SourceResult<TmdbWork>> {
  const params = new URLSearchParams({
    language: "en-US",
    append_to_response: "translations,images,external_ids",
    include_image_language: "en,ar,ja,null",
  });

  const endpoint = `${TMDB_API}/${kind}/${id}?${params}`;

  const response = await requestJson<JsonObject>(
    "tmdb",
    endpoint,
    { headers: tmdbHeaders(env) },
  );

  const data = response.data
    ? parseTmdbWork({
        ...response.data,
        media_type: kind,
      })
    : null;

  return {
    source: "tmdb",
    success: response.call.success && data !== null,
    data,
    call: response.call,
    error: response.call.error ??
      (response.call.success && !data ? "Invalid TMDB work data" : null),
  };
}

// ============================================================
// ANILIST SOURCE
// ============================================================

const ANILIST_SEARCH_QUERY = `
query ($search: String) {
  Page(page: 1, perPage: 8) {
    media(search: $search, type: ANIME, isAdult: false) {
      id
      idMal
      format
      status
      episodes
      seasonYear
      startDate {
        year
        month
        day
      }
      title {
        romaji
        english
        native
      }
      siteUrl
      isAdult
    }
  }
}
`;

const ANILIST_DETAIL_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    idMal
    format
    status
    episodes
    duration
    seasonYear
    startDate {
      year
      month
      day
    }
    endDate {
      year
      month
      day
    }
    title {
      romaji
      english
      native
    }
    genres
    averageScore
    popularity
    description(asHtml: false)
    siteUrl
    isAdult
    countryOfOrigin
    nextAiringEpisode {
      episode
      airingAt
    }
    coverImage {
      extraLarge
      large
    }
    bannerImage
  }
}
`;

function aniListDate(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;

  const date = value as JsonObject;

  const year = integerOrNull(date.year);
  const month = integerOrNull(date.month);
  const day = integerOrNull(date.day);

  if (!year) return null;

  return [
    String(year).padStart(4, "0"),
    String(month ?? 1).padStart(2, "0"),
    String(day ?? 1).padStart(2, "0"),
  ].join("-");
}

function parseAniListHit(data: JsonObject): AniListSearchResult | null {
  const id = integerOrNull(data.id);

  if (!id) return null;

  const title = data.title as JsonObject | undefined;

  return {
    id,
    malId: integerOrNull(data.idMal),
    format: cleanString(data.format),
    status: cleanString(data.status),
    episodes: integerOrNull(data.episodes),
    seasonYear: integerOrNull(data.seasonYear),
    titleRomaji: cleanString(title?.romaji),
    titleEnglish: cleanString(title?.english),
    titleNative: cleanString(title?.native),
    siteUrl: safeUrl(data.siteUrl),
    isAdult: data.isAdult === true,
  };
}

function parseAniListWork(data: JsonObject): AniListWork | null {
  const id = integerOrNull(data.id);

  if (!id) return null;

  const title = data.title as JsonObject | undefined;
  const startDate = aniListDate(data.startDate);
  const endDate = aniListDate(data.endDate);

  const next = data.nextAiringEpisode as JsonObject | undefined;
  const cover = data.coverImage as JsonObject | undefined;

  return {
    id,
    malId: integerOrNull(data.idMal),
    format: cleanString(data.format),
    status: cleanString(data.status),
    episodes: integerOrNull(data.episodes),
    durationMinutes: integerOrNull(data.duration),
    seasonYear: integerOrNull(data.seasonYear),
    startDate,
    endDate,
    titleRomaji: cleanString(title?.romaji),
    titleEnglish: cleanString(title?.english),
    titleNative: cleanString(title?.native),
    genres: arrayOfStrings(data.genres),
    averageScore: numberOrNull(data.averageScore),
    popularity: integerOrNull(data.popularity),
    description: cleanString(data.description),
    siteUrl: safeUrl(data.siteUrl),
    isAdult: data.isAdult === true,
    countryOfOrigin: cleanString(data.countryOfOrigin),
    nextAiringEpisode:
      next &&
      integerOrNull(next.episode) !== null &&
      integerOrNull(next.airingAt) !== null
        ? {
            episode: integerOrNull(next.episode)!,
            airingAt: integerOrNull(next.airingAt)!,
          }
        : null,
    coverImageUrl:
      safeUrl(cover?.extraLarge) ??
      safeUrl(cover?.large),
    bannerImageUrl: safeUrl(data.bannerImage),
  };
}

async function anilistRequest<T>(
  query: string,
  variables: JsonObject,
): Promise<RequestResult<T>> {
  return requestJson<T>(
    "anilist",
    ANILIST_API,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    },
  );
}

async function searchAniList(
  query: string,
): Promise<SourceResult<AniListSearchResult[]>> {
  const response = await anilistRequest<JsonObject>(
    ANILIST_SEARCH_QUERY,
    { search: query },
  );

  const page = response.data?.data as JsonObject | undefined;
  const pageData = page?.Page as JsonObject | undefined;

  const raw = Array.isArray(pageData?.media)
    ? pageData.media as JsonObject[]
    : [];

  const results = raw
    .map(parseAniListHit)
    .filter((item): item is AniListSearchResult => item !== null);

  const errors = response.data?.errors;

  const failed = Array.isArray(errors) && errors.length > 0;

  return {
    source: "anilist",
    success: response.call.success && !failed,
    data: response.call.success && !failed ? results : null,
    call: {
      ...response.call,
      success: response.call.success && !failed,
      error: failed ? "AniList GraphQL returned errors" : response.call.error,
    },
    error: failed ? "AniList GraphQL returned errors" : response.call.error,
  };
}

async function getAniListWork(
  id: number,
): Promise<SourceResult<AniListWork>> {
  const response = await anilistRequest<JsonObject>(
    ANILIST_DETAIL_QUERY,
    { id },
  );

  const root = response.data?.data as JsonObject | undefined;
  const raw = root?.Media as JsonObject | undefined;

  const data = raw ? parseAniListWork(raw) : null;

  const errors = response.data?.errors;
  const failed = Array.isArray(errors) && errors.length > 0;

  return {
    source: "anilist",
    success: response.call.success && !failed && data !== null,
    data: response.call.success && !failed ? data : null,
    call: {
      ...response.call,
      success: response.call.success && !failed,
      error: failed ? "AniList GraphQL returned errors" : response.call.error,
    },
    error: failed
      ? "AniList GraphQL returned errors"
      : response.call.error,
  };
}

// ============================================================
// KITSU SOURCE
// ============================================================

function kitsuImage(
  value: unknown,
  size: "small" | "medium" | "large" | "original",
): string | null {
  if (!value || typeof value !== "object") return null;

  const data = value as JsonObject;

  return safeUrl(data[size]);
}

function kitsuGenres(included: unknown): string[] {
  if (!Array.isArray(included)) return [];

  return uniqueStrings(
    (included as JsonObject[])
      .filter((item) => item.type === "genres")
      .map((item) => {
        const attributes = item.attributes as JsonObject | undefined;
        return cleanString(attributes?.name);
      }),
  );
}

function kitsuMappings(included: unknown): {
  site: string;
  id: string;
}[] {
  if (!Array.isArray(included)) return [];

  return (included as JsonObject[])
    .filter((item) => item.type === "mappings")
    .map((item) => {
      const attributes = item.attributes as JsonObject | undefined;

      return {
        site: cleanString(attributes?.externalSite) ?? "",
        id: cleanString(attributes?.externalId) ?? "",
      };
    })
    .filter((item) => item.site.length > 0 && item.id.length > 0);
}

function mappingId(
  mappings: { site: string; id: string }[],
  terms: string[],
): number | null {
  const match = mappings.find((item) =>
    terms.some((term) =>
      item.site.toLowerCase().includes(term.toLowerCase()),
    ),
  );

  if (!match) return null;

  const id = Number(match.id);

  return Number.isInteger(id) && id > 0 ? id : null;
}

function parseKitsuHit(item: JsonObject): KitsuSearchResult | null {
  const id = cleanString(item.id);
  const attributes = item.attributes as JsonObject | undefined;

  if (!id || !attributes) return null;

  const titles = attributes.titles as JsonObject | undefined;

  return {
    id,
    subtype: cleanString(attributes.subtype),
    status: cleanString(attributes.status),
    episodeCount: integerOrNull(attributes.episodeCount),
    startDate: cleanString(attributes.startDate),
    canonicalTitle: cleanString(attributes.canonicalTitle),
    englishTitle: cleanString(titles?.en),
    japaneseTitle: cleanString(titles?.ja_jp),
    isAdult:
      attributes.nsfw === true ||
      cleanString(attributes.ageRating)?.toUpperCase() === "R18",
  };
}

function parseKitsuWork(
  item: JsonObject,
  included: unknown,
): KitsuWork | null {
  const id = cleanString(item.id);
  const attributes = item.attributes as JsonObject | undefined;

  if (!id || !attributes) return null;

  const titles = attributes.titles as JsonObject | undefined;
  const poster = attributes.posterImage;
  const cover = attributes.coverImage;

  const mappings = kitsuMappings(included);

  return {
    id,
    slug: cleanString(attributes.slug),
    subtype: cleanString(attributes.subtype),
    status: cleanString(attributes.status),
    episodeCount: integerOrNull(attributes.episodeCount),
    episodeLengthMinutes: integerOrNull(attributes.episodeLength),
    startDate: cleanString(attributes.startDate),
    endDate: cleanString(attributes.endDate),
    canonicalTitle: cleanString(attributes.canonicalTitle),
    englishTitle: cleanString(titles?.en),
    englishJapaneseTitle: cleanString(titles?.en_jp),
    japaneseTitle: cleanString(titles?.ja_jp),
    synopsis: cleanString(attributes.synopsis),
    averageRating: numberOrNull(attributes.averageRating),
    userCount: integerOrNull(attributes.userCount),
    ageRating: cleanString(attributes.ageRating),
    ageRatingGuide: cleanString(attributes.ageRatingGuide),
    isAdult:
      attributes.nsfw === true ||
      cleanString(attributes.ageRating)?.toUpperCase() === "R18",
    posterUrl:
      kitsuImage(poster, "large") ??
      kitsuImage(poster, "original") ??
      kitsuImage(poster, "medium"),
    coverUrl:
      kitsuImage(cover, "large") ??
      kitsuImage(cover, "original"),
    genres: kitsuGenres(included),
    mappings,
    aniListId: mappingId(mappings, ["anilist"]),
    malId: mappingId(mappings, ["myanimelist", "mal"]),
    siteUrl: `https://kitsu.io/anime/${encodeURIComponent(id)}`,
  };
}

async function searchKitsu(
  query: string,
): Promise<SourceResult<KitsuSearchResult[]>> {
  const params = new URLSearchParams({
    "filter[text]": query,
    "page[limit]": "8",
  });

  const endpoint = `${KITSU_API}/anime?${params}`;

  const response = await requestJson<JsonObject>(
    "kitsu",
    endpoint,
  );

  const raw = Array.isArray(response.data?.data)
    ? response.data.data as JsonObject[]
    : [];

  const results = raw
    .map(parseKitsuHit)
    .filter((item): item is KitsuSearchResult => item !== null);

  return {
    source: "kitsu",
    success: response.call.success,
    data: response.call.success ? results : null,
    call: response.call,
    error: response.call.error,
  };
}

async function getKitsuWork(
  id: string,
): Promise<SourceResult<KitsuWork>> {
  const params = new URLSearchParams({
    include: "genres,mappings",
  });

  const endpoint = `${KITSU_API}/anime/${encodeURIComponent(id)}?${params}`;

  const response = await requestJson<JsonObject>(
    "kitsu",
    endpoint,
  );

  const item = response.data?.data as JsonObject | undefined;
  const included = response.data?.included;

  const data = item ? parseKitsuWork(item, included) : null;

  return {
    source: "kitsu",
    success: response.call.success && data !== null,
    data,
    call: response.call,
    error: response.call.error ??
      (response.call.success && !data ? "Invalid Kitsu work data" : null),
  };
}

// ============================================================
// SEARCH ENGINE
// ============================================================

function searchCandidateScore(
  query: string,
  title: string | null,
  year: number | null,
): number {
  const similarity = titleSimilarity(query, title);

  return similarity * 100 + (year ? 1 : 0);
}

function candidateIds(
  source: SourceName,
  item: TmdbSearchResult | AniListSearchResult | KitsuSearchResult,
): SourceIds {
  const empty: SourceIds = {
    tmdbId: null,
    tmdbKind: null,
    aniListId: null,
    malId: null,
    kitsuId: null,
  };

  if (source === "tmdb") {
    const hit = item as TmdbSearchResult;

    return {
      ...empty,
      tmdbId: hit.id,
      tmdbKind: hit.mediaType,
    };
  }

  if (source === "anilist") {
    const hit = item as AniListSearchResult;

    return {
      ...empty,
      aniListId: hit.id,
      malId: hit.malId,
    };
  }

  const hit = item as KitsuSearchResult;

  return {
    ...empty,
    kitsuId: hit.id,
  };
}

function candidateTitle(
  source: SourceName,
  item: TmdbSearchResult | AniListSearchResult | KitsuSearchResult,
): string {
  if (source === "tmdb") {
    const hit = item as TmdbSearchResult;
    return hit.title ?? hit.originalTitle ?? "Unknown title";
  }

  if (source === "anilist") {
    const hit = item as AniListSearchResult;
    return hit.titleEnglish ?? hit.titleRomaji ?? hit.titleNative ?? "Unknown title";
  }

  const hit = item as KitsuSearchResult;

  return hit.englishTitle ?? hit.canonicalTitle ?? hit.japaneseTitle ?? "Unknown title";
}

function candidateKind(
  source: SourceName,
  item: TmdbSearchResult | AniListSearchResult | KitsuSearchResult,
): WorkKind | null {
  if (source === "tmdb") {
    return (item as TmdbSearchResult).mediaType === "movie"
      ? "MOVIE"
      : "TV";
  }

  if (source === "anilist") {
    const format = (item as AniListSearchResult).format;

    if (format === "OVA") return "OVA";
    if (format === "MOVIE") return "MOVIE";

    if (format === "TV" || format === "TV_SHORT") return "TV";

    return null;
  }

  const subtype = (item as KitsuSearchResult).subtype?.toLowerCase();

  if (subtype === "ova") return "OVA";
  if (subtype === "movie") return "MOVIE";
  if (subtype === "tv") return "TV";

  return null;
}

export async function searchAnime(
  env: Env,
  query: string,
  maxResults = 8,
): Promise<AnimeSearchResult> {
  const cleanQuery = cleanString(query);

  if (!cleanQuery || cleanQuery.length < 2) {
    return {
      query: query ?? "",
      results: [],
      sourceErrors: ["البحث يحتاج إلى اسم مكوّن من حرفين على الأقل."],
    };
  }

  const limit = Math.min(
    Math.max(Math.trunc(maxResults), 1),
    MAX_SEARCH_RESULTS,
  );

  const [tmdb, aniList, kitsu] = await Promise.all([
    searchTmdb(env, cleanQuery),
    searchAniList(cleanQuery),
    searchKitsu(cleanQuery),
  ]);

  const sourceErrors = [
    ...[tmdb, aniList, kitsu]
      .filter((result) => !result.success)
      .map((result) =>
        `${result.source}: ${result.error ?? "تعذر الحصول على النتائج"}`,
      ),
  ];

  type Candidate = {
    ids: SourceIds;
    kind: WorkKind | null;
    title: string;
    originalTitle: string | null;
    year: number | null;
    posterUrl: string | null;
    source: SourceName;
    confidence: ConfidenceLevel;
    score: number;
  };

  const candidates: Candidate[] = [];

  for (const item of tmdb.data ?? []) {
    if (!item.isAnimation) continue;

    const title = item.title ?? item.originalTitle ?? "Unknown title";

    candidates.push({
      ids: candidateIds("tmdb", item),
      kind: candidateKind("tmdb", item),
      title,
      originalTitle: item.originalTitle,
      year: item.releaseYear,
      posterUrl: item.posterUrl,
      source: "tmdb",
      confidence: "medium",
      score: searchCandidateScore(cleanQuery, title, item.releaseYear),
    });
  }

  for (const item of aniList.data ?? []) {
    if (item.isAdult) continue;

    const title =
      item.titleEnglish ??
      item.titleRomaji ??
      item.titleNative ??
      "Unknown title";

    candidates.push({
      ids: candidateIds("anilist", item),
      kind: candidateKind("anilist", item),
      title,
      originalTitle: item.titleNative,
      year: item.seasonYear,
      posterUrl: null,
      source: "anilist",
      confidence: "medium",
      score: searchCandidateScore(cleanQuery, title, item.seasonYear),
    });
  }

  for (const item of kitsu.data ?? []) {
    if (item.isAdult) continue;

    const title =
      item.englishTitle ??
      item.canonicalTitle ??
      item.japaneseTitle ??
      "Unknown title";

    candidates.push({
      ids: candidateIds("kitsu", item),
      kind: candidateKind("kitsu", item),
      title,
      originalTitle: item.japaneseTitle,
      year: yearFromDate(item.startDate),
      posterUrl: null,
      source: "kitsu",
      confidence: "medium",
      score: searchCandidateScore(
        cleanQuery,
        title,
        yearFromDate(item.startDate),
      ),
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  const seen = new Set<string>();

  const results = candidates
    .filter((item) => {
      const key =
        item.ids.tmdbId
          ? `tmdb:${item.ids.tmdbKind}:${item.ids.tmdbId}`
          : item.ids.aniListId
            ? `anilist:${item.ids.aniListId}`
            : item.ids.kitsuId
              ? `kitsu:${item.ids.kitsuId}`
              : `${item.source}:${normalizeTitle(item.title)}`;

      if (seen.has(key)) return false;

      seen.add(key);
      return true;
    })
    .slice(0, limit)
    .map(({ score: _score, ...item }) => item);

  return {
    query: cleanQuery,
    results,
    sourceErrors,
  };
}

// ============================================================
// CLASSIFICATION
// ============================================================

function classifyAniListFormat(format: string | null): WorkKind | null {
  switch (format) {
    case "OVA":
      return "OVA";
    case "MOVIE":
      return "MOVIE";
    case "TV":
    case "TV_SHORT":
      return "TV";
    default:
      return null;
  }
}

function classifyKitsuSubtype(subtype: string | null): WorkKind | null {
  switch (subtype?.toLowerCase()) {
    case "ova":
      return "OVA";
    case "movie":
      return "MOVIE";
    case "tv":
      return "TV";
    default:
      return null;
  }
}

function addIssue(
  issues: WorkIssue[],
  code: string,
  severity: WorkIssue["severity"],
  message: string,
  sources: SourceName[],
  requiresAcknowledgement = false,
): void {
  if (issues.some((item) => item.code === code)) return;

  issues.push({
    code,
    severity,
    message,
    sources,
    requiresAcknowledgement,
  });
}

function classifyWork(
  tmdb: TmdbWork | null,
  aniList: AniListWork | null,
  kitsu: KitsuWork | null,
): ClassificationResult {
  const issues: WorkIssue[] = [];

  const aniKind = classifyAniListFormat(aniList?.format ?? null);
  const kitsuKind = classifyKitsuSubtype(kitsu?.subtype ?? null);

  const tmdbKind: WorkKind | null = tmdb
    ? tmdb.mediaType === "movie" ? "MOVIE" : "TV"
    : null;

  const specializedKinds = [aniKind, kitsuKind].filter(
    (item): item is WorkKind => item !== null,
  );

  const uniqueSpecialized = [...new Set(specializedKinds)];

  if (uniqueSpecialized.length > 1) {
    addIssue(
      issues,
      "SOURCE_TYPE_CONFLICT",
      "blocking",
      "مصادر الأنمي المتخصصة تختلف في تصنيف نوع العمل.",
      sourceNames(
        aniKind ? "anilist" : null,
        kitsuKind ? "kitsu" : null,
      ),
    );
  }

  let kind: WorkKind | null = null;
  let confidence: ConfidenceLevel = "unknown";
  let reason = "لم تتوفر معلومات كافية لتحديد نوع العمل.";

  if (uniqueSpecialized.length === 1) {
    kind = uniqueSpecialized[0];

    confidence =
      specializedKinds.length === 2
        ? "high"
        : "medium";

    reason =
      "تم تحديد النوع بالاعتماد على مصدر أنمي متخصص.";
  } else if (tmdbKind) {
    kind = tmdbKind;
    confidence = "low";

    reason =
      "تم تحديد النوع من TMDB فقط؛ هذا المصدر لا يكفي وحده لإثبات أن العمل OVA.";

    addIssue(
      issues,
      "SPECIALIZED_CLASSIFICATION_MISSING",
      "blocking",
      "يلزم التحقق من AniList أو Kitsu لتأكيد نوع العمل قبل إعداد المنشور.",
      ["tmdb"],
    );
  }

  if (tmdbKind && kind && tmdbKind !== kind) {
    addIssue(
      issues,
      "TMDB_TYPE_CONFLICT",
      "blocking",
      "تصنيف TMDB لا يتطابق مع تصنيف مصدر الأنمي المتخصص.",
      sourceNames(
        "tmdb",
        aniKind ? "anilist" : null,
        kitsuKind ? "kitsu" : null,
      ),
    );
  }

  const formats = [
    aniList?.format ?? null,
    kitsu?.subtype ?? null,
  ].filter((item): item is string => Boolean(item));

  const unsupported = formats.some((format) => {
    const value = format.toUpperCase();

    return [
      "ONA",
      "MUSIC",
      "SPECIAL",
      "TV_SPECIAL",
    ].includes(value);
  });

  if (unsupported) {
    addIssue(
      issues,
      "UNSUPPORTED_WORK_FORMAT",
      "blocking",
      "هذا العمل مصنف ضمن نوع غير مدعوم في القناة حالياً.",
      sourceNames(
        aniList ? "anilist" : null,
        kitsu ? "kitsu" : null,
      ),
    );
  }

  if (!kind && !unsupported) {
    addIssue(
      issues,
      "UNKNOWN_WORK_FORMAT",
      "blocking",
      "تعذر تحديد ما إذا كان العمل مسلسلًا أو فيلمًا أو OVA.",
      sourceNames(
        tmdb ? "tmdb" : null,
        aniList ? "anilist" : null,
        kitsu ? "kitsu" : null,
      ),
    );
  }

  return {
    kind,
    confidence,
    sources: sourceNames(
      tmdb ? "tmdb" : null,
      aniList ? "anilist" : null,
      kitsu ? "kitsu" : null,
    ),
    reason,
    issues,
  };
}

// ============================================================
// IMAGE COLLECTION AND RANKING
// ============================================================

function imageFromExternalSource(
  source: "anilist" | "kitsu",
  url: string | null,
  kind: ImageKind,
): ImageCandidate | null {
  const valid = safeUrl(url);

  if (!valid) return null;

  return {
    id: `${source}:${kind}:${valid}`,
    source,
    kind,
    url: valid,
    originalUrl: valid,
    language: null,
    width: null,
    height: null,
    aspectRatio: null,
    voteAverage: null,
    voteCount: null,
    reviewed: false,
    selected: false,
  };
}

function imageScore(image: ImageCandidate): number {
  let score = 0;

  if (image.kind === "poster") {
    score += 30;

    if (image.aspectRatio !== null) {
      if (image.aspectRatio >= 0.55 && image.aspectRatio <= 0.78) {
        score += 25;
      } else {
        score -= 15;
      }
    }
  } else {
    score += 15;

    if (image.aspectRatio !== null && image.aspectRatio >= 1.4) {
      score += 15;
    }
  }

  if (image.width && image.width >= 1000) score += 8;
  if (image.height && image.height >= 1400 && image.kind === "poster") {
    score += 8;
  }

  if (image.voteAverage !== null && image.voteCount !== null) {
    if (image.voteCount >= 10) {
      score += Math.min(image.voteAverage * 1.5, 15);
    }
  }

  if (image.language === "en" || image.language === null) {
    score += 2;
  }

  if (image.source === "tmdb") score += 3;

  return score;
}

function rankImages(images: ImageCandidate[]): ImageCandidate[] {
  return [...images].sort(
    (a, b) => imageScore(b) - imageScore(a),
  );
}

function collectImages(
  tmdb: TmdbWork | null,
  aniList: AniListWork | null,
  kitsu: KitsuWork | null,
): ImageCollection {
  const posters: ImageCandidate[] = [];
  const backdrops: ImageCandidate[] = [];

  if (tmdb) {
    posters.push(...tmdb.images.posters);
    backdrops.push(...tmdb.images.backdrops);
  }

  const aniPoster = imageFromExternalSource(
    "anilist",
    aniList?.coverImageUrl ?? null,
    "poster",
  );

  const aniBanner = imageFromExternalSource(
    "anilist",
    aniList?.bannerImageUrl ?? null,
    "backdrop",
  );

  const kitsuPoster = imageFromExternalSource(
    "kitsu",
    kitsu?.posterUrl ?? null,
    "poster",
  );

  const kitsuCover = imageFromExternalSource(
    "kitsu",
    kitsu?.coverUrl ?? null,
    "backdrop",
  );

  if (aniPoster) posters.push(aniPoster);
  if (aniBanner) backdrops.push(aniBanner);
  if (kitsuPoster) posters.push(kitsuPoster);
  if (kitsuCover) backdrops.push(kitsuCover);

  const unique = (items: ImageCandidate[]) => {
    const seen = new Set<string>();

    return rankImages(items).filter((item) => {
      if (seen.has(item.url)) return false;

      seen.add(item.url);
      return true;
    });
  };

  return {
    posters: unique(posters).slice(0, MAX_IMAGES_PER_TYPE),
    backdrops: unique(backdrops).slice(0, MAX_IMAGES_PER_TYPE),
  };
}

// ============================================================
// SOURCE MATCH VALIDATION
// ============================================================

function compareYears(
  tmdb: TmdbWork | null,
  aniList: AniListWork | null,
  kitsu: KitsuWork | null,
): WorkIssue[] {
  const issues: WorkIssue[] = [];

  const years = [
    {
      source: "tmdb" as const,
      year: yearFromDate(
        tmdb?.mediaType === "tv"
          ? tmdb.firstAirDate
          : tmdb?.releaseDate ?? null,
      ),
    },
    {
      source: "anilist" as const,
      year: aniList?.seasonYear ?? yearFromDate(aniList?.startDate ?? null),
    },
    {
      source: "kitsu" as const,
      year: yearFromDate(kitsu?.startDate ?? null),
    },
  ].filter(
    (item): item is { source: SourceName; year: number } =>
      item.year !== null,
  );

  if (years.length < 2) return issues;

  const values = years.map((item) => item.year);
  const min = Math.min(...values);
  const max = Math.max(...values);

  if (max - min >= 2) {
    addIssue(
      issues,
      "YEAR_CONFLICT",
      "warning",
      `هناك اختلاف في سنة الإصدار بين المصادر: ${years.map((item) => `${item.source} ${item.year}`).join("، ")}.`,
      years.map((item) => item.source),
      true,
    );
  }

  return issues;
}

function compareTitles(
  tmdb: TmdbWork | null,
  aniList: AniListWork | null,
  kitsu: KitsuWork | null,
): WorkIssue[] {
  const issues: WorkIssue[] = [];

  const titles: {
    source: SourceName;
    values: string[];
  }[] = [];

  if (tmdb) {
    titles.push({
      source: "tmdb",
      values: [tmdb.title, tmdb.originalTitle].filter(
        (item): item is string => Boolean(item),
      ),
    });
  }

  if (aniList) {
    titles.push({
      source: "anilist",
      values: [
        aniList.titleEnglish,
        aniList.titleRomaji,
        aniList.titleNative,
      ].filter((item): item is string => Boolean(item)),
    });
  }

  if (kitsu) {
    titles.push({
      source: "kitsu",
      values: [
        kitsu.canonicalTitle,
        kitsu.englishTitle,
        kitsu.englishJapaneseTitle,
        kitsu.japaneseTitle,
      ].filter((item): item is string => Boolean(item)),
    });
  }

  for (let i = 0; i < titles.length; i++) {
    for (let j = i + 1; j < titles.length; j++) {
      const first = titles[i];
      const second = titles[j];

      const best = Math.max(
        ...first.values.flatMap((a) =>
          second.values.map((b) => titleSimilarity(a, b)),
        ),
      );

      if (best < 0.15) {
        addIssue(
          issues,
          "TITLE_CONFLICT",
          "blocking",
          `تعذر تأكيد تطابق اسم العمل بين ${first.source} و${second.source}.`,
          [first.source, second.source],
        );
      } else if (best < 0.3) {
        addIssue(
          issues,
          "TITLE_LOW_SIMILARITY",
          "warning",
          `تشابه الأسماء بين ${first.source} و${second.source} منخفض ويحتاج مراجعة.`,
          [first.source, second.source],
          true,
        );
      }
    }
  }

  return issues;
}

function validateAdultContent(
  aniList: AniListWork | null,
  kitsu: KitsuWork | null,
  tmdb: TmdbWork | null,
): WorkIssue[] {
  const issues: WorkIssue[] = [];

  if (aniList?.isAdult || kitsu?.isAdult || tmdb?.adult) {
    addIssue(
      issues,
      "ADULT_CONTENT",
      "blocking",
      "تم تصنيف العمل أو أحد سجلاته كمحتوى للبالغين؛ لن يتم تجهيزه للنشر.",
      sourceNames(
        aniList?.isAdult ? "anilist" : null,
        kitsu?.isAdult ? "kitsu" : null,
        tmdb?.adult ? "tmdb" : null,
      ),
    );
  }

  return issues;
}

// ============================================================
// NORMALIZATION
// ============================================================

function chooseTitle(
  ...values: (string | null | undefined)[]
): string | null {
  for (const value of values) {
    const clean = cleanString(value);

    if (clean) return clean;
  }

  return null;
}

function chooseStatus(
  tmdb: TmdbWork | null,
  aniList: AniListWork | null,
  kitsu: KitsuWork | null,
): WorkStatus {
  const specialized = aniList
    ? statusFromAniList(aniList.status)
    : kitsu
      ? statusFromKitsu(kitsu.status)
      : "UNKNOWN";

  if (specialized !== "UNKNOWN") return specialized;

  if (kitsu) {
    const status = statusFromKitsu(kitsu.status);
    if (status !== "UNKNOWN") return status;
  }

  if (tmdb) {
    return statusFromTmdb(
      tmdb.status,
      tmdb.inProduction,
      tmdb.lastAirDate,
    );
  }

  return "UNKNOWN";
}

function chooseEpisodeCount(
  tmdb: TmdbWork | null,
  aniList: AniListWork | null,
  kitsu: KitsuWork | null,
): number | null {
  const values = [
    aniList?.episodes ?? null,
    kitsu?.episodeCount ?? null,
    tmdb?.numberOfEpisodes ?? null,
  ].filter(
    (value): value is number => value !== null && value >= 0,
  );

  if (values.length === 0) return null;

  const counts = values.filter((value) => value > 0);

  if (counts.length === 0) return 0;

  const sorted = [...counts].sort((a, b) => a - b);

  return sorted[Math.floor(sorted.length / 2)];
}

function chooseRuntime(
  tmdb: TmdbWork | null,
  aniList: AniListWork | null,
  kitsu: KitsuWork | null,
): number | null {
  const value =
    tmdb?.runtimeMinutes ??
    aniList?.durationMinutes ??
    kitsu?.episodeLengthMinutes ??
    null;

  return value !== null && value > 0 ? value : null;
}

function chooseRating(
  tmdb: TmdbWork | null,
  aniList: AniListWork | null,
  kitsu: KitsuWork | null,
): NormalizedWork["rating"] {
  if (aniList?.averageScore !== null && aniList?.averageScore !== undefined) {
    return {
      value: aniList.averageScore / 10,
      scale: 10,
      source: "anilist",
      votes: aniList.popularity,
      confidence: aniList.popularity === null
        ? "medium"
        : aniList.popularity >= 100
          ? "high"
          : "low",
    };
  }

  if (
    tmdb?.voteAverage !== null &&
    tmdb?.voteAverage !== undefined &&
    tmdb.voteAverage > 0
  ) {
    return {
      value: tmdb.voteAverage,
      scale: 10,
      source: "tmdb",
      votes: tmdb.voteCount,
      confidence:
        tmdb.voteCount === null
          ? "medium"
          : tmdb.voteCount >= 100
            ? "high"
            : "low",
    };
  }

  if (
    kitsu?.averageRating !== null &&
    kitsu?.averageRating !== undefined
  ) {
    return {
      value: kitsu.averageRating / 10,
      scale: 10,
      source: "kitsu",
      votes: kitsu.userCount,
      confidence:
        kitsu.userCount === null
          ? "medium"
          : kitsu.userCount >= 100
            ? "high"
            : "low",
    };
  }

  return {
    value: null,
    scale: null,
    source: null,
    votes: null,
    confidence: "unknown",
  };
}

function chooseYear(
  tmdb: TmdbWork | null,
  aniList: AniListWork | null,
  kitsu: KitsuWork | null,
): number | null {
  return (
    aniList?.seasonYear ??
    yearFromDate(aniList?.startDate ?? null) ??
    yearFromDate(kitsu?.startDate ?? null) ??
    yearFromDate(
      tmdb?.mediaType === "tv"
        ? tmdb.firstAirDate
        : tmdb?.releaseDate ?? null,
    )
  );
}

function normalizeWork(
  ids: SourceIds,
  tmdb: TmdbWork | null,
  aniList: AniListWork | null,
  kitsu: KitsuWork | null,
  kind: WorkKind | null,
): NormalizedWork {
  const images = collectImages(tmdb, aniList, kitsu);

  const english = chooseTitle(
    aniList?.titleEnglish,
    tmdb?.translations.english.name,
    tmdb?.title,
    kitsu?.englishTitle,
    kitsu?.canonicalTitle,
  );

  const romaji = chooseTitle(
    aniList?.titleRomaji,
    kitsu?.englishJapaneseTitle,
    kitsu?.canonicalTitle,
  );

  const native = chooseTitle(
    aniList?.titleNative,
    tmdb?.translations.japanese.name,
    kitsu?.japaneseTitle,
    tmdb?.originalTitle,
  );

  const synopsisSources = [
    {
      source: "tmdb" as const,
      text: tmdb?.translations.english.overview ?? tmdb?.overview ?? "",
    },
    {
      source: "anilist" as const,
      text: aniList?.description ?? "",
    },
    {
      source: "kitsu" as const,
      text: kitsu?.synopsis ?? "",
    },
  ].filter((item) => item.text.trim().length > 0);

  const genres = uniqueStrings([
    ...(tmdb?.genres ?? []),
    ...(aniList?.genres ?? []),
    ...(kitsu?.genres ?? []),
  ]);

  return {
    ids,
    kind,
    titles: {
      english,
      romaji,
      native,
      arabic: tmdb?.translations.arabic.name ?? null,
    },
    year: chooseYear(tmdb, aniList, kitsu),
    status: chooseStatus(tmdb, aniList, kitsu),
    statusLabelAr: statusArabic(chooseStatus(tmdb, aniList, kitsu)),
    episodeCount: chooseEpisodeCount(tmdb, aniList, kitsu),
    seasonCount: tmdb?.numberOfSeasons ?? null,
    runtimeMinutes: chooseRuntime(tmdb, aniList, kitsu),
    rating: chooseRating(tmdb, aniList, kitsu),
    genres,
    synopsisSources,
    sourceUrls: {
      tmdb: tmdb
        ? `https://www.themoviedb.org/${tmdb.mediaType}/${tmdb.id}`
        : null,
      aniList: aniList?.siteUrl ?? null,
      kitsu: kitsu?.siteUrl ?? null,
      mal: aniList?.malId
        ? `https://myanimelist.net/anime/${aniList.malId}`
        : kitsu?.malId
          ? `https://myanimelist.net/anime/${kitsu.malId}`
          : null,
    },
    images,
    sourceAvailability: {
      tmdb: tmdb !== null,
      aniList: aniList !== null,
      kitsu: kitsu !== null,
    },
  };
}

// ============================================================
// RESEARCH ENGINE
// ============================================================

export async function researchAnime(
  env: Env,
  ids: SourceIds,
): Promise<AnimeResearchResult> {
  const [tmdbResult, aniListResult, kitsuResult] = await Promise.all([
    ids.tmdbId && ids.tmdbKind
      ? getTmdbWork(env, ids.tmdbId, ids.tmdbKind)
      : Promise.resolve(null),

    ids.aniListId
      ? getAniListWork(ids.aniListId)
      : Promise.resolve(null),

    ids.kitsuId
      ? getKitsuWork(ids.kitsuId)
      : Promise.resolve(null),
  ]);

  const tmdb = tmdbResult?.data ?? null;
  const aniList = aniListResult?.data ?? null;
  const kitsu = kitsuResult?.data ?? null;

  const sourceCalls = [
    tmdbResult?.call,
    aniListResult?.call,
    kitsuResult?.call,
  ].filter((item): item is SourceCall => item !== undefined);

  const classification = classifyWork(tmdb, aniList, kitsu);

  const issues: WorkIssue[] = [
    ...classification.issues,
    ...compareYears(tmdb, aniList, kitsu),
    ...compareTitles(tmdb, aniList, kitsu),
    ...validateAdultContent(aniList, kitsu, tmdb),
  ];

  if (!tmdb && !aniList && !kitsu) {
    addIssue(
      issues,
      "NO_SOURCE_DATA",
      "blocking",
      "لم نتمكن من الحصول على تفاصيل العمل من أي مصدر.",
      [],
    );
  }

  if (!aniList && !kitsu) {
    addIssue(
      issues,
      "NO_SPECIALIZED_SOURCE",
      "blocking",
      "لا توجد بيانات من AniList أو Kitsu لتأكيد تصنيف الأنمي.",
      tmdb ? ["tmdb"] : [],
    );
  }

  const work = normalizeWork(
    ids,
    tmdb,
    aniList,
    kitsu,
    classification.kind,
  );

  if (!work.titles.english && !work.titles.romaji && !work.titles.native) {
    addIssue(
      issues,
      "NO_USABLE_TITLE",
      "blocking",
      "لم يتم العثور على اسم موثوق للعمل.",
      sourceNames(
        tmdb ? "tmdb" : null,
        aniList ? "anilist" : null,
        kitsu ? "kitsu" : null,
      ),
    );
  }

  if (work.images.posters.length === 0) {
    addIssue(
      issues,
      "NO_POSTER",
      "warning",
      "لم يتم العثور على بوستر للعمل.",
      sourceNames(
        tmdb ? "tmdb" : null,
        aniList ? "anilist" : null,
        kitsu ? "kitsu" : null,
      ),
      true,
    );
  }

  const fieldConfidence: FieldConfidence[] = [
    {
      field: "kind",
      confidence: classification.confidence,
      sources: classification.sources,
      note: classification.reason,
    },
    {
      field: "title",
      confidence: work.titles.english ? "high" : "unknown",
      sources: sourceNames(
        aniList?.titleEnglish ? "anilist" : null,
        tmdb?.title ? "tmdb" : null,
        kitsu?.englishTitle ? "kitsu" : null,
      ),
      note: null,
    },
    {
      field: "status",
      confidence: work.status === "UNKNOWN" ? "unknown" : "medium",
      sources: sourceNames(
        aniList ? "anilist" : null,
        kitsu ? "kitsu" : null,
        tmdb ? "tmdb" : null,
      ),
      note: "الحالة قد تختلف بين قواعد البيانات.",
    },
    {
      field: "episodeCount",
      confidence: work.episodeCount === null ? "unknown" : "medium",
      sources: sourceNames(
        aniList?.episodes !== null && aniList?.episodes !== undefined
          ? "anilist"
          : null,
        kitsu?.episodeCount !== null && kitsu?.episodeCount !== undefined
          ? "kitsu"
          : null,
        tmdb?.numberOfEpisodes !== null && tmdb?.numberOfEpisodes !== undefined
          ? "tmdb"
          : null,
      ),
      note: null,
    },
    {
      field: "rating",
      confidence: work.rating.confidence,
      sources: work.rating.source ? [work.rating.source] : [],
      note: work.rating.votes === null
        ? "عدد المصوتين غير متوفر."
        : null,
    },
  ];

  return {
    work,
    classification,
    issues,
    fieldConfidence,
    sourceCalls,
    readyToCompose: !issues.some(
      (item) => item.severity === "blocking",
    ),
  };
}

// ============================================================
// DRAFT DATABASE HELPERS
// ============================================================

function makeTmdbKey(ids: SourceIds): string | null {
  if (!ids.tmdbId || !ids.tmdbKind) return null;

  return `${ids.tmdbKind}:${ids.tmdbId}`;
}

function draftToRecord(row: {
  id: string;
  status: DraftStatus;
  version: number;
  work_kind: string | null;
  display_title: string;
  tmdb_key: string | null;
  anilist_id: number | null;
  kitsu_id: string | null;
  data_json: string;
  synopsis_ar: string | null;
  arabic_title_suggestion: string | null;
  images_json: string;
  selected_image_url: string | null;
  resolutions_json: string;
  acknowledged_json: string;
  post_json: string | null;
  prepared_at_utc: string;
  data_collected_at_utc: string;
  revised_at_utc: string | null;
  created_at_utc: string;
  updated_at_utc: string;
}): DraftRecord {
  const work = parseJson<NormalizedWork>(
    row.data_json,
    {} as NormalizedWork,
  );

  const images = parseJson<ImageCollection>(
    row.images_json,
    { posters: [], backdrops: [] },
  );

  const resolution = parseJson<{
    issues?: WorkIssue[];
  }>(row.resolutions_json, {});

  const issues = Array.isArray(resolution.issues)
    ? resolution.issues
    : [];

  const acknowledgedIssues = parseJson<string[]>(
    row.acknowledged_json,
    [],
  );

  const ids: SourceIds = {
    tmdbId: row.tmdb_key
      ? integerOrNull(Number(row.tmdb_key.split(":")[1]))
      : null,
    tmdbKind: row.tmdb_key?.startsWith("tv:")
      ? "tv"
      : row.tmdb_key?.startsWith("movie:")
        ? "movie"
        : null,
    aniListId: row.anilist_id,
    malId: work.ids?.malId ?? null,
    kitsuId: row.kitsu_id,
  };

  return {
    id: row.id,
    status: row.status,
    version: row.version,
    workKind: row.work_kind as WorkKind | null,
    displayTitle: row.display_title,
    ids,
    work,
    synopsisArabic: row.synopsis_ar,
    arabicTitleSuggestion: row.arabic_title_suggestion,
    images,
    selectedImageUrl: row.selected_image_url,
    issues,
    acknowledgedIssues,
    post: parseJson<PreparedPost | null>(row.post_json, null),
    preparedAtUtc: row.prepared_at_utc,
    dataCollectedAtUtc: row.data_collected_at_utc,
    revisedAtUtc: row.revised_at_utc,
    createdAtUtc: row.created_at_utc,
    updatedAtUtc: row.updated_at_utc,
  };
}

const DRAFT_SELECT = `
SELECT
  id,
  status,
  version,
  work_kind,
  display_title,
  tmdb_key,
  anilist_id,
  kitsu_id,
  data_json,
  synopsis_ar,
  arabic_title_suggestion,
  images_json,
  selected_image_url,
  resolutions_json,
  acknowledged_json,
  post_json,
  prepared_at_utc,
  data_collected_at_utc,
  revised_at_utc,
  created_at_utc,
  updated_at_utc
FROM drafts
`;

export async function getDraft(
  env: Env,
  draftId: string,
): Promise<DraftRecord | null> {
  const row = await env.DB
    .prepare(`${DRAFT_SELECT} WHERE id = ? LIMIT 1`)
    .bind(draftId)
    .first<Parameters<typeof draftToRecord>[0]>();

  return row ? draftToRecord(row) : null;
}

async function findExistingDraft(
  env: Env,
  ids: SourceIds,
): Promise<DraftRecord | null> {
  const conditions: string[] = [];
  const values: (string | number)[] = [];

  const tmdbKey = makeTmdbKey(ids);

  if (tmdbKey) {
    conditions.push("tmdb_key = ?");
    values.push(tmdbKey);
  }

  if (ids.aniListId) {
    conditions.push("anilist_id = ?");
    values.push(ids.aniListId);
  }

  if (ids.kitsuId) {
    conditions.push("kitsu_id = ?");
    values.push(ids.kitsuId);
  }

  if (conditions.length === 0) return null;

  const sql = `
    ${DRAFT_SELECT}
    WHERE status <> 'archived'
      AND (${conditions.join(" OR ")})
    ORDER BY updated_at_utc DESC
    LIMIT 1
  `;

  const row = await env.DB
    .prepare(sql)
    .bind(...values)
    .first<Parameters<typeof draftToRecord>[0]>();

  return row ? draftToRecord(row) : null;
}

async function saveNewDraft(
  env: Env,
  research: AnimeResearchResult,
  synopsisArabic: string | null,
  arabicTitle: string | null,
): Promise<DraftRecord> {
  const now = nowUtc();
  const id = newId();

  const title =
    research.work.titles.english ??
    research.work.titles.romaji ??
    research.work.titles.native ??
    "Unknown anime";

  const ids = research.work.ids;
  const tmdbKey = makeTmdbKey(ids);

  const resolutions = {
    issues: research.issues,
    classification: research.classification,
    fieldConfidence: research.fieldConfidence,
  };

  const images = research.work.images;

  await env.DB.prepare(`
    INSERT INTO drafts (
      id,
      status,
      version,
      work_kind,
      display_title,
      tmdb_key,
      anilist_id,
      kitsu_id,
      data_json,
      synopsis_ar,
      arabic_title_suggestion,
      images_json,
      selected_image_url,
      resolutions_json,
      acknowledged_json,
      post_json,
      prepared_at_utc,
      data_collected_at_utc,
      revised_at_utc,
      created_at_utc,
      updated_at_utc
    )
    VALUES (?, 'open', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', NULL, ?, ?, NULL, ?, ?)
  `)
    .bind(
      id,
      research.work.kind,
      title,
      tmdbKey,
      ids.aniListId,
      ids.kitsuId,
      JSON.stringify(research.work),
      synopsisArabic,
      arabicTitle,
      JSON.stringify(images),
      null,
      JSON.stringify(resolutions),
      now,
      now,
      now,
      now,
    )
    .run();

  const saved = await getDraft(env, id);

  if (!saved) {
    throw new Error("تعذر استرجاع المسودة بعد حفظها.");
  }

  return saved;
}

async function updateDraftFields(
  env: Env,
  draft: DraftRecord,
  changes: {
    synopsisArabic?: string | null;
    arabicTitleSuggestion?: string | null;
    images?: ImageCollection;
    selectedImageUrl?: string | null;
    acknowledgedIssues?: string[];
    post?: PreparedPost | null;
  },
): Promise<DraftRecord> {
  if (draft.status !== "open") {
    throw new Error("هذه المسودة غير قابلة للتعديل حالياً.");
  }

  const synopsis =
    changes.synopsisArabic === undefined
      ? draft.synopsisArabic
      : changes.synopsisArabic;

  const arabicTitle =
    changes.arabicTitleSuggestion === undefined
      ? draft.arabicTitleSuggestion
      : changes.arabicTitleSuggestion;

  const images = changes.images ?? draft.images;

  const selectedImage =
    changes.selectedImageUrl === undefined
      ? draft.selectedImageUrl
      : changes.selectedImageUrl;

  const acknowledged =
    changes.acknowledgedIssues ?? draft.acknowledgedIssues;

  const post =
    changes.post === undefined
      ? draft.post
      : changes.post;

  const now = nowUtc();

  // Every content-changing edit invalidates the prepared post.
  const contentChanged =
    changes.synopsisArabic !== undefined ||
    changes.arabicTitleSuggestion !== undefined ||
    changes.images !== undefined ||
    changes.selectedImageUrl !== undefined;

  const nextPost = contentChanged ? null : post;

  const result = await env.DB.prepare(`
    UPDATE drafts
    SET
      version = version + 1,
      synopsis_ar = ?,
      arabic_title_suggestion = ?,
      images_json = ?,
      selected_image_url = ?,
      acknowledged_json = ?,
      post_json = ?,
      revised_at_utc = ?,
      updated_at_utc = ?
    WHERE id = ?
      AND version = ?
      AND status = 'open'
  `)
    .bind(
      synopsis,
      arabicTitle,
      JSON.stringify(images),
      selectedImage,
      JSON.stringify(acknowledged),
      nextPost ? JSON.stringify(nextPost) : null,
      now,
      now,
      draft.id,
      draft.version,
    )
    .run();

  if (!result.success || result.meta.changes !== 1) {
    throw new Error(
      "لم يتم تحديث المسودة؛ ربما تغيرت نسخة أخرى منها. أعد تحميل المسودة.",
    );
  }

  const updated = await getDraft(env, draft.id);

  if (!updated) {
    throw new Error("تعذر استرجاع المسودة بعد التعديل.");
  }

  return updated;
}

// ============================================================
// DRAFT CREATION
// ============================================================

export async function createDraft(
  env: Env,
  input: {
    ids: SourceIds;
    synopsisArabic?: string;
    arabicTitle?: string;
  },
): Promise<PreparePostResult> {
  const research = await researchAnime(env, input.ids);

  const synopsis = cleanString(input.synopsisArabic);
  const arabicTitle = cleanString(input.arabicTitle);

  if (synopsis && synopsis.length > MAX_SYNOPSIS_LENGTH) {
    return {
      success: false,
      draft: null,
      post: null,
      issues: [],
      message: `الوصف العربي تجاوز الحد ${MAX_SYNOPSIS_LENGTH} حرفاً.`,
    };
  }

  if (research.issues.some((item) => item.severity === "blocking")) {
    return {
      success: false,
      draft: null,
      post: null,
      issues: research.issues,
      message:
        "لا يمكن إنشاء مسودة جاهزة بسبب وجود مشكلات أساسية في البيانات. راجع التعارضات أولاً.",
    };
  }

  const existing = await findExistingDraft(env, research.work.ids);

  if (existing) {
    return {
      success: false,
      draft: existing,
      post: existing.post,
      issues: existing.issues,
      message:
        existing.status === "published"
          ? "هذا العمل موجود في الأرشيف بحالة منشور؛ لن يتم إنشاء نسخة مكررة."
          : "توجد مسودة سابقة لهذا العمل. استرجعتها بدلاً من إنشاء نسخة مكررة.",
    };
  }

  try {
    const draft = await saveNewDraft(
      env,
      research,
      synopsis,
      arabicTitle,
    );

    return {
      success: true,
      draft,
      post: null,
      issues: research.issues,
      message: "تم إنشاء المسودة وحفظ بيانات البحث بنجاح.",
    };
  } catch (error) {
    // A concurrent request may have created the same draft.
    const duplicate = await findExistingDraft(env, research.work.ids);

    if (duplicate) {
      return {
        success: false,
        draft: duplicate,
        post: duplicate.post,
        issues: duplicate.issues,
        message: "وجدت مسودة أخرى لنفس العمل؛ تم استرجاعها.",
      };
    }

    throw error;
  }
}

// ============================================================
// DRAFT EDITING
// ============================================================

export async function updateDraftSynopsis(
  env: Env,
  draftId: string,
  synopsisArabic: string,
  arabicTitle?: string,
): Promise<DraftRecord> {
  const synopsis = cleanString(synopsisArabic);

  if (!synopsis) {
    throw new Error("الوصف العربي لا يمكن أن يكون فارغاً.");
  }

  if (synopsis.length > MAX_SYNOPSIS_LENGTH) {
    throw new Error(
      `الوصف العربي تجاوز الحد ${MAX_SYNOPSIS_LENGTH} حرفاً.`,
    );
  }

  const draft = await getDraft(env, draftId);

  if (!draft) throw new Error("المسودة غير موجودة.");

  return updateDraftFields(env, draft, {
    synopsisArabic: synopsis,
    ...(arabicTitle !== undefined
      ? { arabicTitleSuggestion: cleanString(arabicTitle) }
      : {}),
  });
}

export async function selectDraftImages(
  env: Env,
  draftId: string,
  imageUrls: string[],
): Promise<DraftRecord> {
  const draft = await getDraft(env, draftId);

  if (!draft) throw new Error("المسودة غير موجودة.");

  if (!Array.isArray(imageUrls) || imageUrls.length < 1 || imageUrls.length > 10) {
    throw new Error("يجب اختيار صورة واحدة إلى عشر صور.");
  }

  const available = [
    ...draft.images.posters,
    ...draft.images.backdrops,
  ];

  const uniqueUrls = [...new Set(imageUrls)];

  const selected = uniqueUrls.map((url) => {
    const image = available.find((item) => item.url === url);

    if (!image) {
      throw new Error("تم اختيار رابط صورة غير موجود ضمن نتائج البحث.");
    }

    return image;
  });

  const selectedIds = new Set(selected.map((item) => item.id));

  const images: ImageCollection = {
    posters: draft.images.posters.map((item) => ({
      ...item,
      selected: selectedIds.has(item.id),
    })),
    backdrops: draft.images.backdrops.map((item) => ({
      ...item,
      selected: selectedIds.has(item.id),
    })),
  };

  return updateDraftFields(env, draft, {
    images,
    selectedImageUrl: selected[0].url,
  });
}

export async function acknowledgeDraftIssues(
  env: Env,
  draftId: string,
  issueCodes: string[],
): Promise<DraftRecord> {
  const draft = await getDraft(env, draftId);

  if (!draft) throw new Error("المسودة غير موجودة.");

  const allowed = new Set(
    draft.issues
      .filter((item) =>
        item.requiresAcknowledgement &&
        item.severity !== "blocking",
      )
      .map((item) => item.code),
  );

  for (const code of issueCodes) {
    if (!allowed.has(code)) {
      throw new Error(
        `لا يمكن تجاوز المشكلة ${code}. المشكلات الأساسية لا تقبل الإقرار لتجاوزها.`,
      );
    }
  }

  const acknowledged = [
    ...new Set([
      ...draft.acknowledgedIssues,
      ...issueCodes,
    ]),
  ];

  return updateDraftFields(env, draft, {
    acknowledgedIssues: acknowledged,
  });
}

// ============================================================
// POST COMPOSITION
// ============================================================

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function kindArabic(kind: WorkKind): string {
  switch (kind) {
    case "TV":
      return "مسلسل أنمي";
    case "MOVIE":
      return "فيلم أنمي";
    case "OVA":
      return "أنمي OVA";
  }
}

function formatRuntime(minutes: number | null): string | null {
  if (!minutes || minutes <= 0) return null;

  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;

  if (hours === 0) return `${minutes} دقيقة`;
  if (remainder === 0) return `${hours} ساعة`;

  return `${hours} ساعة و${remainder} دقيقة`;
}

function buildPostText(
  draft: DraftRecord,
  synopsis: string,
  arabicTitle: string | null,
): string {
  const work = draft.work;
  const title = arabicTitle ??
    work.titles.english ??
    work.titles.romaji ??
    work.titles.native ??
    draft.displayTitle;

  const lines: string[] = [];

  lines.push(`🎬 ${escapeHtml(title)}`);

  const alternateTitles = uniqueStrings([
    work.titles.english,
    work.titles.romaji,
    work.titles.native,
  ]).filter((item) => normalizeTitle(item) !== normalizeTitle(title));

  if (alternateTitles.length > 0) {
    lines.push(`🌐 ${alternateTitles.map(escapeHtml).join(" | ")}`);
  }

  lines.push("");
  lines.push(`📌 النوع: ${kindArabic(work.kind!)}`);

  if (work.year) {
    lines.push(`📅 سنة الإصدار: ${work.year}`);
  }

  lines.push(`📺 الحالة: ${work.statusLabelAr}`);

  if (work.kind === "TV" || work.kind === "OVA") {
    if (work.episodeCount !== null) {
      lines.push(`🎞️ عدد الحلقات: ${work.episodeCount}`);
    }

    if (work.seasonCount !== null && work.kind === "TV") {
      lines.push(`📚 عدد المواسم: ${work.seasonCount}`);
    }
  }

  if (work.kind === "MOVIE" && work.runtimeMinutes !== null) {
    const runtime = formatRuntime(work.runtimeMinutes);

    if (runtime) lines.push(`⏱️ المدة: ${runtime}`);
  }

  if (work.rating.value !== null) {
    lines.push(
      `⭐ التقييم: ${work.rating.value.toFixed(1)}/10 (${work.rating.source})`,
    );
  }

  if (work.genres.length > 0) {
    lines.push(`🏷️ التصنيفات: ${work.genres.slice(0, 8).join("، ")}`);
  }

  lines.push("");
  lines.push("📖 القصة:");
  lines.push(escapeHtml(synopsis));

  lines.push("");
  lines.push(
    `🕒 آخر تحديث للمعلومات: ${formatBaghdadDate(draft.dataCollectedAtUtc)} بتوقيت العراق`,
  );

  lines.push("");
  lines.push("© Anime Elara");

  return lines.join("\n");
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);

  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function composeDraftPost(
  env: Env,
  draftId: string,
): Promise<PreparedPost> {
  let draft = await getDraft(env, draftId);

  if (!draft) throw new Error("المسودة غير موجودة.");

  if (draft.status !== "open") {
    throw new Error("لا يمكن تجهيز منشور لمسودة مغلقة.");
  }

  if (!draft.work.kind) {
    throw new Error("نوع العمل غير محدد.");
  }

  const blocking = draft.issues.filter(
    (item) => item.severity === "blocking",
  );

  if (blocking.length > 0) {
    throw new Error(
      `توجد مشكلات تمنع تجهيز المنشور: ${blocking.map((item) => item.code).join(", ")}`,
    );
  }

  const unacknowledged = draft.issues.filter(
    (item) =>
      item.requiresAcknowledgement &&
      !draft!.acknowledgedIssues.includes(item.code),
  );

  if (unacknowledged.length > 0) {
    throw new Error(
      `تحتاج مراجعة هذه التنبيهات قبل تجهيز المنشور: ${unacknowledged.map((item) => item.code).join(", ")}`,
    );
  }

  const synopsis = cleanString(draft.synopsisArabic);

  if (!synopsis) {
    throw new Error(
      "أضف وصف القصة باللغة العربية قبل تجهيز المنشور.",
    );
  }

  if (synopsis.length > MAX_SYNOPSIS_LENGTH) {
    throw new Error("الوصف العربي أطول من الحد المسموح.");
  }

  const selected = [
    ...draft.images.posters,
    ...draft.images.backdrops,
  ].filter((item) => item.selected);

  const imageUrls = selected.length > 0
    ? selected.map((item) => item.url)
    : draft.images.posters[0]
      ? [draft.images.posters[0].url]
      : [];

  if (imageUrls.length === 0) {
    throw new Error("لا توجد صورة مختارة للمنشور.");
  }

  if (imageUrls.length > 10) {
    throw new Error("الحد الأعلى للألبوم هو 10 صور.");
  }

  const text = buildPostText(
    draft,
    synopsis,
    draft.arabicTitleSuggestion,
  );

  const imageMode = imageUrls.length === 1 ? "single" : "album";

  const caption = clipText(text, MAX_CAPTION_LENGTH);

  const content = {
    draftId: draft.id,
    draftVersion: draft.version,
    title:
      draft.arabicTitleSuggestion ??
      draft.work.titles.english ??
      draft.displayTitle,
    text,
    caption,
    imageUrls,
    imageMode,
    workKind: draft.work.kind,
    preparedAtUtc: nowUtc(),
  };

  const contentHash = await sha256(
    JSON.stringify(content),
  );

  const post: PreparedPost = {
    ...content,
    contentHash,
  };

  draft = await updateDraftFields(env, draft, {
    post,
  });

  return draft.post!;
}

// ============================================================
// DRAFT LISTING AND ARCHIVING
// ============================================================

export async function listDrafts(
  env: Env,
  status: DraftStatus | "all" = "all",
  limit = 20,
): Promise<DraftRecord[]> {
  const safeLimit = Math.min(
    Math.max(Math.trunc(limit), 1),
    100,
  );

  const sql = status === "all"
    ? `${DRAFT_SELECT} ORDER BY updated_at_utc DESC LIMIT ?`
    : `${DRAFT_SELECT} WHERE status = ? ORDER BY updated_at_utc DESC LIMIT ?`;

  const statement = env.DB.prepare(sql);

  const result = status === "all"
    ? await statement.bind(safeLimit).all<Parameters<typeof draftToRecord>[0]>()
    : await statement.bind(status, safeLimit).all<Parameters<typeof draftToRecord>[0]>();

  return (result.results ?? []).map(draftToRecord);
}

export async function archiveDraft(
  env: Env,
  draftId: string,
): Promise<boolean> {
  const draft = await getDraft(env, draftId);

  if (!draft) return false;

  if (draft.status === "published" || draft.status === "locked") {
    throw new Error(
      "لا يمكن أرشفة مسودة منشورة أو مقفلة بسبب عملية نشر.",
    );
  }

  const result = await env.DB.prepare(`
    UPDATE drafts
    SET
      status = 'archived',
      version = version + 1,
      post_json = NULL,
      updated_at_utc = ?
    WHERE id = ?
      AND status = 'open'
      AND version = ?
  `)
    .bind(nowUtc(), draftId, draft.version)
    .run();

  return result.success && result.meta.changes === 1;
}

// ============================================================
// PUBLIC UTILITY
// ============================================================

export function getEngineInfo() {
  return {
    name: "Anime Elara Engine",
    version: "1.0.0",
    supportedKinds: ["TV", "MOVIE", "OVA"],
    sources: ["TMDB", "AniList", "Kitsu"],
    channel: CHANNEL_NAME,
    automaticPublishing: false,
    approvalWorkflow: false,
  };
}
