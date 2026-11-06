import { z } from 'zod';

export const appidSchema = z.coerce.number().int().positive().max(2147483647);

const languagesSchema = z.array(z.string().min(1).max(32)).min(1).max(30);

const dateRangeSchema = z
  .object({ start: z.number().int().nonnegative().optional(), end: z.number().int().nonnegative().optional() })
  .nullable()
  .optional();

export const scrapeFiltersSchema = z.object({
  languages: languagesSchema.default(['schinese', 'english']),
  reviewType: z.enum(['all', 'positive', 'negative']).default('all'),
  sort: z.enum(['helpful', 'recent', 'updated']).default('helpful'),
  purchaseType: z.enum(['all', 'steam', 'non_steam']).default('all'),
  dateRange: dateRangeSchema.default(null),
  minPlaytimeHours: z.number().nonnegative().optional(),
  maxPlaytimeHours: z.number().nonnegative().optional(),
  excludeOffTopic: z.boolean().default(true),
  useReviewQuality: z.boolean().default(true),
});

export const clientFiltersSchema = z.object({
  minVotes: z.number().int().nonnegative().default(0),
  minLength: z.number().int().nonnegative().default(0),
  includeKeywords: z.array(z.string()).max(50).default([]),
  excludeKeywords: z.array(z.string()).max(50).default([]),
  excludeEarlyAccess: z.boolean().default(false),
  excludeFree: z.boolean().default(false),
});

export const trendSchema = z.object({
  months: z.number().int().min(1).max(36).default(12),
});

export const aiOptionsSchema = z.object({
  baseUrl: z.string().optional(),
  model: z.string().min(1).max(120).default('deepseek-flash'),
  temperature: z.number().min(0).max(2).optional(),
  thinking: z.boolean().default(false),
});

export const jobOptionsSchema = z.object({
  maxReviews: z.number().int().min(1).max(1000).default(200),
  includeTranslations: z.boolean().default(false),
  topReviews: z.number().int().min(1).max(50).default(10),
});

export const jobDataSchema = z.object({
  dataDir: z.string().optional(),
  reuseDataset: z.boolean().default(true),
  reuseReport: z.boolean().default(true),
  forceFetch: z.boolean().default(false),
  forceAnalyze: z.boolean().default(false),
  /** Refresh only the official trend aggregate; reviews may still be reused. */
  forceTrend: z.boolean().default(false),
});

export const createJobSchema = z.object({
  appid: appidSchema,
  filters: scrapeFiltersSchema.default({}),
  clientFilters: clientFiltersSchema.default({}),
  trend: trendSchema.default({}),
  ai: aiOptionsSchema.default({}),
  options: jobOptionsSchema.default({}),
  data: jobDataSchema.default({}),
});

export const previewSchema = z.object({
  appid: appidSchema,
  filters: scrapeFiltersSchema.default({}),
  clientFilters: clientFiltersSchema.default({}),
  trend: trendSchema.default({}),
  ai: aiOptionsSchema.default({}),
  options: jobOptionsSchema.default({}),
  dataDir: z.string().optional(),
});

export const resolveSchema = z.object({
  url: z.string().min(1).max(2048),
});

export const aiTestSchema = z.object({
  baseUrl: z.string().optional(),
  model: z.string().min(1).max(120).optional(),
});

export const dataValidateSchema = z.object({
  dataDir: z.string().min(1),
});

export const dataClearSchema = z.object({
  dataDir: z.string().optional(),
  confirm: z.literal(true),
});

export const cacheClearSchema = z.object({
  appid: appidSchema.optional(),
});
