import type { JsonValue } from "@living-history/contracts";
import type {
  ModelProvider,
  ProviderError,
  ProviderUsage
} from "./types.js";

export type NarrativeProfileId = "strict" | "expressive";

export interface FactPacketAction {
  readonly type: string;
  readonly status: "executed" | "partial" | "blocked";
  readonly requestedUnits: number;
  readonly completedUnits: number;
  readonly durationSeconds: number;
  readonly reasonCode: string | null;
}

export interface FactPacketResourceObservation {
  readonly id: string;
  readonly unit: string;
  readonly before: number;
  readonly after: number;
}

export interface FactPacketObservation {
  readonly id: string;
  readonly text: string;
}

export interface FactPacket {
  readonly schemaVersion: "1.0";
  readonly action: FactPacketAction;
  readonly clock: Readonly<{
    beforeElapsedSeconds: number;
    afterElapsedSeconds: number;
  }>;
  readonly resources: readonly FactPacketResourceObservation[];
  readonly allowedSpeakerIds: readonly string[];
  readonly observations: readonly FactPacketObservation[];
}

export interface NarrativeDialogueLine {
  readonly speakerId: string;
  readonly text: string;
}

export interface NarrativeContent {
  readonly summary: string;
  readonly dialogue: readonly NarrativeDialogueLine[];
  readonly observationRefs: readonly string[];
}

export interface NarratorAttemptEvidence {
  readonly attempt: number;
  readonly ok: boolean;
  readonly usage: ProviderUsage;
  readonly modelId: string | null;
  readonly providerRequestId: string | null;
  readonly errorCode: ProviderError["code"] | null;
}

export interface NarrativeEvidence {
  readonly attempts: readonly NarratorAttemptEvidence[];
}

export interface NarrativeResult {
  readonly profile: NarrativeProfileId;
  readonly source: "model" | "template";
  readonly content: NarrativeContent;
  readonly evidence: NarrativeEvidence;
}

export interface NarrateRequest {
  readonly packet: FactPacket;
  readonly profile: NarrativeProfileId;
  readonly deadlineAtMs: number;
  readonly signal?: AbortSignal;
}

export interface Narrator {
  narrate(request: NarrateRequest): Promise<NarrativeResult>;
}

export interface ModelNarratorOptions {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly strictMaxOutputTokens?: number;
  readonly expressiveMaxOutputTokens?: number;
}

const EMPTY_EVIDENCE: NarrativeEvidence = Object.freeze({ attempts: Object.freeze([]) });

export class ModelNarrator implements Narrator {
  readonly #provider: ModelProvider;
  readonly #model: string;
  readonly #strictMaxOutputTokens: number;
  readonly #expressiveMaxOutputTokens: number;

  constructor(options: ModelNarratorOptions) {
    if (typeof options.model !== "string" || options.model.trim().length === 0) {
      throw new TypeError("narrator model must be a non-empty string");
    }
    this.#provider = options.provider;
    this.#model = options.model;
    this.#strictMaxOutputTokens = validateOutputBudget(options.strictMaxOutputTokens ?? 300, "strict");
    this.#expressiveMaxOutputTokens = validateOutputBudget(options.expressiveMaxOutputTokens ?? 600, "expressive");
  }

