/** scripts/build-landing.mjs の型定義（tests/landing-i18n.test.ts から参照する） */

export type LandingLanguage = 'ja' | 'en';

export interface LandingLanguageConfig {
  file: string;
  dir: string;
  locale: string;
  alternateLocale: string;
  relativePrefix: string;
  buttonHref: Record<LandingLanguage, string>;
}

export type LandingTranslations = Record<LandingLanguage, Record<string, string>>;

export interface BuildLandingPagesOptions {
  root?: string;
  source?: string;
  version?: string;
}

export interface BuildLandingPagesResult {
  outputs: Record<string, string>;
  missing: Record<LandingLanguage, string[]>;
  version: string;
  translations: LandingTranslations;
}

export const SOURCE_FILE: string;
export const SITE_URL: string;
export const GENERATED_NOTICE: string;
export const LANGUAGES: Record<LandingLanguage, LandingLanguageConfig>;
export function buildLandingPages(options?: BuildLandingPagesOptions): BuildLandingPagesResult;
