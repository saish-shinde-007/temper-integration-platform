// Re-export shared types so UI code imports from a single, local module.
export type {
  Integration,
  IntegrationVersion,
  IntegrationState,
  Run,
  RunStatus,
  Trigger,
  CronTrigger,
  WebhookTrigger,
  SftpTrigger,
  CreateIntegrationRequest,
  AgentOutput,
  EgressCall,
} from '@temper/shared';
