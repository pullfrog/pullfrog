/**
 * Internal entrypoint for the root app.
 * Re-exports shared types, values, and utilities needed by the Next.js app.
 */

export { CLI_CONTRACT_HEADER, CLI_CONTRACT_VERSION, CLI_UPGRADE_MESSAGE } from "../cliContract.ts";
export type { ConfigField, ConfigScope, ConfigValue } from "../configuration.ts";
export {
  configEntrySchema,
  configFields,
  configResponseSchema,
  configValueSchema,
} from "../configuration.ts";
export type {
  AuthorPermission,
  AutoTier,
  EffortPosition,
  ModelAlias,
  ModelProvider,
  Payload,
  PayloadEvent,
  PayloadRouting,
  ProviderConfig,
  PushPermission,
  RouterSource,
  RouterTier,
  ShellPermission,
  ToolPermission,
  WriteablePayload,
  XrepoConfig,
} from "../external.ts";
export {
  AUTO_EFFICIENT,
  AUTO_INTELLIGENT,
  AUTO_ROUTER,
  autoLadder,
  autoRoutedSlug,
  DEFAULT_EFFORT_POSITION,
  DEFAULT_PROXY_MODEL,
  defaultAutoTier,
  EFFORT_ALIASES,
  getAutoSelectHintModel,
  getModelEffortLevels,
  getModelEnvVars,
  getModelManagedCredentials,
  getModelProvider,
  getProviderDisplayName,
  isAutoRouted,
  isAutoSlug,
  isAutoTier,
  isCardGatedModel,
  isEffortPosition,
  isOssAllowedModel,
  isRouterTier,
  ladderRungs,
  modelAliases,
  modelHasStoredAuth,
  modelIdLabel,
  OSS_MODEL_ALLOWLIST,
  OSS_RECOMMENDED_MODEL,
  offeredRungs,
  ossFundedModelNames,
  PROVIDER_GATEWAY_URL_ENV,
  parseEffortPosition,
  parseModel,
  providers,
  pullfrogMcpName,
  ROUTED_PROVIDERS,
  ROUTER_LADDER,
  ROUTER_TIERS,
  resolveAutoTier,
  resolveCliModel,
  resolveDisplayAlias,
  resolveModelRung,
  resolveModelSlug,
  resolveOpenRouterModel,
  resolvePickModel,
  resolveRoutedModel,
  resolveRung,
  routerProxyOptOut,
  rungLabel,
  rungPosition,
  SUBSIDY_RUNG,
} from "../external.ts";
export type { Mode } from "../modes.ts";
export { modes } from "../modes.ts";
export { type CommercialRefusal, commercialPaywallBody } from "../utils/billingErrors.ts";
export type {
  BuildPullfrogFooterParams,
  WorkflowRunFooterInfo,
} from "../utils/buildPullfrogFooter.ts";
export {
  buildPullfrogFooter,
  PULLFROG_DIVIDER,
  stripExistingFooter,
} from "../utils/buildPullfrogFooter.ts";
export type { CodexAuthBody } from "../utils/codexOAuth.ts";
export {
  decodeJwtExpMs,
  OAuthInvalidGrantError,
  parseCodexAuthBody,
  refreshCodexAuthBody,
  stringifyCodexAuthBody,
} from "../utils/codexOAuth.ts";
export type { CredentialVerdict } from "../utils/credentialCheck.ts";
export { isCredentialProbeable, verifyCredential } from "../utils/credentialCheck.ts";
export type { ResourceUsage, UsageSummary } from "../utils/github.ts";
export { isPullfrog } from "../utils/isPullfrog.ts";
export {
  isLeapingIntoActionCommentBody,
  LEAPING_INTO_ACTION_PREFIX,
} from "../utils/leapingComment.ts";
export { MAX_LEARNINGS_LENGTH, truncateAtLineBoundary } from "../utils/learningsTruncate.ts";
export { countOutstandingPullfrogThreads } from "../utils/outstandingThreads.ts";
export type {
  CreateProgressCommentTarget,
  ProgressComment,
  ProgressCommentType,
} from "../utils/progressComment.ts";
export {
  createLeapingProgressComment,
  deleteProgressCommentApi,
  getProgressComment,
  updateProgressComment,
} from "../utils/progressComment.ts";
export { PROVIDER_DASHBOARDS, type ProviderDashboard } from "../utils/providerDashboards.ts";
export { detectProviderError } from "../utils/providerErrors.ts";
export type {
  RunStatusCheckConclusion,
  RunStatusCheckOctokit,
} from "../utils/runStatusCheck.ts";
export {
  APPROVAL_CHECK_NAME,
  createRunStatusCheck,
  finalizeRunStatusCheck,
  RUN_STATUS_CHECK_NAME,
  runStatusCheckNeedsFinalizing,
} from "../utils/runStatusCheck.ts";
export * from "../utils/subscriptionCredentials.ts";
export {
  probeSubscription,
  SubscriptionCredentialError,
  subscriptionIdentity,
} from "../utils/subscriptionProbe.ts";
export {
  isValidTimeString,
  parseTimeString,
  TIMEOUT_DISABLED,
} from "../utils/time.ts";
export type { XaiAuthBody } from "../utils/xaiOAuth.ts";
export {
  parseXaiAuthBody,
  refreshXaiAuthBody,
  stringifyXaiAuthBody,
} from "../utils/xaiOAuth.ts";
