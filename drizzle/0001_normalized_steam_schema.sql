ALTER TABLE "steam_account_resolution_cache" RENAME TO "steam_account_resolutions";
--> statement-breakpoint
DROP TABLE "steam_account_result_cache";
--> statement-breakpoint
DROP TABLE "steam_app_info_cache";
--> statement-breakpoint
DROP TABLE "steam_owned_games_cache";
--> statement-breakpoint
CREATE TABLE "steam_apps" (
	"appid" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text,
	"is_free_to_play" boolean DEFAULT false NOT NULL,
	"windows_size_bytes" integer,
	"has_size" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "steam_owned_game_syncs" (
	"steam_id" text PRIMARY KEY NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "steam_owned_games" (
	"steam_id" text NOT NULL,
	"appid" integer NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "steam_owned_games_steam_id_appid_pk" PRIMARY KEY("steam_id","appid")
);
