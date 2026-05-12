-- =============================================================
-- Midnight Event Cache schema
--
-- Stores the raw chain events we subscribe to from the indexer so
-- the fast-sync endpoint can replay them with viewing keys without
-- the client needing to re-fetch from the indexer.
--
-- One database per network — recommended naming:
--   midnight_cache_preview, midnight_cache_preprod, midnight_cache_mainnet
-- =============================================================

CREATE TABLE IF NOT EXISTS zswap_events (
  id                INT PRIMARY KEY,           -- indexer's stream id
  raw_hex           MEDIUMTEXT NOT NULL,        -- hex-encoded event payload
  protocol_version  INT,
  max_id_at_fetch   INT,                       -- chain tip when we fetched this event
  fetched_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_fetched (fetched_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS dust_events (
  id                INT PRIMARY KEY,
  raw_hex           MEDIUMTEXT NOT NULL,
  event_type        VARCHAR(64),
  max_id_at_fetch   INT,
  fetched_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_fetched (fetched_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Tracks daemon state per stream (so we can resume after restart)
CREATE TABLE IF NOT EXISTS cache_state (
  stream         VARCHAR(32) PRIMARY KEY,    -- 'zswap' | 'dust'
  last_id        INT NOT NULL DEFAULT 0,
  highest_seen   INT NOT NULL DEFAULT 0,
  updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Pre-fill stream entries so we never have to upsert from app code
INSERT IGNORE INTO cache_state (stream, last_id) VALUES ('zswap', 0), ('dust', 0);
