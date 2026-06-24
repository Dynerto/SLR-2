CREATE TABLE schema_migrations (
  version VARCHAR(32) NOT NULL,
  applied_at DATETIME NOT NULL,
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE views (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  page VARCHAR(32) NOT NULL,
  path VARCHAR(255) NOT NULL,
  ip VARCHAR(45) NOT NULL,
  user_agent TEXT NULL,
  referer TEXT NULL,
  viewed_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  INDEX idx_views_page (page),
  INDEX idx_views_viewed_at (viewed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE crawl_sites (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(160) NOT NULL,
  base_url VARCHAR(500) NOT NULL,
  login_url VARCHAR(500) NOT NULL,
  username VARCHAR(255) NOT NULL,
  password_encrypted TEXT NOT NULL,
  allowed_hosts TEXT NOT NULL,
  crawl_notes TEXT NULL,
  allow_purchases TINYINT(1) NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  INDEX idx_crawl_sites_active (active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE crawl_jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  site_id BIGINT UNSIGNED NOT NULL,
  status VARCHAR(32) NOT NULL,
  objective TEXT NULL,
  max_pages INT UNSIGNED NOT NULL DEFAULT 25,
  allow_purchases TINYINT(1) NOT NULL DEFAULT 0,
  worker_job_id VARCHAR(120) NULL,
  result_summary MEDIUMTEXT NULL,
  generated_script MEDIUMTEXT NULL,
  generated_video_url VARCHAR(500) NULL,
  artifact_url VARCHAR(500) NULL,
  error_message MEDIUMTEXT NULL,
  started_at DATETIME NULL,
  finished_at DATETIME NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  INDEX idx_crawl_jobs_site_id (site_id),
  INDEX idx_crawl_jobs_status (status),
  CONSTRAINT fk_crawl_jobs_site FOREIGN KEY (site_id) REFERENCES crawl_sites(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;