  async narrate(request: NarrateRequest): Promise<NarrativeResult> {
    validateFactPacket(request.packet);
    const attempts: NarratorAttemptEvidence[] = [];
    const fallback = () => Object.freeze({
      profile: request.profile,
      source: "template" as const,
      content: renderNarrativeFallback(request.packet),
      evidence: freezeEvidence(attempts)
    });

    if (request.signal?.aborted || request.deadlineAtMs <= Date.now()) return fallback();

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (request.signal?.aborted || request.deadlineAtMs <= Date.now()) return fallback();
      const result = await this.#provider.generate({
        model: this.#model,
        messages: buildNarratorMessages(request.packet, request.profile, attempt),
        responseFormat: "json_object",
        maxOutputTokens: request.profile === "strict"
          ? this.#strictMaxOutputTokens
          : this.#expressiveMaxOutputTokens,
        deadlineAtMs: request.deadlineAtMs,
        expectedSchema: NARRATIVE_OUTPUT_SHAPE,
        taskData: Object.freeze({ task: "runtime_narrator", profile: request.profile, attempt }),
        ...(request.signal ? { signal: request.signal } : {})
      });

      attempts.push(Object.freeze({
        attempt,
        ok: result.ok,
        usage: result.usage,
        modelId: result.modelId,
        providerRequestId: result.ok ? result.providerRequestId : result.error.providerRequestId,
        errorCode: result.ok ? null : result.error.code
      }));

      if (!result.ok) {
        if (!result.error.retryable || attempt === 2) return fallback();
        continue;
      }
      if (result.output.format !== "json_object") {
        if (attempt === 2) return fallback();
        continue;
      }
      const content = validateNarrativeProposal(result.output.value, request.packet);
      if (content !== null) {
        return Object.freeze({
          profile: request.profile,
          source: "model",
          content,
          evidence: freezeEvidence(attempts)
        });
      }
      if (attempt === 2) return fallback();
    }
    return fallback();
  }
}

