
/**
 * Anime Elara
 * Shared Types
 *
 * Version: 1.0.0
 *
 * This file contains shared data contracts used by:
 * - engine.ts
 * - index.ts
 *
 * Supported work types:
 * - TV
 * - MOVIE
 * - OVA
 *
 * No approval workflow.
 * Publishing requires an explicit user command.
 */

// ============================================================
// ENVIRONMENT
// ============================================================

declare global {
  interface Env {
    TELEGRAM_BOT_TOKEN: string;
    MCP_ACCESS_TOKEN: string;
    TMDB_READ_TOKEN: string;
    DB: D1Database;
  }
}

export {};

// ============================================================
// GENERAL
// ============================================================

export type SourceName = "tmdb" | "anilist" | "kitsu";

export type WorkKind = "TV" | "MOVIE" | "OVA";

export type ImageKind = "poster" | "backdrop";

export type WorkStatus =
  | "FINISHED"
  | "RELEASING"
  | "NOT_YET_RELEASED"
  | "CANCELLED"
  | "HIATUS"
  | "UNKNOWN";

export type ConfidenceLevel =
  | "high"
  | "medium"
  | "low"
  | "unknown";

export type IssueSeverity =
  | "info"
  | "warning"
  | "blocking";

// ============================================================
// SOURCE REQUEST INFORMATION
// ============================================================

export interface SourceCall {
  source: SourceName;
  endpoint: string;
  httpStatus: number | null;
  elapsedMs: number;
  success: boolean;
  error: string | null;
}

export interface SourceResult<T> {
  source: SourceName;
  success: boolean;
  data: T | null;
  call: SourceCall;
  error: string | null;
}

// ============================================================
// SOURCE IDENTIFIERS
// ============================================================

export interface SourceIds {
  tmdbId: number | null;
  tmdbKind: "tv" | "movie" | null;

  aniListId: number | null;
  malId: number | null;

  kitsuId: string | null;
}

// ============================================================
// IMAGES
// ============================================================

export interface ImageCandidate {
  id: string;

  source: SourceName;

  kind: ImageKind;

  url: string;

  originalUrl: string;

  language: string | null;

  width: number | null;

  height: number | null;

  aspectRatio: number | null;

  voteAverage: number | null;

  voteCount: number | null;

  reviewed: boolean;

  selected: boolean;
}

export interface ImageCollection {
  posters: ImageCandidate[];
  backdrops: ImageCandidate[];
}

// ============================================================
// TMDB
// ============================================================

export type TmdbKind = "tv" | "movie";

export interface TmdbSearchResult {
  id: number;

  mediaType: TmdbKind;

  title: string | null;

  originalTitle: string | null;

  originalLanguage: string | null;

  releaseYear: number | null;

  isAnimation: boolean;

  overview: string | null;

  posterUrl: string | null;
}

export interface TmdbTranslation {
  available: boolean;

  name: string | null;

  overview: string | null;
}

export interface TmdbSeason {
  seasonNumber: number;

  name: string | null;

  episodeCount: number | null;

  airDate: string | null;
}

export interface TmdbSeasonReport {
  available: boolean;

  reportedSeasonCount: number;

  seasons: TmdbSeason[];

  mainEpisodeCount: number | null;

  specialEpisodeCount: number | null;

  totalEpisodeCount: number | null;

  reportedEpisodeCount: number | null;

  comparison:
    | "match"
    | "match_with_specials"
    | "mismatch"
    | "incomplete"
    | "unavailable";
}

export interface TmdbWork {
  id: number;

  mediaType: TmdbKind;

  title: string | null;

  originalTitle: string | null;

  originalLanguage: string | null;

  overview: string | null;

  firstAirDate: string | null;

  lastAirDate: string | null;

  releaseDate: string | null;

  status: string | null;

  inProduction: boolean | null;

  numberOfSeasons: number | null;

  numberOfEpisodes: number | null;

  runtimeMinutes: number | null;

  voteAverage: number | null;

  voteCount: number | null;

  genres: string[];

  adult: boolean;

  homepage: string | null;

