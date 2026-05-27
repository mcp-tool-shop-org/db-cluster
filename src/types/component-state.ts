/**
 * ComponentState — discriminated union for any UI component (CLI prose,
 * dashboard panel, SDK consumer renderer) that needs to distinguish
 * loading vs empty vs error vs redacted vs ready states.
 *
 * Architectural §2d (Wave C1-Amend). Pre-fix the dashboard panels
 * returned `null` on null/undefined data (SURFACE-C-017), made
 * `repairSuggestions` built-but-not-consumed (SURFACE-C-018), and had no
 * uniform shape for the renderer-adapter contract for `_redacted`
 * markers (SURFACE-C-019). This module establishes the contract; the
 * Surface domain (dashboard JSX) consumes it for `OperationsPanel`,
 * `CommandPreviewPanel`, `ClusterTruthInspector` panels and any future
 * component that mounts AI envelopes.
 *
 * The five states form an exhaustive set — any input maps to exactly
 * one:
 *
 *   - `loading` — async fetch in flight (or the renderer hasn't received
 *     data yet). Renderer shows skeleton / spinner / "loading…".
 *   - `empty` — fetch completed, result set was empty. Surface the
 *     {@link EmptyResultMeta.empty_reason} so the user knows whether
 *     widening the query helps.
 *   - `error` — fetch threw / surface returned an
 *     {@link AiErrorEnvelope}. Renderer shows error message +
 *     remediation hint + retry button (if retryable).
 *   - `redacted` — caller is policy-restricted; payload was stripped.
 *     Lists the markers so the user can request the right capability.
 *   - `ready` — success. Renderer shows the payload.
 *
 * Consumers branch with an exhaustive switch:
 *   ```tsx
 *   function renderState<T>(state: ComponentState<T>) {
 *     switch (state.kind) {
 *       case 'loading': return <Skeleton />;
 *       case 'empty':   return <EmptyState reason={state.reason} hint={state.remediationHint} />;
 *       case 'error':   return <ErrorState envelope={state.error} onRetry={state.retryAction} />;
 *       case 'redacted':return <RedactedState markers={state.markers} reason={state.reason} />;
 *       case 'ready':   return <Body data={state.data} />;
 *     }
 *   }
 *   ```
 */

import type { AiErrorEnvelope } from './ai-envelope.js';
import type { RedactedMarker } from './redaction.js';

/**
 * Discriminated union describing the five canonical render states a
 * component can be in.
 *
 * The discriminator is `kind: 'loading' | 'empty' | 'error' | 'redacted' | 'ready'`.
 * Each branch carries exactly the fields its renderer needs — no
 * defensive optional fields, no shared bag of nullable props.
 */
export type ComponentState<T> =
    | {
          kind: 'loading';
          /** Optional label for skeleton screens ("loading mutations…"). */
          label?: string;
      }
    | {
          kind: 'empty';
          /**
           * Why the result set is empty. Distinguishes "no data ever",
           * "data exists but query missed", and "data exists but policy
           * filtered it all out" — three very different user actions.
           * Mirrors {@link EmptyResultMeta.empty_reason}.
           *
           * Wave C1-Amend fix-up (Cluster C — V1-C1-003 + V3-C1-002):
           * the third arm was previously `'all_filtered'` but the
           * kernel-side producer (PolicyEnforcedKernel) emits
           * `'all_filtered_by_policy'`. The drift caused StateBoundary
           * to silently fall through to "No data." losing the
           * policy-filter signal. Both ends now share one value.
           */
          reason: 'no_data' | 'no_match' | 'all_filtered_by_policy';
          /** Actionable next step the renderer surfaces below the empty body. */
          remediationHint: string;
      }
    | {
          kind: 'error';
          /**
           * The error envelope to render. Carries the typed code,
           * message, remediation hint, retryable flag, context dict,
           * and next_valid_actions list.
           */
          error: AiErrorEnvelope;
          /**
           * Closure the renderer invokes when the user clicks the
           * retry button. Omitted when `error.retryable === false`.
           */
          retryAction?: () => void;
      }
    | {
          kind: 'redacted';
          /**
           * The redaction markers attached to the redacted fields.
           * Renderers iterate to surface "Access to N fields denied" +
           * the gated capability names (since KERNEL-C-004 adds a
           * `capability` field to the marker when reason is
           * `capability_denied`).
           */
          markers: RedactedMarker[];
          /**
           * Human-readable reason for the redaction overlay. The dashboard
           * renders this in the redaction badge.
           */
          reason: string;
      }
    | {
          kind: 'ready';
          /** The payload to render. */
          data: T;
      };