export function validateFactPacket(packet: FactPacket): void {
  if (packet.schemaVersion !== "1.0") throw new TypeError("unsupported FactPacket schemaVersion");
  if (!isRuntimeId(packet.action.type)) throw new TypeError("FactPacket action type is invalid");
  if (!(["executed", "partial", "blocked"] as const).includes(packet.action.status)) {
    throw new TypeError("FactPacket action status is invalid");
  }
  for (const value of [
    packet.action.requestedUnits,
    packet.action.completedUnits,
    packet.action.durationSeconds,
    packet.clock.beforeElapsedSeconds,
    packet.clock.afterElapsedSeconds
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("FactPacket numeric field is invalid");
  }
  if (packet.action.completedUnits > packet.action.requestedUnits) throw new TypeError("FactPacket completion exceeds request");
  if (packet.clock.afterElapsedSeconds < packet.clock.beforeElapsedSeconds) throw new TypeError("FactPacket clock moved backwards");
  if (packet.action.reasonCode !== null && !isRuntimeId(packet.action.reasonCode)) throw new TypeError("FactPacket reasonCode is invalid");

  const speakerIds = new Set<string>();
  for (const id of packet.allowedSpeakerIds) {
    if (!isRuntimeId(id) || speakerIds.has(id)) throw new TypeError("FactPacket speaker allowlist is invalid");
    speakerIds.add(id);
  }

  const resourceIds = new Set<string>();
  if (packet.resources.length > 100) throw new TypeError("FactPacket resources exceed bound");
  for (const resource of packet.resources) {
    if (!isRuntimeId(resource.id) || resourceIds.has(resource.id) || !isBoundedText(resource.unit, 1, 100)) {
      throw new TypeError("FactPacket resource observation is invalid");
    }
    if (![resource.before, resource.after].every((value) => Number.isSafeInteger(value))) {
      throw new TypeError("FactPacket resource values are invalid");
    }
    resourceIds.add(resource.id);
  }

  const observationIds = new Set<string>();
  if (packet.observations.length > 100) throw new TypeError("FactPacket observations exceed bound");
  for (const observation of packet.observations) {
    if (!isRuntimeId(observation.id) || observationIds.has(observation.id) || !isBoundedText(observation.text, 1, 1_000)) {
      throw new TypeError("FactPacket observation is invalid");
    }
    observationIds.add(observation.id);
  }
}

export function validateNarrativeProposal(value: unknown, packet: FactPacket): NarrativeContent | null {
  if (!isRecord(value) || !hasExactKeys(value, ["summary", "dialogue", "observationRefs"])) return null;
  if (!isBoundedText(value.summary, 1, 2_000)) return null;
  if (!Array.isArray(value.dialogue) || value.dialogue.length > 20) return null;
  if (!Array.isArray(value.observationRefs) || value.observationRefs.length > 50) return null;

  const allowedSpeakers = new Set(packet.allowedSpeakerIds);
  const dialogue: NarrativeDialogueLine[] = [];
  for (const line of value.dialogue) {
    if (!isRecord(line) || !hasExactKeys(line, ["speakerId", "text"])) return null;
    if (!isRuntimeId(line.speakerId) || !allowedSpeakers.has(line.speakerId) || !isBoundedText(line.text, 1, 1_000)) return null;
    dialogue.push(Object.freeze({ speakerId: line.speakerId, text: line.text }));
  }

  const allowedObservations = new Set(packet.observations.map((observation) => observation.id));
  const refs: string[] = [];
  const seenRefs = new Set<string>();
  for (const ref of value.observationRefs) {
    if (!isRuntimeId(ref) || !allowedObservations.has(ref) || seenRefs.has(ref)) return null;
    seenRefs.add(ref);
    refs.push(ref);
  }

  return Object.freeze({
    summary: value.summary,
    dialogue: Object.freeze(dialogue),
    observationRefs: Object.freeze(refs)
  });
}

export function renderNarrativeFallback(packet: FactPacket): NarrativeContent {
  validateFactPacket(packet);
  const action = packet.action;
  let summary: string;
  if (action.status === "executed") {
    summary = `Действие выполнено: ${action.completedUnits} из ${action.requestedUnits}.`;
  } else if (action.status === "partial") {
    summary = `Действие выполнено частично: ${action.completedUnits} из ${action.requestedUnits}.`;
  } else {
    summary = "Действие не выполнено.";
  }
  if (action.reasonCode) summary += ` Причина: ${action.reasonCode}.`;
  if (action.durationSeconds > 0) summary += ` Прошло ${action.durationSeconds} сек.`;
  return Object.freeze({
    summary,
    dialogue: Object.freeze([]),
    observationRefs: Object.freeze([])
  });
}

export function narrativeContentToJson(content: NarrativeContent): JsonValue {
  return JSON.parse(JSON.stringify(content)) as JsonValue;
}

const NARRATIVE_OUTPUT_SHAPE = Object.freeze({
  fields: Object.freeze(["summary", "dialogue", "observationRefs"]),
  forbiddenAuthorityFields: Object.freeze([
    "statePatch", "effects", "action", "actionStatus", "resourceDelta", "durationSeconds", "assetId", "newFacts"
  ])
});

function buildNarratorMessages(packet: FactPacket, profile: NarrativeProfileId, attempt: number) {
  const style = profile === "strict"
    ? "Use concise factual wording. Do not infer emotions, motives or unlisted facts."
    : "Use vivid but bounded wording. You may vary style only; do not add facts, decisions, mechanics, entities or hidden observations.";
  const repair = attempt === 2
    ? " Previous output was invalid. Return exactly the allowed JSON shape and only allowed IDs."
    : "";
  return Object.freeze([
    Object.freeze({
      role: "system" as const,
      content: `You narrate an already calculated game result. Core data is authoritative. ${style} Never change action numbers/status/reason, never create effects/state patches/new facts, never speak as an unlisted speaker, and never reveal unlisted observations.${repair}`
    }),
    Object.freeze({
      role: "user" as const,
      content: `Narrate only this FactPacket as JSON with summary, dialogue[{speakerId,text}], observationRefs[]. FactPacket:\n${JSON.stringify(packet)}`
    })
  ]);
}

function validateOutputBudget(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 32 || value > 4_096) throw new RangeError(`${label} narrator output budget outside bounds`);
  return value;
}

function freezeEvidence(attempts: readonly NarratorAttemptEvidence[]): NarrativeEvidence {
  return Object.freeze({ attempts: Object.freeze([...attempts]) });
}

function isBoundedText(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function isRuntimeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
