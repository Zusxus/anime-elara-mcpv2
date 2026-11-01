
-- ============================================================
-- Anime Elara
-- D1 Database Schema
-- Migration: 0001_init.sql
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============================================================
-- 1. DRAFTS
-- One record per anime work.
-- ============================================================

CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY NOT NULL,

    -- Draft lifecycle
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (
            status IN (
                'open',
                'locked',
                'publishing',
                'published',
                'publish_unknown',
                'archived'
            )
        ),

    version INTEGER NOT NULL DEFAULT 1
        CHECK (version >= 1),

    -- Work identity
    work_kind TEXT NOT NULL
        CHECK (
            work_kind IN (
                'TV',
                'MOVIE',
                'OVA'
            )
        ),

    display_title TEXT NOT NULL,

    -- Source identifiers
    tmdb_key TEXT,
    anilist_id INTEGER,
    kitsu_id TEXT,

    -- Complete normalized research data
    data_json TEXT NOT NULL
        CHECK (json_valid(data_json)),

    -- Arabic editorial content
    synopsis_ar TEXT,
    arabic_title_suggestion TEXT,

    -- Image candidates and selection
    images_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(images_json)),

    selected_image_url TEXT,

    -- Issues and acknowledgements
    resolutions_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(resolutions_json)),

    acknowledged_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(acknowledged_json)),

    -- Prepared Telegram post snapshot
    post_json TEXT
        CHECK (
            post_json IS NULL
            OR json_valid(post_json)
        ),

    prepared_at_utc TEXT,

    -- Timestamps
    data_collected_at_utc TEXT,
    revised_at_utc TEXT,

    created_at_utc TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL,

    -- A draft cannot be published without its basic identity.
    CHECK (length(display_title) > 0),

    -- Prevent accidental empty source identifiers.
    CHECK (tmdb_key IS NULL OR length(tmdb_key) > 0),
    CHECK (kitsu_id IS NULL OR length(kitsu_id) > 0)
);

-- One draft per TMDB work.
CREATE UNIQUE INDEX IF NOT EXISTS ux_drafts_tmdb
ON drafts(tmdb_key)
WHERE tmdb_key IS NOT NULL;

-- One draft per AniList work.
CREATE UNIQUE INDEX IF NOT EXISTS ux_drafts_anilist
ON drafts(anilist_id)
WHERE anilist_id IS NOT NULL;

-- One draft per Kitsu work.
CREATE UNIQUE INDEX IF NOT EXISTS ux_drafts_kitsu
ON drafts(kitsu_id)
WHERE kitsu_id IS NOT NULL;

-- Useful draft listings.
CREATE INDEX IF NOT EXISTS ix_drafts_status_updated
ON drafts(status, updated_at_utc DESC);

CREATE INDEX IF NOT EXISTS ix_drafts_created
ON drafts(created_at_utc DESC);

-- ============================================================
-- 2. PUBLICATIONS
-- Records actual attempts to publish a draft.
-- ============================================================

CREATE TABLE IF NOT EXISTS publications (
    id TEXT PRIMARY KEY NOT NULL,

    draft_id TEXT NOT NULL,

    status TEXT NOT NULL
        CHECK (
            status IN (
                'publishing',
                'published',
                'failed',
                'publish_unknown',
                'cancelled'
            )
        ),

    -- Immutable snapshot of the published content.
    content_hash TEXT NOT NULL,

    post_snapshot_json TEXT NOT NULL
        CHECK (json_valid(post_snapshot_json)),

    -- Telegram result
    telegram_message_ids_json TEXT
        CHECK (
            telegram_message_ids_json IS NULL
            OR json_valid(telegram_message_ids_json)
        ),

    telegram_chat_id TEXT,

    error_message TEXT,

    started_at_utc TEXT NOT NULL,
    completed_at_utc TEXT,

    FOREIGN KEY (draft_id)
        REFERENCES drafts(id)
        ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS ix_pub_draft
ON publications(draft_id);

CREATE INDEX IF NOT EXISTS ix_pub_status
ON publications(status, started_at_utc DESC);

-- A draft may have only one active, uncertain or successful
-- publication record. A definitively failed attempt may be retried.
CREATE UNIQUE INDEX IF NOT EXISTS ux_pub_one_live_per_draft
ON publications(draft_id)
WHERE status IN (
    'publishing',
    'published',
    'publish_unknown'
);

-- ============================================================
-- 3. EVENTS
-- Append-only history of important operations.
-- ============================================================

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    draft_id TEXT,

    publication_id TEXT,

    event_type TEXT NOT NULL,

    details_json TEXT NOT NULL DEFAULT '{}'
        CHECK (json_valid(details_json)),

    created_at_utc TEXT NOT NULL,

    FOREIGN KEY (draft_id)
        REFERENCES drafts(id)
        ON DELETE SET NULL,

    FOREIGN KEY (publication_id)
        REFERENCES publications(id)
        ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS ix_events_draft
ON events(draft_id, created_at_utc DESC);

CREATE INDEX IF NOT EXISTS ix_events_pub
ON events(publication_id, created_at_utc DESC);

CREATE INDEX IF NOT EXISTS ix_events_type
ON events(event_type, created_at_utc DESC);

-- ============================================================
-- 4. DATABASE VERSION
-- ============================================================

CREATE TABLE IF NOT EXISTS schema_info (
    version INTEGER PRIMARY KEY,
    applied_at_utc TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_info (
    version,
    applied_at_utc
)
VALUES (
    1,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
