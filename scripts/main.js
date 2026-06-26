(() => {
  const MODULE_ID = "hotbar-autohide";
  const SETTING_HIDE_MUTE = "hideMuteButton";
  const SETTING_PIN_IN_MUTE_SLOT = "pinInMuteSlot";
  const SETTING_DOCK_AT_BOTTOM = "dockAtBottom";

  const qs = (s, r=document) => r.querySelector(s);
  const qsa = (s, r=document) => Array.from(r.querySelectorAll(s));
  const localize = (key) => game.i18n.localize(`${MODULE_ID}.${key}`);

  const MUTE_BUTTON_SELECTOR = [
    '[data-action="muteSounds"]',
    'button[aria-label*="Mute"]',
    'button[aria-label*="Wycisz"]',
    'button[title*="Mute"]',
    'button[title*="Wycisz"]',
    'button[data-tooltip*="Mute"]',
    'button[data-tooltip*="Wycisz"]'
  ].join(',');

  let hideTimer = null;
  let slideAnimation = null;
  let settingsRefreshQueued = false;
  let settingsObserver = null;

  Hooks.once("init", () => {
    game.settings.register(MODULE_ID, "autoHide", {
      name: localize("settings.autoHide.name"),
      scope: "client",
      config: true,
      type: Boolean,
      default: true,
      onChange: async (value) => {
        if(!value){
          clearHideTimer();
          if(isPinned()) await setPinned(false);
          await forcePinInMuteSlotOffIfUnavailable();
        }
        applyState();
        queueSettingsConfigRefresh(document);
      }
    });

    game.settings.register(MODULE_ID, "lip", {
      name: localize("settings.lip.name"),
      hint: localize("settings.lip.hint"),
      scope: "world",
      config: true,
      type: Number,
      default: 12,
      range: { min: 0, max: 40, step: 1 },
      onChange: (v) => setLip(v)
    });

    game.settings.register(MODULE_ID, "hideDelay", {
      name: localize("settings.hideDelay.name"),
      hint: localize("settings.hideDelay.hint"),
      scope: "world",
      config: true,
      type: Number,
      default: 2000,
      range: { min: 0, max: 10000, step: 100 }
    });

    game.settings.register(MODULE_ID, SETTING_DOCK_AT_BOTTOM, {
      name: localize("settings.dockAtBottom.name"),
      hint: localize("settings.dockAtBottom.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: false,
      onChange: () => applyState()
    });

    game.settings.register(MODULE_ID, SETTING_HIDE_MUTE, {
      name: localize("settings.hideMuteButton.name"),
      hint: localize("settings.hideMuteButton.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: false,
      onChange: async (value) => {
        // To jest faktyczna walidacja zależności, niezależna od wyglądu okna ustawień.
        // Jeżeli Wycisz nie jest ukryty albo autoukrywanie jest wyłączone, PIN nie może zastępować Wycisz.
        if(!value) await forcePinInMuteSlotOffIfUnavailable();
        ensurePinButton();
        queueSettingsConfigRefresh(document);
      }
    });

    game.settings.register(MODULE_ID, SETTING_PIN_IN_MUTE_SLOT, {
      name: localize("settings.pinInMuteSlot.name"),
      hint: localize("settings.pinInMuteSlot.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: false,
      onChange: async (value) => {
        if(value && !pinSlotAvailable()) await forcePinInMuteSlotOffIfUnavailable();
        ensurePinButton();
        queueSettingsConfigRefresh(document);
      }
    });

    game.settings.register(MODULE_ID, "pinned", {
      name: localize("settings.pinned.name"),
      scope: "client",
      config: false,
      type: Boolean,
      default: false,
      onChange: () => applyState()
    });

    installSettingsConfigV14Patches();
  });

  Hooks.once("ready", async () => {
    await forcePinInMuteSlotOffIfUnavailable();
    setLip(game.settings.get(MODULE_ID, "lip"));
    rememberFoundryHotbarMargin();
    ensurePinButton();
    bindHotbarEvents();
    applyState();

    Hooks.on("renderHotbar", () => {
      rememberFoundryHotbarMargin();
      ensurePinButton();
      bindHotbarEvents();
      applyState();
    });
  });

  function setLip(px){
    document.documentElement.style.setProperty("--hotbar-autohide-lip", (Number(px)||0) + "px");
  }

  function rememberFoundryHotbarMargin(){
    const hb = qs("#hotbar");
    if(!hb) return;

    // Mierzymy naturalne położenie Foundry tylko wtedy, gdy moduł nie ma jeszcze
    // swoich klas pozycyjnych. Dzięki temu domyślna wysokość hotbara nie zostaje
    // nadpisana wartością 0px z trybu „przy dolnej krawędzi”.
    const moduleOwnsPosition = hb.classList.contains("autohide-collapsed")
      || hb.classList.contains("autohide-pinned")
      || hb.classList.contains("autohide-visible")
      || hb.classList.contains("autohide-parked");

    if(moduleOwnsPosition && document.documentElement.style.getPropertyValue("--hotbar-autohide-foundry-margin-bottom")) return;

    const marginBottom = window.getComputedStyle(hb).marginBottom || "0px";
    document.documentElement.style.setProperty("--hotbar-autohide-foundry-margin-bottom", marginBottom);
  }

  function autoHideEnabled(){ return !!game.settings.get(MODULE_ID, "autoHide"); }
  function isPinned(){ return !!game.settings.get(MODULE_ID, "pinned"); }
  function setPinned(v){ return game.settings.set(MODULE_ID, "pinned", !!v); }
  function hideDelay(){ return Math.max(0, Number(game.settings.get(MODULE_ID, "hideDelay")) || 0); }
  function dockAtBottom(){ return !!game.settings.get(MODULE_ID, SETTING_DOCK_AT_BOTTOM); }
  function hideMuteButton(){ return !!game.settings.get(MODULE_ID, SETTING_HIDE_MUTE); }
  function pinInMuteSlot(){ return pinSlotAvailable() && !!game.settings.get(MODULE_ID, SETTING_PIN_IN_MUTE_SLOT); }
  function shouldAutoCollapse(){ return autoHideEnabled() && !isPinned(); }

  function pinSlotAvailable(){
    return autoHideEnabled() && hideMuteButton();
  }

  async function forcePinInMuteSlotOffIfUnavailable(){
    if(pinSlotAvailable()) return;
    if(!game.settings.get(MODULE_ID, SETTING_PIN_IN_MUTE_SLOT)) return;

    try {
      await game.settings.set(MODULE_ID, SETTING_PIN_IN_MUTE_SLOT, false);
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to automatically disable ${SETTING_PIN_IN_MUTE_SLOT}.`, err);
    }
  }

  function clearHideTimer(){
    if(hideTimer !== null){
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function animateHotbarMarginChange(hb, changeClasses){
    if(!hb){
      changeClasses?.();
      return;
    }

    const before = window.getComputedStyle(hb).marginBottom;

    if(slideAnimation){
      slideAnimation.cancel();
      slideAnimation = null;
    }

    changeClasses?.();

    const after = window.getComputedStyle(hb).marginBottom;
    if(before === after || typeof hb.animate !== "function") return;

    const animation = hb.animate(
      [{ marginBottom: before }, { marginBottom: after }],
      { duration: 160, easing: "ease" }
    );
    slideAnimation = animation;

    const clear = () => {
      if(slideAnimation === animation) slideAnimation = null;
    };
    animation.addEventListener("finish", clear, { once: true });
    animation.addEventListener("cancel", clear, { once: true });
  }

  function bindHotbarEvents(){
    const hb = qs("#hotbar");
    if(!hb || hb.dataset.autohideDelayBound === "1") return;

    hb.dataset.autohideDelayBound = "1";

    hb.addEventListener("mouseenter", showHotbarNow);
    hb.addEventListener("focusin", showHotbarNow);
    hb.addEventListener("mouseleave", () => scheduleHotbarHide({ respectFocus: false }));
    hb.addEventListener("focusout", () => scheduleHotbarHide({ respectFocus: true }));
  }

  function showHotbarNow(){
    const hb = qs("#hotbar");
    if(!hb || !shouldAutoCollapse()) return;

    clearHideTimer();
    // Hotbar przestaje być „zaparkowany”, więc moduł przestaje wymuszać opacity: 0.
    // W stanie rozwiniętym przezroczystość ma znowu kontrolować Foundry V14.
    animateHotbarMarginChange(hb, () => {
      hb.classList.remove("autohide-parked");
      hb.classList.add("autohide-visible");
    });
  }

  function scheduleHotbarHide({ respectFocus = false } = {}){
    const hb = qs("#hotbar");
    if(!hb || !shouldAutoCollapse()) return;

    clearHideTimer();
    hideTimer = window.setTimeout(() => {
      const currentHotbar = qs("#hotbar");
      if(!currentHotbar || !shouldAutoCollapse()) return;

      if(currentHotbar.matches(":hover")) return;
      if(respectFocus && currentHotbar.matches(":focus-within")) return;

      // Dopiero po delayu fizycznie chowamy hotbar i dopiero wtedy ukrywamy jego zawartość.
      // Dzięki temu przezroczystość podczas oczekiwania pozostaje po stronie Foundry.
      animateHotbarMarginChange(currentHotbar, () => {
        currentHotbar.classList.remove("autohide-visible");
        currentHotbar.classList.add("autohide-parked");
      });
      hideTimer = null;
    }, hideDelay());
  }

  function findMuteButtons(root){
    return qsa(MUTE_BUTTON_SELECTOR, root).filter(el => el.id !== "hotbar-pin-toggle");
  }

  function installSettingsConfigV14Patches(){
    // W V14 SettingsConfig jest ApplicationV2/CategoryBrowser. Hook renderu może odpalić się,
    // zanim konkretna kategoria modułu zostanie wstawiona do DOM, więc używamy kilku wejść.
    Hooks.on("renderSettingsConfig", (_app, html) => queueSettingsConfigRefresh(normalizeRoot(html)));

    Hooks.on("renderApplicationV2", (app, html) => {
      if(!isSettingsConfigApp(app, html)) return;
      queueSettingsConfigRefresh(normalizeRoot(html) || app?.element || document);
    });

    document.addEventListener("change", onSettingsConfigDocumentChange, true);
    document.addEventListener("click", onSettingsConfigDocumentClick, true);
    document.addEventListener("submit", onSettingsConfigDocumentSubmit, true);

    Hooks.once("ready", () => {
      if(settingsObserver) return;
      settingsObserver = new MutationObserver((mutations) => {
        for(const mutation of mutations){
          if(mutation.type !== "childList") continue;
          for(const node of mutation.addedNodes){
            if(!(node instanceof HTMLElement)) continue;
            if(node.matches?.("#settings-config, .settings-config, form") || node.querySelector?.(`#settings-config, .settings-config, input[name$=".${SETTING_PIN_IN_MUTE_SLOT}"], input[name$=".autoHide"]`)){
              queueSettingsConfigRefresh(document);
              return;
            }
          }
        }
      });
      settingsObserver.observe(document.body, { childList: true, subtree: true });
    });
  }

  function normalizeRoot(html){
    if(!html) return document;
    if(html instanceof HTMLElement || html instanceof Document || html instanceof DocumentFragment) return html;
    if(html.jquery && html[0]) return html[0];
    if(html[0]?.querySelector) return html[0];
    if(html.element?.querySelector) return html.element;
    return document;
  }

  function isSettingsConfigApp(app, html){
    const root = normalizeRoot(html) || app?.element;
    return app?.constructor?.name === "SettingsConfig"
      || app?.id === "settings-config"
      || root?.id === "settings-config"
      || root?.querySelector?.(`#settings-config, input[name="${MODULE_ID}.${SETTING_PIN_IN_MUTE_SLOT}"]`);
  }

  function queueSettingsConfigRefresh(root=document){
    if(settingsRefreshQueued) return;
    settingsRefreshQueued = true;
    window.requestAnimationFrame(() => {
      settingsRefreshQueued = false;
      updateMuteSlotSettingAvailability(root);
      // Drugi przebieg łapie zawartość kategorii, która w V14 czasem dojeżdża chwilę po ramce renderu.
      window.setTimeout(() => updateMuteSlotSettingAvailability(document), 0);
    });
  }

  function settingInputSelector(key){
    return [
      `input[name="${MODULE_ID}.${key}"]`,
      `input[name$=".${key}"]`,
      `[data-setting-id="${MODULE_ID}.${key}"] input`,
      `[data-setting-key="${MODULE_ID}.${key}"] input`,
      `[data-setting="${MODULE_ID}.${key}"] input`,
      `[data-settings-key="${MODULE_ID}.${key}"] input`
    ].join(",");
  }

  function findSettingInput(root, key){
    const searchRoot = normalizeRoot(root);
    const inputs = qsa(settingInputSelector(key), searchRoot);
    return inputs.find(input => input?.name === `${MODULE_ID}.${key}`)
      || inputs.find(input => input?.name?.endsWith?.(`.${key}`))
      || null;
  }

  function findSettingRow(input, key){
    if(!input) return null;
    return input.closest(`[data-setting-id="${MODULE_ID}.${key}"], [data-setting-key="${MODULE_ID}.${key}"], [data-setting="${MODULE_ID}.${key}"]`)
      || input.closest(".form-group, .form-row, li, fieldset")
      || input.parentElement;
  }

  function updateMuteSlotSettingAvailability(root=document){
    const searchRoot = normalizeRoot(root);
    if(!searchRoot?.querySelector) return;

    const autoHideInput = findSettingInput(searchRoot, "autoHide") || findSettingInput(document, "autoHide");
    const hideInput = findSettingInput(searchRoot, SETTING_HIDE_MUTE) || findSettingInput(document, SETTING_HIDE_MUTE);
    const slotInput = findSettingInput(searchRoot, SETTING_PIN_IN_MUTE_SLOT) || findSettingInput(document, SETTING_PIN_IN_MUTE_SLOT);
    if(!slotInput) return;

    const autoHideOn = autoHideInput ? !!autoHideInput.checked : autoHideEnabled();
    const hideMuteOn = hideInput ? !!hideInput.checked : hideMuteButton();
    const enabled = autoHideOn && hideMuteOn;
    const slotRow = findSettingRow(slotInput, SETTING_PIN_IN_MUTE_SLOT);

    slotInput.disabled = !enabled;
    slotInput.setAttribute("aria-disabled", String(!enabled));
    slotInput.title = "";

    if(!enabled){
      slotInput.checked = false;
      slotInput.dataset.hotbarAutohideForcedOff = "1";
    } else {
      delete slotInput.dataset.hotbarAutohideForcedOff;
    }

    slotRow?.classList.toggle("hotbar-autohide-setting-disabled", !enabled);
    slotRow?.toggleAttribute("aria-disabled", !enabled);
    slotRow?.setAttribute("data-hotbar-autohide-dependent", SETTING_PIN_IN_MUTE_SLOT);
  }

  function isRelevantSettingInput(input, key){
    if(!(input instanceof HTMLInputElement)) return false;
    return input.name === `${MODULE_ID}.${key}` || input.name?.endsWith?.(`.${key}`);
  }

  function onSettingsConfigDocumentChange(event){
    const input = event.target;

    if(isRelevantSettingInput(input, "autoHide")){
      queueSettingsConfigRefresh(document);
      if(!input.checked){
        const slotInput = findSettingInput(document, SETTING_PIN_IN_MUTE_SLOT);
        if(slotInput) slotInput.checked = false;
      }
      return;
    }

    if(isRelevantSettingInput(input, SETTING_HIDE_MUTE)){
      queueSettingsConfigRefresh(document);
      if(!input.checked){
        const slotInput = findSettingInput(document, SETTING_PIN_IN_MUTE_SLOT);
        if(slotInput) slotInput.checked = false;
      }
      return;
    }

    if(isRelevantSettingInput(input, SETTING_PIN_IN_MUTE_SLOT) && !isPinSlotAvailableInOpenSettings()){
      input.checked = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      queueSettingsConfigRefresh(document);
    }
  }

  function onSettingsConfigDocumentClick(event){
    const slotInput = findSettingInput(document, SETTING_PIN_IN_MUTE_SLOT);
    if(!slotInput || !slotInput.disabled) return;

    const row = findSettingRow(slotInput, SETTING_PIN_IN_MUTE_SLOT);
    if(row?.contains(event.target) || event.target === slotInput){
      slotInput.checked = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  function onSettingsConfigDocumentSubmit(_event){
    // Bezpiecznik na zapis: jeżeli w otwartym oknie autoukrywanie albo Wycisz jest odznaczone,
    // to zależna opcja nie może zostać wysłana jako zaznaczona.
    if(isPinSlotAvailableInOpenSettings()) return;
    const slotInput = findSettingInput(document, SETTING_PIN_IN_MUTE_SLOT);
    if(slotInput) slotInput.checked = false;
    void forcePinInMuteSlotOffIfUnavailable();
  }

  function isPinSlotAvailableInOpenSettings(){
    const autoHideInput = findSettingInput(document, "autoHide");
    const hideInput = findSettingInput(document, SETTING_HIDE_MUTE);
    const autoHideOn = autoHideInput ? !!autoHideInput.checked : autoHideEnabled();
    const hideMuteOn = hideInput ? !!hideInput.checked : hideMuteButton();
    return autoHideOn && hideMuteOn;
  }

  function ensurePinButton(){
    const hb = qs("#hotbar");
    if(!hb) return;

    const controls = qs(".bar-controls", hb) || hb;
    const muteButtons = findMuteButtons(hb);
    const primaryMuteButton = muteButtons[0] || null;

    let btn = qs("#hotbar-pin-toggle", hb);
    if(!btn){
      btn = document.createElement("button");
      btn.id = "hotbar-pin-toggle";
      btn.type = "button";
      btn.className = "hotbar-pin-toggle";
      btn.addEventListener("click", () => setPinned(!isPinned()));
    }

    for(const muteButton of muteButtons){
      if(hideMuteButton()) muteButton.style.display = "none";
      else muteButton.style.removeProperty("display");
    }

    if(!autoHideEnabled()){
      btn.remove();
      return;
    }

    const movePinToMuteSlot = pinInMuteSlot() && primaryMuteButton?.parentElement;

    if(movePinToMuteSlot){
      primaryMuteButton.parentElement.insertBefore(btn, primaryMuteButton);
    } else if(btn.parentElement !== controls || controls.lastElementChild !== btn){
      controls.appendChild(btn);
    }

    btn.classList.toggle("hotbar-pin-in-mute-slot", !!movePinToMuteSlot);

    updatePinButton();
  }

  function updatePinButton(){
    const btn = qs("#hotbar-pin-toggle");
    if(!btn) return;
    const pinned = isPinned();
    btn.setAttribute("aria-pressed", String(pinned));
    btn.title = pinned ? localize("pin.unpin") : localize("pin.pin");
    btn.textContent = pinned ? "↓" : "↑";
  }

  function applyState(){
    const hb = qs("#hotbar");
    if(!hb) return;
    const collapsed = shouldAutoCollapse();
    const pinned = autoHideEnabled() && isPinned();

    hb.classList.toggle("autohide-collapsed", collapsed);
    hb.classList.toggle("autohide-pinned", pinned);
    hb.classList.toggle("autohide-bottom-edge", dockAtBottom());

    if(!collapsed){
      clearHideTimer();
      if(slideAnimation){
        slideAnimation.cancel();
        slideAnimation = null;
      }
      hb.classList.remove("autohide-visible", "autohide-parked");
    } else if(hb.matches(":hover") || hb.matches(":focus-within")){
      showHotbarNow();
    } else if(!hb.classList.contains("autohide-visible")){
      // Stan startowy / po renderze: hotbar jest schowany pod ekranem.
      // Opacity wymuszamy tylko w tym zaparkowanym stanie, nie podczas 2s oczekiwania.
      hb.classList.add("autohide-parked");
    }

    ensurePinButton();
  }
})();
