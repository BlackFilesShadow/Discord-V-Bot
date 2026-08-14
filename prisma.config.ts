import { defineConfig } from '@prisma/config';

/**
 * Prisma 7 Konfiguration.
 *
 * Hintergrund: Ab Prisma 7 ist `datasource.url` im Schema NICHT mehr erlaubt.
 * Migrate-CLI (prisma migrate, prisma db push) liest die Verbindung aus dieser
 * Config; der `PrismaClient`-Konstruktor in src/database/prisma.ts setzt die
 * getunten Pool-Parameter weiterhin selbst per Driver Adapter.
 *
 * Achtung: `env('DATABASE_URL')` aus '@prisma/config' ist EAGER — d.h. jede
 * CLI-Aktion (auch `prisma --version`, `prisma generate`) wuerde fehlschlagen,
 * wenn DATABASE_URL nicht gesetzt ist. Wir nutzen daher `process.env` direkt
 * mit Stub-Fallback, damit Build/CI-Schritte ohne DB-Verbindung gruen sind.
 *
 * Multi-File-Schema: Prisma 7 kann `schema` auf einen Ordner zeigen lassen und
 * laedt dort alle *.prisma-Dateien rekursiv. `schema.prisma` und `migrations/`
 * bleiben gemeinsam direkt unter ./prisma; kleine additive Domänenmodelle
 * koennen dadurch ohne riskanten Komplett-Rewrite der grossen Hauptdatei
 * gepflegt werden.
 *
 * Source: https://pris.ly/d/config-datasource
 */
export default defineConfig({
  schema: './prisma',
  datasource: {
    url: process.env.DATABASE_URL
      ?? 'postgresql://placeholder:placeholder@localhost:5432/placeholder',
  },
  migrations: {
    path: './prisma/migrations',
  },
});