  externalIds: {
    imdbId: string | null;
    tvdbId: number | null;
    wikidataId: string | null;
  };

  translations: {
    english: TmdbTranslation;
    arabic: TmdbTranslation;
    japanese: TmdbTranslation;
  };

  seasonReport: TmdbSeasonReport | null;

  images: ImageCollection;
}

// ============================================================
// ANILIST
// ============================================================

export interface AniListSearchResult {
  id: number;

  malId: number | null;

  format: string | null;

  status: string | null;

  episodes: number | null;

  seasonYear: number | null;

  titleRomaji: string | null;

  titleEnglish: string | null;

  titleNative: string | null;

  siteUrl: string | null;

  isAdult: boolean;
}

export interface AniListWork {
  id: number;

  malId: number | null;

  format: string | null;

  status: string | null;

  episodes: number | null;

  durationMinutes: number | null;

  seasonYear: number | null;

  startDate: string | null;

  endDate: string | null;

  titleRomaji: string | null;

  titleEnglish: string | null;

  titleNative: string | null;

  genres: string[];

  averageScore: number | null;

  popularity: number | null;

  description: string | null;

  siteUrl: string | null;

  isAdult: boolean;

  countryOfOrigin: string | null;

  nextAiringEpisode: {
    episode: number;
    airingAt: number;
  } | null;

  coverImageUrl: string | null;

  bannerImageUrl: string | null;
}

// ============================================================
// KITSU
// ============================================================

export interface KitsuSearchResult {
  id: string;

  subtype: string | null;

  status: string | null;

  episodeCount: number | null;

  startDate: string | null;

  canonicalTitle: string | null;

  englishTitle: string | null;

  japaneseTitle: string | null;

  isAdult: boolean;
}

export interface KitsuWork {
  id: string;

  slug: string | null;

  subtype: string | null;

  status: string | null;

  episodeCount: number | null;

  episodeLengthMinutes: number | null;

  startDate: string | null;

  endDate: string | null;

  canonicalTitle: string | null;

  englishTitle: string | null;

  englishJapaneseTitle: string | null;

  japaneseTitle: string | null;

  synopsis: string | null;

  averageRating: number | null;

  userCount: number | null;

  ageRating: string | null;

  ageRatingGuide: string | null;

  isAdult: boolean;

  posterUrl: string | null;

  coverUrl: string | null;

  genres: string[];

  mappings: {
    site: string;
    id: string;
  }[];

  aniListId: number | null;

  malId: number | null;

  siteUrl: string;
}

// ============================================================
// NORMALIZED WORK
// ============================================================

/**
 * Unified representation of an anime.
 *
 * The engine combines information from available sources.
 * Every field may be unavailable; missing information
 * must never be invented.
 */

export interface NormalizedWork {
  ids: SourceIds;

  kind: WorkKind | null;

  titles: {
    english: string | null;
    romaji: string | null;
    native: string | null;
    arabic: string | null;
  };

  year: number | null;

  status: WorkStatus;

  statusLabelAr: string;

  episodeCount: number | null;

  seasonCount: number | null;

  runtimeMinutes: number | null;

  rating: {
    value: number | null;
    scale: number | null;
    source: SourceName | null;
    votes: number | null;
    confidence: ConfidenceLevel;
  };

  genres: string[];

  synopsisSources: {
    source: SourceName;
    text: string;
  }[];

  sourceUrls: {
    tmdb: string | null;
    aniList: string | null;
    kitsu: string | null;
    mal: string | null;
  };

  images: ImageCollection;

  sourceAvailability: {
    tmdb: boolean;
    aniList: boolean;
    kitsu: boolean;
  };
}

// ============================================================
// DATA QUALITY AND CLASSIFICATION
// ============================================================

export interface WorkIssue {
  code: string;

  severity: IssueSeverity;

  message: string;

  sources: SourceName[];

  requiresAcknowledgement: boolean;
}

export interface FieldConfidence {
  field: string;

  confidence: ConfidenceLevel;

  sources: SourceName[];

  note: string | null;
}

export interface ClassificationResult {
  kind: WorkKind | null;

  confidence: ConfidenceLevel;

