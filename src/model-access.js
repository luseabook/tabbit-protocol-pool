function normalizeModelName(value) {
  return String(value || "").replace(/^tabbit\//i, "").trim();
}

function normalizedAccessType(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

export function modelAccessRequiresPremium(value) {
  return Boolean(modelAccessRequiredTier(value));
}

export function modelAccessRequiredTier(value) {
  const accessType = normalizedAccessType(value);
  if (!accessType || accessType === "unknown" || accessType === "priority") return null;
  if (accessType.startsWith("free")) return null;
  if (/(^|_)premium(_|$)/.test(accessType)) return "pro";
  if (/(^|_)(pro|paid|member|plus|subscription)(_|$)/.test(accessType)) return "pro";
  return null;
}

export function modelNameRequiresPremium(value) {
  return Boolean(modelNameRequiredTier(value));
}

export function modelNameRequiredTier(value) {
  const model = normalizeModelName(value).toLowerCase();
  if (!model || model === "priority" || model === "default") return null;
  if (/(^|[^a-z])(opus|premium)([^a-z]|$)/.test(model)) return "pro";
  if (/(^|[^a-z])paid([^a-z]|$)/.test(model)) return "pro";
  return null;
}

export function isUnsupportedModel(value) {
  const model = normalizeModelName(value).toLowerCase().replace(/[\s_]+/g, "-");
  return model === "claude-opus-4.7";
}

export function isDefaultRoutedModel(value) {
  const model = normalizeModelName(value).toLowerCase();
  return !model || model === "priority" || model === "default";
}

export function modelMetadataRequiresPremium(model = {}) {
  return Boolean(modelMetadataRequiredTier(model));
}

export function modelMetadataHasAccessSignal(model = {}) {
  if (!model || typeof model !== "object") return false;
  return [
    model.required_access_tier,
    model.requiredAccessTier,
    model.model_access_type,
    model.modelAccessType,
    model.access,
    model.accessType,
    model.requires_premium,
    model.requiresPremium,
  ].some((value) => value !== undefined && value !== null && value !== "");
}

export function modelMetadataRequiredTier(model = {}) {
  if (!model || typeof model !== "object") return null;
  const explicitTier = normalizedAccessType(firstDefined(model.required_access_tier, model.requiredAccessTier));
  if (explicitTier === "premium") return "pro";
  if (explicitTier === "pro") return "pro";
  const accessTier = modelAccessRequiredTier(firstDefined(
    model.model_access_type,
    model.modelAccessType,
    model.access,
    model.accessType,
  ));
  if (accessTier) return accessTier;
  if (typeof model.requires_premium === "boolean") return model.requires_premium ? "pro" : null;
  if (typeof model.requiresPremium === "boolean") return model.requiresPremium ? "pro" : null;
  return null;
}

function modelAliases(model = {}) {
  return [
    model.id,
    model.selectedModel,
    model.selected_model,
    model.displayName,
    model.display_name,
    model.tabbit_display_name,
    model.model,
    model.name,
    model.value,
  ].map((value) => normalizeModelName(value).toLowerCase()).filter(Boolean);
}

export function isUnsupportedModelMetadata(model = {}) {
  if (!model || typeof model !== "object") return isUnsupportedModel(model);
  return modelAliases(model).some((alias) => isUnsupportedModel(alias));
}

export function findModelMetadata(models = [], requestedModel = "") {
  if (!Array.isArray(models)) return null;
  const requested = normalizeModelName(requestedModel).toLowerCase();
  if (!requested || requested === "priority") return null;
  return models.find((model) => modelAliases(model).includes(requested)) || null;
}
