/** scripts/build-landing.mjs の型定義（tests/landing-i18n.test.ts から参照する） */

export type LandingLanguage = 'ja' | 'en';

export interface LandingLanguageConfig {
  dir: string;
  locale: string;
  alternateLocale: string;
}

export interface LandingPage {
  source: string;
  path: string;
}

export type LandingTranslations = Record<LandingLanguage, Record<string, string>>;

export interface BuildLandingPagesOptions {
  root?: string;
  source?: string;
  sources?: Record<string, string>;
  version?: string;
}

export interface BuildLandingPagesResult {
  outputs: Record<string, string>;
  missing: Record<LandingLanguage, string[]>;
  version: string;
  translations: LandingTranslations;
  pageTranslations: Record<string, LandingTranslations>;
}

export const SOURCE_FILE: string;
export const SITE_URL: string;
export const GENERATED_NOTICE: string;
export const PAGES: LandingPage[];
export const LANGUAGES: Record<LandingLanguage, LandingLanguageConfig>;
export function outputFile(page: LandingPage, language: LandingLanguage): string;
export function pageUrl(page: LandingPage, language: LandingLanguage): string;
export function languageButtonHref(page: LandingPage, from: LandingLanguage, to: LandingLanguage): string;
export function generatedNotice(source: string): string;
export function rewriteRelativeUrl(url: string, page: LandingPage, language: LandingLanguage): string;
export function buildLandingPages(options?: BuildLandingPagesOptions): BuildLandingPagesResult;
