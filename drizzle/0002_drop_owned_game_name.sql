ALTER TABLE "steam_owned_games" DROP COLUMN "name";
--> statement-breakpoint
ALTER TABLE "steam_apps" ALTER COLUMN "name" DROP NOT NULL;
