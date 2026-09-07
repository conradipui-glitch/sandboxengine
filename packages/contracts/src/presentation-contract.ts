import type {
  PresentationPlanV2,
  PresentationReferenceCatalogV2,
  SceneFrameV2
} from "./presentation-v2.js";
import { presentationPlanConvergesToTargetFrameV2 } from "./presentation-convergence.js";
import { hasValidPresentationPlanV2References } from "./presentation-validation.js";

/**
 * Full B07-01 transition gate: exact JSON shape is checked by canonical schema
 * at the transport boundary; this pure semantic gate proves membership,
 * one-turn identity and deterministic convergence to the declared target frame.
 */
export function hasValidPresentationTransitionV2(
  fromFrame: SceneFrameV2,
  targetFrame: SceneFrameV2,
  plan: PresentationPlanV2,
  catalog: PresentationReferenceCatalogV2
): boolean {
  return hasValidPresentationPlanV2References(fromFrame, targetFrame, plan, catalog)
    && presentationPlanConvergesToTargetFrameV2(fromFrame, targetFrame, plan);
}
