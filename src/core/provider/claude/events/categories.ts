import type { CredentialKind, ErrorCategory } from '../../../../shared';

/** Maps the error strings Claude Code puts on assistant events and api_retry events. */
export function categoryFromErrorString(error: string | null | undefined): ErrorCategory {
  switch (error) {
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
      return 'authentication';
    case 'billing_error':
    case 'account_on_hold':
      return 'billing';
    case 'rate_limit':
      return 'rate-limit';
    case 'overloaded':
    case 'server_error':
      return 'overloaded';
    case 'invalid_request':
    case 'max_output_tokens':
      return 'invalid-request';
    case 'model_not_found':
      return 'model-not-found';
    default:
      return 'unknown';
  }
}

/** Maps an HTTP status carried on a result event. */
export function categoryFromApiStatus(
  status: number | null | undefined,
): ErrorCategory | undefined {
  if (status === undefined || status === null) return undefined;
  if (status === 401 || status === 403) return 'authentication';
  if (status === 402) return 'billing';
  if (status === 404) return 'model-not-found';
  if (status === 429) return 'rate-limit';
  if (status >= 500 && status <= 599) return 'overloaded';
  if (status === 400) return 'invalid-request';
  return undefined;
}

export function credentialFromApiKeySource(source: string | undefined): CredentialKind {
  if (source === 'none') return 'subscription';
  if (source !== undefined && /api_?key/i.test(source)) return 'api-key';
  return 'unknown';
}