  sources: SourceName[];

  reason: string;

  issues: WorkIssue[];
}

// ============================================================
// DRAFTS
// ============================================================

export type DraftStatus =
  | "open"
  | "locked"
  | "published"
  | "archived";

export interface DraftRecord {
  id: string;

  status: DraftStatus;

  version: number;

  workKind: WorkKind | null;

  displayTitle: string;

  ids: SourceIds;

  work: NormalizedWork;

  synopsisArabic: string | null;

  arabicTitleSuggestion: string | null;

  images: ImageCollection;

  selectedImageUrl: string | null;

  issues: WorkIssue[];

  acknowledgedIssues: string[];

  post: PreparedPost | null;

  preparedAtUtc: string;

  dataCollectedAtUtc: string;

  revisedAtUtc: string | null;

  createdAtUtc: string;

  updatedAtUtc: string;
}

// ============================================================
// POST COMPOSITION
// ============================================================

export interface PreparedPost {
  draftId: string;

  draftVersion: number;

  title: string;

  text: string;

  caption: string;

  imageUrls: string[];

  imageMode: "single" | "album";

  workKind: WorkKind;

  preparedAtUtc: string;

  contentHash: string;
}

// ============================================================
// PUBLICATIONS
// ============================================================

export type PublicationKind =
  | "text"
  | "photo"
  | "album";

export type PublicationStatus =
  | "publishing"
  | "published"
  | "failed"
  | "publish_unknown"
  | "cancelled";

export interface PublicationRecord {
  id: string;

  draftId: string | null;

  draftVersion: number | null;

  kind: PublicationKind;

  payload: {
    text?: string;
    caption?: string;
    imageUrls?: string[];
  };

  payloadHash: string;

  status: PublicationStatus;

  createdAtUtc: string;

  publishStartedAtUtc: string | null;

  publishFinishedAtUtc: string | null;

  telegramMessageIds: number[];

  telegramSummary: string | null;

  errorText: string | null;
}

// ============================================================
// TELEGRAM
// ============================================================

export interface TelegramApiResponse<T = unknown> {
  ok: boolean;

  description?: string;

  result?: T;
}

export interface TelegramMessage {
  message_id: number;

  chat?: {
    id: number;
    title?: string;
    username?: string;
  };

  date?: number;
}

export interface TelegramPublishResult {
  success: boolean;

  status: "published" | "failed" | "publish_unknown";

  messageIds: number[];

  summary: string;

  error: string | null;
}

// ============================================================
// ENGINE RESULTS
// ============================================================

export interface AnimeSearchResult {
  query: string;

  results: {
    ids: SourceIds;

    kind: WorkKind | null;

    title: string;

    originalTitle: string | null;

    year: number | null;

    posterUrl: string | null;

    source: SourceName;

    confidence: ConfidenceLevel;
  }[];

  sourceErrors: string[];
}

export interface AnimeResearchResult {
  work: NormalizedWork;

  classification: ClassificationResult;

  issues: WorkIssue[];

  fieldConfidence: FieldConfidence[];

  sourceCalls: SourceCall[];

  readyToCompose: boolean;
}

export interface PreparePostResult {
  success: boolean;

  draft: DraftRecord | null;

  post: PreparedPost | null;

  issues: WorkIssue[];

  message: string;
}

// ============================================================
// DATABASE
// ============================================================

export interface DatabaseDraftRow {
  id: string;

  status: DraftStatus;

  version: number;

  work_kind: WorkKind | null;

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
}

export interface DatabasePublicationRow {
  id: string;

  draft_id: string | null;

  draft_version: number | null;

  kind: PublicationKind;

  payload_json: string;

  payload_hash: string;

  status: PublicationStatus;

  created_at_utc: string;

  publish_started_at_utc: string | null;

  publish_finished_at_utc: string | null;

  telegram_message_ids: string | null;

  telegram_summary: string | null;

  error_text: string | null;
}

export interface DatabaseEventRow {
  id: number;

  at_utc: string;

  draft_id: string | null;

  publication_id: string | null;

  type: string;

  detail_json: string | null;
}
