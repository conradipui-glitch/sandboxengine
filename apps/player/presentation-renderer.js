export class BrowserPresentationRenderer {
  #getSession;
  #targetFrame = null;
  #audio = new Map();
  #objectUrls = new Set();

  constructor(getSession) {
    if (typeof getSession !== "function") throw new TypeError("getSession callback required");
    this.#getSession = getSession;
  }

  prepareTargetFrame(frame) {
    this.#targetFrame = frame;
  }

  async applyFrame(frame, signal) {
    throwIfAborted(signal);
    this.#targetFrame = frame;
    const stage = this.#stage();
    const fragment = document.createDocumentFragment();

    const background = document.createElement("div");
    background.className = "presentation-background";
    background.dataset.role = "background";
    if (frame.background) {
      try { background.append(await this.#imageFor(frame.background, "Фон сцены", signal)); }
      catch { background.textContent = "Фон недоступен"; }
    }
    fragment.append(background);

    const layers = document.createElement("div");
    layers.className = "presentation-layers";
    for (const layer of frame.layerOrder) {
      if (layer.kind === "actor") {
        const actor = frame.actors.find((entry) => entry.id === layer.id);
        if (actor) layers.append(await this.#actorElement(actor, signal));
      } else if (layer.kind === "item") {
        const item = frame.items.find((entry) => entry.id === layer.id);
        if (item) layers.append(await this.#itemElement(item, signal));
      } else {
        const overlay = frame.overlays.find((entry) => entry.id === layer.id);
        if (overlay) layers.append(this.#overlayElement(overlay));
      }
    }
    fragment.append(layers);

    const dialogue = document.createElement("div");
    dialogue.className = "presentation-dialogue-history";
    dialogue.dataset.role = "dialogue-history";
    for (const line of frame.dialogue) dialogue.append(this.#dialogueElement(line, line.id === frame.activeDialogueLineId));
    fragment.append(dialogue);

    stage.replaceChildren(fragment);
  }

  /**
   * FIN-05: экраны истории (intro/scene/dialogue/choice/ending) рисуются тем же
   * renderer'ом, что и SceneFrame — общий DOM-слой, без второго параллельного
   * рендерера. Контент экрана приходит из чистой модели story-screens.
   */
  async renderStoryScreens(view, resolveAssetUrl) {
    const stage = this.#stage();
    const wrapper = document.createElement("section");
    wrapper.className = "presentation-story";
    wrapper.dataset.role = "story-screen";
    wrapper.dataset.phase = view.phase;

    const background = document.createElement("div");
    background.className = "presentation-story-background";
    background.dataset.role = "story-background";
    const backgroundRef = view.background;
    if (backgroundRef && typeof resolveAssetUrl === "function") {
      try {
        const url = await resolveAssetUrl(backgroundRef);
        if (typeof url === "string" && url.length > 0) {
          const image = document.createElement("img");
          image.alt = "Фон сцены";
          image.src = url;
          background.append(image);
        } else {
          background.textContent = "Фон недоступен";
        }
      } catch {
        background.textContent = "Фон недоступен";
      }
    }
    wrapper.append(background);

    const title = document.createElement("h2");
    title.className = "presentation-story-title";
    title.textContent = view.title;
    wrapper.append(title);

    if (view.body) {
      const body = document.createElement("p");
      body.className = "presentation-story-body";
      body.textContent = view.body;
      wrapper.append(body);
    }

    if (view.dialogue.length > 0) {
      const history = document.createElement("div");
      history.className = "presentation-dialogue-history";
      history.dataset.role = "story-dialogue";
      for (const line of view.dialogue) history.append(this.#dialogueElement(line, line.id === view.activeDialogueLineId));
      wrapper.append(history);
    }

    if (view.choices.length > 0) {
      const choices = document.createElement("div");
      choices.className = "presentation-story-choices";
      choices.dataset.role = "story-choices";
      for (const choice of view.choices) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "story-choice";
        button.dataset.action = "story-choice";
        button.dataset.choiceId = choice.choiceId;
        button.dataset.target = choice.target;
        button.textContent = choice.label;
        choices.append(button);
      }
      wrapper.append(choices);
    }

    if (view.primary) {
      // Кнопка навигации вступлений/диалога: type=button, never a form submit.
      const primary = document.createElement("button");
      primary.type = "button";
      primary.className = "story-primary";
      primary.dataset.action = "story-primary";
      primary.dataset.intent = view.primary.action;
      primary.textContent = view.primary.label;
      wrapper.append(primary);
    }

    if (view.intro) {
      const progress = document.createElement("p");
      progress.className = "presentation-story-progress";
      progress.dataset.role = "story-progress";
      progress.textContent = `${view.intro.page} / ${view.intro.pageCount}`;
      wrapper.append(progress);
    }

    if (view.actions) {
      const actions = document.createElement("div");
      actions.className = "presentation-story-actions";
      actions.dataset.role = "story-actions";
      if (view.actions.repeat) {
        const repeat = document.createElement("button");
        repeat.type = "button";
        repeat.className = "story-repeat";
        repeat.dataset.action = "story-repeat";
        repeat.textContent = "Повторить";
        actions.append(repeat);
      }
      if (view.actions.exit) {
        const exit = document.createElement("button");
        exit.type = "button";
        exit.className = "story-exit";
        exit.dataset.action = "story-exit";
        exit.textContent = "Выход";
        actions.append(exit);
      }
      wrapper.append(actions);
    }

    stage.replaceChildren(wrapper);
  }

  async setBackground(asset, _transition, durationMs, signal) {
    throwIfAborted(signal);
    const background = this.#required('[data-role="background"]');
    background.replaceChildren();
    if (asset) background.append(await this.#imageFor(asset, "Фон сцены", signal));
    await delay(durationMs, signal);
  }

  async showActor(actorId, slot, _transition, durationMs, signal) {
    throwIfAborted(signal);
    let actor = this.#actor(actorId);
    if (!actor) {
      const target = this.#targetFrame?.actors.find((entry) => entry.id === actorId);
      if (!target) throw new Error("presentation_actor_missing");
      actor = await this.#actorElement(target, signal);
      this.#required(".presentation-layers").append(actor);
    }
    actor.hidden = false;
    actor.dataset.slot = slot;
    await delay(durationMs, signal);
  }

  async hideActor(actorId, _transition, durationMs, signal) {
    throwIfAborted(signal);
    const actor = this.#actor(actorId);
    if (actor) actor.hidden = true;
    await delay(durationMs, signal);
  }

  async moveActor(actorId, slot, _transition, durationMs, signal) {
    throwIfAborted(signal);
    const actor = this.#actor(actorId);
    if (!actor) throw new Error("presentation_actor_missing");
    actor.dataset.slot = slot;
    await delay(durationMs, signal);
  }

  async setActorExpression(actorId, expression, _transition, durationMs, signal) {
    throwIfAborted(signal);
    const actor = this.#actor(actorId);
    if (!actor) throw new Error("presentation_actor_missing");
    actor.dataset.expression = expression;
    const label = actor.querySelector('[data-role="actor-expression"]');
    if (label) label.textContent = expression;
    await delay(durationMs, signal);
  }

  async showItem(asset, slot, _transition, durationMs, signal) {
    throwIfAborted(signal);
    const target = this.#targetFrame?.items.find((entry) => entry.asset.assetId === asset.assetId && entry.asset.hash === asset.hash && entry.slot === slot);
    if (!target) throw new Error("presentation_item_missing");
    this.#required(".presentation-layers").append(await this.#itemElement(target, signal));
    await delay(durationMs, signal);
  }

  async showDialogue(lineId, _reveal, signal) {
    throwIfAborted(signal);
    const line = this.#targetFrame?.dialogue.find((entry) => entry.id === lineId);
    if (!line) throw new Error("presentation_dialogue_missing");
    const history = this.#required('[data-role="dialogue-history"]');
    const existing = history.querySelector(`[data-line-id="${cssEscape(lineId)}"]`);
    if (existing) existing.dataset.active = "true";
    else history.append(this.#dialogueElement(line, true));
  }

  async openOverlay(overlayId, _transition, durationMs, signal) {
    throwIfAborted(signal);
    const overlay = this.#targetFrame?.overlays.find((entry) => entry.id === overlayId);
    if (!overlay) throw new Error("presentation_overlay_missing");
    const layers = this.#required(".presentation-layers");
    const existing = layers.querySelector(`[data-overlay-id="${cssEscape(overlayId)}"]`);
    if (!existing) layers.append(this.#overlayElement(overlay));
    await delay(durationMs, signal);
  }

  async closeOverlay(overlayId, _transition, durationMs, signal) {
    throwIfAborted(signal);
    this.#required(".presentation-layers").querySelector(`[data-overlay-id="${cssEscape(overlayId)}"]`)?.remove();
    await delay(durationMs, signal);
  }

  async playAudio(asset, channel, loop, signal) {
    throwIfAborted(signal);
    await this.stopAudio(channel, signal);
    const url = await this.#assetObjectUrl(asset, signal);
    const audio = new Audio(url);
    audio.loop = loop;
    this.#audio.set(channel, { audio, url });
    try {
      await audio.play();
    } catch (error) {
      this.#audio.delete(channel);
      audio.removeAttribute("src");
      this.#revoke(url);
      throw error;
    }
  }

  async stopAudio(channel, _signal) {
    const current = this.#audio.get(channel);
    if (!current) return;
    current.audio.pause();
    current.audio.removeAttribute("src");
    this.#audio.delete(channel);
    this.#revoke(current.url);
  }

  async wait(durationMs, signal) {
    await delay(durationMs, signal);
  }

  dispose() {
    for (const { audio, url } of this.#audio.values()) {
      audio.pause();
      audio.removeAttribute("src");
      this.#revoke(url);
    }
    this.#audio.clear();
    for (const url of [...this.#objectUrls]) this.#revoke(url);
  }

  #stage() {
    const stage = document.querySelector("#presentation-stage");
    if (!(stage instanceof HTMLElement)) throw new Error("presentation_stage_missing");
    return stage;
  }

  #required(selector) {
    const value = this.#stage().querySelector(selector);
    if (!(value instanceof HTMLElement)) throw new Error("presentation_surface_missing");
    return value;
  }

  #actor(actorId) {
    const value = this.#stage().querySelector(`[data-actor-id="${cssEscape(actorId)}"]`);
    return value instanceof HTMLElement ? value : null;
  }

  async #actorElement(actor, signal) {
    const element = document.createElement("div");
    element.className = "presentation-actor";
    element.dataset.actorId = actor.id;
    element.dataset.slot = actor.slot;
    element.dataset.expression = actor.expression ?? "";
    if (actor.asset) {
      try { element.append(await this.#imageFor(actor.asset, actor.entityId, signal)); }
      catch { /* readable label below is the fallback */ }
    }
    const name = document.createElement("strong");
    name.textContent = actor.entityId;
    element.append(name);
    const expression = document.createElement("small");
    expression.dataset.role = "actor-expression";
    expression.textContent = actor.expression ?? "";
    element.append(expression);
    return element;
  }

  async #itemElement(item, signal) {
    const element = document.createElement("figure");
    element.className = "presentation-item";
    element.dataset.itemId = item.id;
    element.dataset.slot = item.slot;
    try { element.append(await this.#imageFor(item.asset, item.id, signal)); }
    catch {
      const fallback = document.createElement("figcaption");
      fallback.textContent = item.id;
      element.append(fallback);
    }
    return element;
  }

  #overlayElement(overlay) {
    const element = document.createElement("aside");
    element.className = "presentation-overlay";
    element.dataset.overlayId = overlay.id;
    if (overlay.title) {
      const title = document.createElement("strong");
      title.textContent = overlay.title;
      element.append(title);
    }
    if (overlay.body) {
      const body = document.createElement("p");
      body.textContent = overlay.body;
      element.append(body);
    }
    return element;
  }

  #dialogueElement(line, active) {
    const element = document.createElement("p");
    element.className = "presentation-dialogue-line";
    element.dataset.lineId = line.id;
    element.dataset.active = active ? "true" : "false";
    if (line.speakerId) {
      const speaker = document.createElement("strong");
      speaker.textContent = `${line.speakerId}: `;
      element.append(speaker);
    }
    element.append(document.createTextNode(line.text));
    return element;
  }

  async #imageFor(ref, alt, signal) {
    const url = await this.#assetObjectUrl(ref, signal);
    const image = document.createElement("img");
    image.alt = alt;
    image.src = url;
    try {
      await decodeImage(image, signal);
      return image;
    } catch (error) {
      image.removeAttribute("src");
      this.#revoke(url);
      throw error;
    }
  }

  async #assetObjectUrl(ref, signal) {
    const session = this.#getSession();
    if (!session) throw new Error("presentation_session_missing");
    const url = `/v1/sessions/${encodeURIComponent(session.sessionId)}/assets/${encodeURIComponent(ref.assetId)}/${ref.hash}`;
    const response = await fetch(url, { headers: { authorization: `Bearer ${session.credential}` }, signal });
    if (!response.ok) throw new Error(`presentation_media_${response.status}`);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    this.#objectUrls.add(objectUrl);
    return objectUrl;
  }

  #revoke(url) {
    if (!this.#objectUrls.has(url)) return;
    URL.revokeObjectURL(url);
    this.#objectUrls.delete(url);
  }
}

async function decodeImage(image, signal) {
  throwIfAborted(signal);
  if (typeof image.decode === "function") {
    await raceAbort(image.decode(), signal);
    throwIfAborted(signal);
    return;
  }
  await new Promise((resolve, reject) => {
    const load = () => finish();
    const error = () => finish(new Error("presentation_image_decode_failed"));
    const abort = () => finish(new Error("presentation_aborted"));
    image.addEventListener("load", load, { once: true });
    image.addEventListener("error", error, { once: true });
    signal.addEventListener("abort", abort, { once: true });
    function finish(reason) {
      image.removeEventListener("load", load);
      image.removeEventListener("error", error);
      signal.removeEventListener("abort", abort);
      if (reason) reject(reason); else resolve();
    }
  });
}

function raceAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(new Error("presentation_aborted"));
  return new Promise((resolve, reject) => {
    const abort = () => finish(new Error("presentation_aborted"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(null, value),
      (error) => finish(error instanceof Error ? error : new Error("presentation_image_decode_failed"))
    );
    function finish(error, value) {
      signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value);
    }
  });
}

function delay(durationMs, signal) {
  if (durationMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, durationMs);
    const abort = () => done(new Error("presentation_aborted"));
    signal.addEventListener("abort", abort, { once: true });
    function done(error) {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    }
  });
}

function throwIfAborted(signal) {
  if (signal.aborted) throw new Error("presentation_aborted");
}

function cssEscape(value) {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(value);
  return String(value).replaceAll('"', '\\"');
}
