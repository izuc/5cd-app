-- 5cd_single database schema
-- Single-image variant of 5cd.com (uses FLUX.2-klein-4B for generation + editing).
-- No layered/decomposition tables — generations are flat single images.

DROP DATABASE IF EXISTS `5cd_single`;
CREATE DATABASE `5cd_single` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `5cd_single`;

CREATE TABLE `users` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `email` VARCHAR(255) NOT NULL UNIQUE,
  `password_hash` VARCHAR(255) NOT NULL,
  `display_name` VARCHAR(100) NOT NULL DEFAULT '',
  `credits` INT NOT NULL DEFAULT 0,                 -- purchased credits (persist)
  `free_credits` INT NOT NULL DEFAULT 5,            -- today's free allowance (resets daily, no rollover)
  `free_credits_reset` DATE NULL,                   -- date free_credits was last reset
  `plan` ENUM('free','pro') NOT NULL DEFAULT 'free',
  `theme_color` VARCHAR(7) NOT NULL DEFAULT '#059669',
  `token_version` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE `projects` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `user_id` BIGINT NOT NULL,
  `type` ENUM('logo','flyer','banner','social','custom') NOT NULL DEFAULT 'logo',
  `title` VARCHAR(255) NOT NULL DEFAULT 'Untitled Project',
  `status` ENUM('draft','generating','editing','exported','archived') NOT NULL DEFAULT 'draft',
  `config_json` JSON NULL,
  `ai_job_id` VARCHAR(50) NULL,
  `chosen_generation_id` BIGINT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE `generations` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `project_id` BIGINT NOT NULL,
  `parent_generation_id` BIGINT NULL,
  `prompt` TEXT NULL,
  `model` VARCHAR(100) NOT NULL DEFAULT 'flux',
  `kind` ENUM('concept','edit','upload') NOT NULL DEFAULT 'concept',
  `output_image_url` VARCHAR(500) NULL,
  `width` INT NULL,
  `height` INT NULL,
  `is_chosen` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`parent_generation_id`) REFERENCES `generations`(`id`) ON DELETE SET NULL,
  INDEX `idx_project_chosen` (`project_id`, `is_chosen`)
) ENGINE=InnoDB;

-- projects.chosen_generation_id references generations. Added after generations
-- exists (the two tables reference each other). ON DELETE SET NULL so deleting a
-- generation (e.g. on regenerate) clears the chosen pointer instead of dangling.
ALTER TABLE `projects`
  ADD CONSTRAINT `fk_projects_chosen_generation`
  FOREIGN KEY (`chosen_generation_id`) REFERENCES `generations`(`id`) ON DELETE SET NULL;

-- Indexes for the hot dashboard list/poll and credit-history queries.
ALTER TABLE `projects` ADD INDEX `idx_user_status_updated` (`user_id`, `status`, `updated_at`);
ALTER TABLE `credit_transactions` ADD INDEX `idx_user_created` (`user_id`, `created_at`);

CREATE TABLE `exports` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `project_id` BIGINT NOT NULL,
  `generation_id` BIGINT NULL,
  `format` ENUM('png','transparent_png','jpg','pdf') NOT NULL,
  `file_url` VARCHAR(500) NULL,
  `credits_used` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`generation_id`) REFERENCES `generations`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE `credit_transactions` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `user_id` BIGINT NOT NULL,
  `amount` INT NOT NULL,
  `reason` VARCHAR(255) NOT NULL,
  `project_id` BIGINT NULL,
  `external_payment_ref` VARCHAR(255) NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;
