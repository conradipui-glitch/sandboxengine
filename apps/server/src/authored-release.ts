import {
  isControlReleaseRecord,
  type ControlReleaseRecord
} from "@living-history/control";
import type { PluginRegistrySnapshot } from "@living-history/plugins";
import { preflightStoredControlRelease } from "./release-authority.js";
import {
  AUTHORED_SCENARIO_SIDECAR_KIND,
  bindAuthoredScenarioSidecar,
  type AuthoredScenarioSidecarData
} from "./authored-scenario.js";

export type AuthoredReleaseResolution =
  | {
      readonly ok: true;
      readonly release: ControlReleaseRecord;
      readonly scenario: AuthoredScenarioSidecarData;
    }
  | {
      readonly ok: false;
      readonly code:
        | "INVALID_RELEASE"
        | "AUTHORED_SCENARIO_MISSING"
        | "AUTHORED_SCENARIO_DUPLICATE"
        | "AUTHORED_SCENARIO_INVALID"
        | "RELEASE_PREFLIGHT_FAILED";
      readonly detailCode?: string;
    };

/**
 * B11 adapter over the existing immutable release envelope.
 *
 * `preflightStoredControlRelease` remains authoritative for the compiled
 * artifact and installed plugin sidecars. The generic authored-scenario
 * sidecar is removed only for that existing plugin-specific preflight, then is
 * independently rebound to the exact compiledContentHash + questId.
 */
export function resolveAuthoredScenarioRelease(
  value: unknown,
  pluginRegistry: PluginRegistrySnapshot
): AuthoredReleaseResolution {
  if (!isControlReleaseRecord(value)) return failure("INVALID_RELEASE");

  const authored = value.authoredPluginSidecars.filter(
    (sidecar) => sidecar.kind === AUTHORED_SCENARIO_SIDECAR_KIND
  );
  if (authored.length === 0) return failure("AUTHORED_SCENARIO_MISSING");
  if (authored.length !== 1) return failure("AUTHORED_SCENARIO_DUPLICATE");

  const pluginOnlyRelease: ControlReleaseRecord = Object.freeze({
    ...value,
    authoredPluginSidecars: Object.freeze(
      value.authoredPluginSidecars.filter((sidecar) => sidecar.kind !== AUTHORED_SCENARIO_SIDECAR_KIND)
    )
  });
  const releasePreflight = preflightStoredControlRelease(pluginOnlyRelease, pluginRegistry);
  if (!releasePreflight.ok) {
    return Object.freeze({
      ok: false,
      code: "RELEASE_PREFLIGHT_FAILED",
      detailCode: releasePreflight.code
    });
  }

  const scenario = bindAuthoredScenarioSidecar(
    authored[0],
    value.compiledContentHash,
    value.questId
  );
  if (scenario === null) return failure("AUTHORED_SCENARIO_INVALID");

  return Object.freeze({
    ok: true,
    release: value,
    scenario
  });
}

function failure(code: Exclude<AuthoredReleaseResolution, { readonly ok: true }>["code"]): AuthoredReleaseResolution {
  return Object.freeze({ ok: false, code });
}
