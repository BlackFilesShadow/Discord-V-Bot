/**
 * Icon-free slug list for App route registration (Stage 56).
 * Keeps lucide-react catalog out of the entry chunk.
 */
export const DEV_TOOL_SLUGS = [
  'bot-status',
  'dashboard-status',
  'database-status',
  'system-health',
  'error-monitoring',
  'live-sync',
  'ai-providers',
  'ai-context-debugger',
  'observability',
  'member-detection',
  'security-status',
  'active-sessions',
  'incident-response',
  'audit-logs',
  'nitrado-status',
  'nitrado-protection',
  'nitrado-mirror',
  'discord-status',
  'backup-status',
  'xml-validator',
  'json-validator',
  'debug-tools',
  'command-diag',
  'adm-analysis',
  'rpt-analysis',
  'killfeed',
  'player-tracking',
  'raid-analysis',
  'base-proximity',
  'movement-heatmap',
  'suspicious',
  'faction-activity',
  'vehicle-tracking',
] as const;

export type DevToolSlug = (typeof DEV_TOOL_SLUGS)[number];
